#!/usr/bin/env node
// W4.3 (docs/development/commercial-completion-plan-2026-11-02.md): command-line client for the public /v1 API.
// NIKUNIKU_API_KEY is an API key from studio.nikuniku.ai; NIKUNIKU_API_BASE defaults to https://api.nikuniku.ai and may
// be plain http only on a loopback host (local development). API errors are printed as the server's own envelope on
// stderr (exit 1); usage and configuration errors use the same envelope shape with exit 2 and send nothing. Requests
// that change state (upload, draft, quote, submit) are never retried; redirects are never followed. `check` exits 3 when
// the server answered but the prompt has errors (passed:false), so scripts can tell a bad prompt from a failed call.
import {readFileSync} from 'node:fs';
import {publishDownload} from './publish-download.mjs';
import {createHash} from 'node:crypto';
import {COMMANDS as DIRECTOR,runDirector} from '../director/cli.mjs';
import {MV_USAGE,mvPrecheck} from '../director/mv.mjs';
import {Refusal,ApiError,apiBase,apiKey,validId,call,paths,uploadPng,uploadAudio,pickMode} from '../client/nikuniku-api.mjs';

const USAGE=`nikuniku <command> [options]
  nikuniku pricing
  nikuniku generate [--workspace <id>] --prompt <prompt.txt|-> [--image <ref.png> ...] [--audio <song.wav|.mp3>] [--continue-from <job_id>]
                    [--project <id>] [--max-credits <n>] [--wait [--out <file>]]
      one step: upload, check (exit 3 if it fails), draft, quote, refuse above --max-credits (exit 4), submit;
      defaults come from /v1/capabilities (h3 image_to_video 5083 ms when the table is not available); override with
      --release <alias> --mode <mode> --duration-ms <ms> --price-version <v>; --workspace defaults to the key's own (GET /v1/me);
      --image may repeat (several identity images), --audio adds a song, --continue-from continues a delivered job: the
      release and mode are then the sold ones that take them (exit 2 naming what is missing when none does)
  nikuniku upload --workspace <id> --file <image.png> --rights <rights_ref>
  nikuniku draft --workspace <id> --file <draft.json|->   (the draft object, or the {workspace_id, draft_json} body)
  nikuniku compose --workspace <id> --file <description.txt|-> --key <idempotency_key>
  nikuniku check --workspace <id> --file <prompt.txt|-> [--mode image_to_video]   (exit 3 when the prompt has errors)
  nikuniku quote --workspace <id> --project <id>
  nikuniku submit --workspace <id> --command <command.json|->
  nikuniku status <job_id> --workspace <id>
  nikuniku wait <job_id> --workspace <id> [--timeout <seconds>]
  nikuniku download <job_id> --workspace <id> --out <file>
  nikuniku mv --image <ref.png> [...4] --audio <song> --prompt <txt> [--max-credits <n>]   (nikuniku mv --help)
  director kit (docs/director/SPEC.md): source, breakdown, plan, lint, whitebox, shoot, assemble, run
Environment: NIKUNIKU_API_KEY (required except pricing), NIKUNIKU_API_BASE (default https://api.nikuniku.ai)`;
const TERMINAL=new Set(['succeeded','failed','cancelled']);
function options(rest){
 const out={positional:[]};
 for(let i=0;i<rest.length;i++){const a=rest[i];
  if(a==='--wait'){out.wait=true;continue;}
  if(a==='--image'){const v=rest[i+1];if(v===undefined)throw new Refusal('USAGE','--image needs a value');(out.images??=[]).push(v);out.image=v;i++;continue;}
  if(a.startsWith('--')){const v=rest[i+1];if(v===undefined)throw new Refusal('USAGE',`${a} needs a value`);out[a.slice(2)]=v;i++;}
  else out.positional.push(a);}
 return out;
}
const need=(o,name)=>{const v=o[name];if(typeof v!=='string'||!v)throw new Refusal('USAGE',`--${name} is required`);return v;};
function readText(path){return readFileSync(path==='-'?0:path,'utf8');}
function readInput(path){
 const text=readFileSync(path==='-'?0:path,'utf8');
 try{return JSON.parse(text);}catch{throw new Refusal('USAGE',`${path==='-'?'stdin':path} is not JSON`);}
}

const key=()=>apiKey(process.env.NIKUNIKU_API_KEY);
const id=validId;
const request=(api,method,path,{body,auth=true}={})=>call(api,method,path,{body,key:auth?key():undefined});

async function download(api,job,ws,out){
 const link=(await request(api,'GET',paths.output(job,ws))).data;
 let url;try{url=new URL(link.url);}catch{throw new Refusal('INVALID_RESPONSE','output link is not a URL',1);}
 // Signed links point at our storage over https; a loopback API may hand out loopback links during local development.
 if(!(url.protocol==='https:'||api.loopback&&url.protocol==='http:'&&url.hostname===new URL(api.origin).hostname))throw new Refusal('INVALID_RESPONSE','output link is not https',1);
 let response;try{response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(300000)});}catch{throw new Refusal('NETWORK_ERROR','the output could not be fetched',1);}
 if(response.status!==200)throw new Refusal('DOWNLOAD_FAILED',`output fetch answered HTTP ${response.status}`,1);
 const bytes=Buffer.from(await response.arrayBuffer()),digest=createHash('sha256').update(bytes).digest('hex');
 if(digest!==link.sha256)throw new Refusal('SHA256_MISMATCH','downloaded bytes do not match the output sha256; nothing was written',1);
 try{publishDownload(bytes,out);}catch(error){
  if(error.message==='DESTINATION_EXISTS')throw new Refusal('DESTINATION_EXISTS','output already exists; choose a new file path',1);
  throw new Refusal('DOWNLOAD_WRITE_FAILED','output could not be published; inspect the original destination before retrying',1);
 }
 return {ok:true,data:null,output_id:link.output_id,sha256:digest,bytes:bytes.length,file:out};
}

// Creator feedback PR #7 P0-3: a creator should not hand-write the double-encoded draft. `generate` composes the existing
// routes in order and stops before anything is charged when the prompt check fails or the quote is above --max-credits.
// Each step is idempotent: the project id and every idempotency key derive from the inputs, so running it again after a
// network failure resumes instead of creating a second job.
const H3_DEFAULTS={release:'h3',mode:'image_to_video',duration_ms:5083};
// Bound waiting controls before any HTTP/admission. Node timers above 2^31-1 ms wrap to 1 ms.
function waitControls(o){
 const raw=o.timeout??'1800',seconds=Number(raw),poll=Number(process.env.NIKUNIKU_POLL_MS??'5000');
 if(typeof raw!=='string'||raw.trim()===''||!Number.isFinite(seconds)||seconds<0||seconds>2147483.647)throw new Refusal('USAGE','--timeout must be finite seconds from 0 to 2147483.647');
 if(!Number.isFinite(poll)||poll<1||poll>2147483647)throw new Refusal('USAGE','NIKUNIKU_POLL_MS must be finite milliseconds from 1 to 2147483647');
 return {seconds,poll};
}
async function generate(api,o){
 const waiting=o.wait===undefined?null:waitControls(o);
 const maxCredits=o['max-credits']===undefined?undefined:Number(o['max-credits']);
 if(maxCredits!==undefined&&(!/^[0-9]+$/.test(o['max-credits'])||!Number.isSafeInteger(maxCredits)||maxCredits<0))throw new Refusal('USAGE','--max-credits must be a nonnegative safe whole number');
 const k=key(),prompt=readText(need(o,'prompt')),steps={};
 const req=(method,path,body)=>call(api,method,path,{body,key:k});
 // E1: several identity images, a song and a continuation; the classic one-image call keeps its exact behaviour and ids.
 const images=o.images??[],continueFrom=o['continue-from']===undefined?null:id(o['continue-from'],'--continue-from');
 if(images.length>4)throw new Refusal('USAGE','--image may repeat at most 4 times');
 const e1=images.length>1||o.audio!==undefined||continueFrom!==null;
 // A key belongs to one workspace; when --workspace is absent the key says which (GET /v1/me).
 const ws=o.workspace!==undefined?id(o.workspace,'--workspace'):id((await req('GET','/v1/me')).data.workspace_id,'workspace_id');
 let spec={...H3_DEFAULTS},cap=null;
 try{cap=(await call(api,'GET','/v1/capabilities',{})).data;const r=cap.releases?.[0],m=r?.modes?.[0];if(r&&m&&!e1)spec={release:r.alias,mode:m.mode,duration_ms:m.duration_ms};}catch{}
 if(e1){const picked=pickMode(cap,{images:images.length,audio:o.audio!==undefined,continueFrom});
  if(picked)spec=picked;else if(!(o.release&&o.mode))throw new Refusal('UNSUPPORTED',`no sold release takes ${images.length} image(s)${o.audio!==undefined?', a song':''}${continueFrom?', a continuation':''}; see GET /v1/capabilities`);}
 if(o.release)spec.release=id(o.release,'--release');if(o.mode)spec.mode=id(o.mode,'--mode');
 if(o['duration-ms']!==undefined){const d=Number(o['duration-ms']);if(!Number.isSafeInteger(d)||d<1)throw new Refusal('USAGE','--duration-ms must be a whole number of milliseconds');spec.duration_ms=d;}
 const price=o['price-version']??(await call(api,'GET','/v1/pricing',{})).data.price_version;
 const rights=id(o.rights??'creator-owned','--rights'),assets=[];
 for(const file of images)assets.push((await uploadPng(api,k,ws,new Uint8Array(readFileSync(file)),{rights_ref:rights})).data.asset_id);
 const asset=assets[0]??null;if(asset)steps.asset_id=asset;if(assets.length>1)steps.asset_ids=assets;
 if(!asset&&spec.mode!=='text_to_video')throw new Refusal('USAGE',`--image is required for ${spec.mode}`);
 let audio=null;if(o.audio!==undefined){audio=(await uploadAudio(api,k,ws,new Uint8Array(readFileSync(o.audio)),{rights_ref:rights})).data.audio_id;steps.audio_id=audio;}
 const check=(await req('POST','/v1/prompts/check',{workspace_id:ws,mode:spec.mode,prompt})).data;steps.check=check;
 if(check.passed===false)return {exit:3,result:{ok:false,error:{code:'PROMPT_CHECK_FAILED',message:'the prompt check found errors; nothing was saved or charged'},data:steps}};
 // The classic digest input is unchanged so earlier runs still resume; E1 inputs extend it (same in the Python client).
 const digest=createHash('sha256').update(JSON.stringify(e1?[ws,spec,price,assets,prompt,audio,continueFrom]:[ws,spec,price,asset,prompt])).digest('hex');
 const project=o.project?id(o.project,'--project'):'gen-'+digest.slice(0,24);
 const draft={project:{schema_version:1,workspace_id:ws,project_id:project,project_revision:1,shot_revision:1,capabilities_revision:spec.release,price_version:price,mode:spec.mode,prompt,duration_ms:spec.duration_ms,asset_ids:assets},
  character_source:asset?'upload':'demo',reference_id:asset,scene:o.scene??'As described in the prompt.',confirmed_revision:1,
  ...(audio?{reference_audio_id:audio}:{}),...(continueFrom?{continue_from_job_id:continueFrom}:{})};
 steps.draft=(await req('POST','/v1/drafts',{workspace_id:ws,draft_json:JSON.stringify(draft)})).data;steps.project_id=project;
 const quote=(await req('POST','/v1/quotes',{workspace_id:ws,project_id:project})).data;steps.quote={quote_id:quote.quote_id,max_units:quote.max_units,unit_version:quote.unit_version};
 if(maxCredits!==undefined&&quote.max_units>maxCredits)return {exit:4,result:{ok:false,error:{code:'ABOVE_MAX_CREDITS',message:`the quote is ${quote.max_units} credits, above --max-credits ${o['max-credits']}; nothing was charged`},data:steps}};
 const job=(await req('POST','/v1/jobs',{workspace_id:ws,command:{quote_id:quote.quote_id,acknowledged_input_hash:quote.input_hash,user_acknowledged_max_units:quote.max_units,idempotency_key:'gen-'+quote.input_hash.slice(0,40)}})).data;
 steps.job_id=job.job_id;
 if(o.wait===undefined)return {exit:0,result:{ok:true,data:steps}};
 const {seconds,poll}=waiting;const path=paths.job(job.job_id,ws),deadline=Date.now()+seconds*1000;
 let state;for(;;){state=(await req('GET',path)).data;if(TERMINAL.has(state.state))break;if(Date.now()+poll>deadline)return {exit:1,result:{ok:false,error:{code:'WAIT_TIMEOUT',message:`job is still ${state.state}`},data:steps}};await new Promise(r=>setTimeout(r,poll));}
 steps.state=state.state;
 if(state.state!=='succeeded')return {exit:1,result:{ok:false,error:{code:'JOB_NOT_SUCCEEDED',message:`job ended ${state.state}`},data:steps}};
 if(o.out!==undefined)steps.download=await download(api,job.job_id,ws,o.out);
 return {exit:0,result:{ok:true,data:steps}};
}

async function main(argv){
 const [command,...rest]=argv;
 if(command==='help'||command==='--help'){process.stdout.write(USAGE+'\n');return 0;}
 if(DIRECTOR.has(command))return runDirector(command,rest); // director kit (docs/director/SPEC.md); not part of the core export
 if(command==='mv'&&rest.includes('--help')){process.stdout.write(MV_USAGE+'\n');return 0;} // director kit MV (AC9)
 const o=options(rest),api=apiBase(process.env.NIKUNIKU_API_BASE);
 let result;
 switch(command){
  case 'pricing':result=await request(api,'GET','/v1/pricing',{auth:false});break;
  case 'generate':{const g=await generate(api,o);process.stdout.write(JSON.stringify(g.result)+'\n');return g.exit;}
  case 'mv':{mvPrecheck(o);const g=await generate(api,o);process.stdout.write(JSON.stringify(g.result)+'\n');return g.exit;} // director kit MV (AC9)
  case 'upload':{const ws=id(need(o,'workspace'),'--workspace'),rights=id(need(o,'rights'),'--rights'),bytes=new Uint8Array(readFileSync(need(o,'file'))),k=key();
   result=await uploadPng(api,k,ws,bytes,{rights_ref:rights});break;}
  // PR #7 P0-3: a file holding the API envelope {workspace_id, draft_json} is unwrapped instead of being sent as the draft.
  case 'draft':{const ws=id(need(o,'workspace'),'--workspace'),file=readInput(need(o,'file')),draft=file&&typeof file==='object'&&Object.hasOwn(file,'draft_json')?file.draft_json:file;key();
   result=await request(api,'POST','/v1/drafts',{body:{workspace_id:ws,draft_json:typeof draft==='string'?draft:JSON.stringify(draft)}});break;}
  case 'compose':{const ws=id(need(o,'workspace'),'--workspace'),description=readText(need(o,'file')),k=id(need(o,'key'),'--key');key();
   result=await request(api,'POST','/v1/prompts/draft',{body:{workspace_id:ws,description,idempotency_key:k}});break;}
  case 'check':{const ws=id(need(o,'workspace'),'--workspace'),prompt=readText(need(o,'file'));key();
   result=await request(api,'POST','/v1/prompts/check',{body:{workspace_id:ws,mode:o.mode??'image_to_video',prompt}});break;}
  case 'quote':{const ws=id(need(o,'workspace'),'--workspace'),project=id(need(o,'project'),'--project');key();
   result=await request(api,'POST','/v1/quotes',{body:{workspace_id:ws,project_id:project}});break;}
  case 'submit':{const ws=id(need(o,'workspace'),'--workspace'),cmd=readInput(need(o,'command'));key();
   result=await request(api,'POST','/v1/jobs',{body:{workspace_id:ws,command:cmd}});break;}
  case 'status':case 'wait':case 'download':{
   const job=id(o.positional[0],'job_id'),ws=id(need(o,'workspace'),'--workspace');key();
   const path=paths.job(job,ws);
   if(command==='status'){result=await request(api,'GET',path);break;}
   if(command==='download'){result=await download(api,job,ws,need(o,'out'));break;}
   const {seconds,poll}=waitControls(o),deadline=Date.now()+seconds*1000;
   for(;;){result=await request(api,'GET',path);if(TERMINAL.has(result.data.state))break;
    if(Date.now()+poll>deadline)throw new Refusal('WAIT_TIMEOUT',`job is still ${result.data.state}`,1);
    await new Promise(r=>setTimeout(r,poll));}
   break;}
  default:throw new Refusal('USAGE',command?`unknown command ${command}`:'a command is required');
 }
 process.stdout.write(JSON.stringify(result)+'\n');
 if(command==='check'&&result.data.passed===false)return 3;
 return command==='wait'&&result.data.state!=='succeeded'?1:0;
}

main(process.argv.slice(2)).then(code=>{process.exitCode=code;},error=>{
 if(error instanceof ApiError){process.stderr.write(JSON.stringify(error.body)+'\n');process.exitCode=1;return;}
 const refusal=error instanceof Refusal?error:new Refusal('INTERNAL',error instanceof Error&&error.code==='ENOENT'?'input file not found':'unexpected error',2);
 process.stderr.write(JSON.stringify({ok:false,error:{code:refusal.code,message:refusal.message}})+'\n');process.exitCode=refusal.exit;
});
