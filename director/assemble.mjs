// S10 (docs/director/SPEC.md §3 S10): cut the adopted takes together and write an EDL and a QaReceipt.
// Only shots the ledger marks adopted are used, and only when the take file's sha256 equals the sha256 the server reported
// for that take. Hard cuts with stream copy (ffmpeg concat demuxer, -c copy): no dissolve, no frame interpolation, no
// re-encode. The receipt proves "this film was cut from these files by this EDL"; it does NOT prove server acceptance
// (the ledger is a local record; SPEC TL;DR 3). `--verify` recomputes every hash it names.
// AC11 (ACCEPT-ae8c4ef FAIL; Studio ruling 2026-11-08): a self-consistent ledger the server never issued cannot be told
// apart offline, so assemble needs a valid key and, before writing anything, asks the server (GET /v1/recipe-runs/{run_id},
// the same call shoot polls) about every adopted take: the run must exist (SERVER_RUN_NOT_FOUND), the server must have
// passed it (SERVER_NOT_PASSED) and its output sha256 must equal the file (SERVER_SHA_MISMATCH). tests/assemble.test.mjs AC11.
// `--verify` is offline and only proves cut integrity: it always reports server_acceptance "unverified" and
// server_accepted false, and the receipt itself (no server signature, CORE-ASKS C7) stays "unverified".
import {createHash} from 'node:crypto';
import {readFileSync,existsSync,mkdirSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {join,dirname,relative,resolve,isAbsolute} from 'node:path';
import {Refusal,ApiError,apiBase,apiKey,validId,call} from '../client/nikuniku-api.mjs';
import {judge} from './shoot.mjs';
import {parse,need} from './cli.mjs';
import {readJson,writeJson,ff,duration} from './breakdown.mjs';
import {validate} from './jsonschema.mjs';
import {semantics} from './semantics.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const fileSha=f=>sha(readFileSync(f));
const schema=n=>JSON.parse(readFileSync(new URL(`../schemas/${n}.schema.json`,import.meta.url),'utf8'));
function checked(name,value){
 const bad=[...validate(schema(name),value),...semantics(name,value)];
 if(bad.length)throw new Refusal('INTERNAL',`refusing to write an invalid ${name}: ${bad[0].path} ${bad[0].message}`,1);
 return value;
}
const rel=(from,to)=>relative(dirname(from),to)||'.';
export const UNVERIFIED={server_acceptance:'unverified',server_accepted:false};
export const NOTICE='NOT_VERIFIED_BY_NIKUNIKU';
export const CHECKED={server_acceptance:'checked_at_assemble',server_accepted:true};

// Ask the server about each adopted take; returns the refusal result for the first problems found, or null.
async function serverCheck(picks,ws,{key,api}){
 const q=encodeURIComponent,notFound=[],notPassed=[],shaDiffers=[];
 for(const p of picks){let judged;
  try{judged=judge((await call(api,'GET',`/v1/recipe-runs/${q(p.take.run_id)}?workspace_id=${q(ws)}`,{key})).data);}
  catch(e){if(e instanceof ApiError&&e.body.error.code==='NOT_FOUND'){notFound.push(`${p.shot.id}: run ${p.take.run_id}`);continue;}throw e;}
  if(judged?.verdict!=='passed')notPassed.push(`${p.shot.id}: run ${p.take.run_id} is ${judged?.verdict??'still pending'}`);
  else if(judged.output_sha256!==p.sha)shaDiffers.push(`${p.shot.id}: the server's sha256 ${judged.output_sha256.slice(0,12)}… is not the file's ${p.sha.slice(0,12)}…`);}
 const fail=(code,list,why)=>({exit:3,result:{ok:false,error:{code,message:`${why}: ${list.join('; ')}; nothing was written`}}});
 if(notFound.length)return fail('SERVER_RUN_NOT_FOUND',notFound,'the server has no such run');
 if(notPassed.length)return fail('SERVER_NOT_PASSED',notPassed,'the server did not pass');
 if(shaDiffers.length)return fail('SERVER_SHA_MISMATCH',shaDiffers,'the server reports another output');
 return null;
}

export async function assemble(o){
 // Key first (AC11): without one nothing is read from the server and nothing is cut. MCP may pass its own key and base.
 const key=apiKey(o.apiKey??process.env.NIKUNIKU_API_KEY),api=o.apiBase??apiBase(process.env.NIKUNIKU_API_BASE);
 const planFile=o.positional[0];if(!planFile)throw new Refusal('USAGE','assemble needs a plan path (or --verify <receipt>)');
 const out=resolve(need(o,'out')),takesDir=need(o,'takes');
 const plan=readJson(planFile,'plan'),planSha=fileSha(planFile),ledger=readJson(need(o,'ledger'),'gacha-ledger');
 if(ledger.plan_sha256!==planSha)throw new Refusal('LEDGER_MISMATCH','the ledger belongs to another plan (plan_sha256 differs)');
 const shots=[...plan.shots].sort((a,b)=>a.order-b.order);
 const picks=shots.map(s=>{const e=ledger.shots.find(x=>x.shot_id===s.id);return {shot:s,entry:e,take:e?.adopted?e.takes.find(t=>t.take===e.adopted.take):null};});
 // The status/verdict conditions are a backstop: readJson's ledger semantics already refuse an adopted take that is not
 // the first passed one (tests/assemble.test.mjs AC11). They only fire if those semantics are weakened.
 const missing=picks.filter(p=>p.entry?.status!=='adopted'||!p.take||p.take.verdict!=='passed').map(p=>p.shot.id);
 if(missing.length)return {exit:3,result:{ok:false,error:{code:'TAKE_NOT_ACCEPTED',message:`no adopted take for ${missing.join(', ')}; nothing was written`}}};
 const bad=[];
 for(const p of picks){p.file=resolve(join(takesDir,p.shot.id+'.mp4'));
  if(!existsSync(p.file)){bad.push(`${p.shot.id}: ${p.file} is missing`);continue;}
  p.sha=fileSha(p.file);if(p.sha!==p.take.output_sha256)bad.push(`${p.shot.id}: file sha256 ${p.sha.slice(0,12)}… is not the server's ${String(p.take.output_sha256).slice(0,12)}…`);}
 if(bad.length)return {exit:3,result:{ok:false,error:{code:'TAKE_FILE_MISMATCH',message:bad.join('; ')+'; nothing was written'}}};
 const refused=await serverCheck(picks,validId(ledger.workspace_id,'workspace_id'),{key,api});if(refused)return refused;

 const dir=dirname(out),edlFile=resolve(o.edl??join(dir,'edl.json')),receiptFile=resolve(o.receipt??join(dir,'qa-receipt.json'));
 let at=0;const entries=[];
 for(const p of picks){const ms=Math.round(await duration(p.file)*1000);
  entries.push({shot_id:p.shot.id,job_id:p.take.job_id,file:rel(edlFile,p.file),sha256:p.sha,in_ms:0,out_ms:ms,record_in_ms:at});at+=ms;}
 const edl=checked('edl',{schema_version:1,plan_sha256:planSha,total_ms:at,entries});
 mkdirSync(dir,{recursive:true});mkdirSync(dirname(edlFile),{recursive:true});mkdirSync(dirname(receiptFile),{recursive:true});
 const list=out+'.concat-'+process.pid+'.txt',tmp=out+'.tmp-'+process.pid+'.mp4';
 // concat demuxer list: absolute paths, single quotes escaped the way the demuxer reads them.
 writeFileSync(list,picks.map(p=>`file '${p.file.replace(/'/g,"'\\''")}'`).join('\n')+'\n');
 try{await ff('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',tmp]);renameSync(tmp,out);}
 finally{for(const f of [list,tmp])try{unlinkSync(f);}catch{}}
 writeJson(edlFile,edl);
 const film=readFileSync(out);
 const receipt=checked('qa-receipt',{schema_version:1,kind:'nikuniku.director.qa_receipt',output_file:rel(receiptFile,out),output_sha256:sha(film),output_bytes:film.length,
  edl_file:rel(receiptFile,edlFile),edl_sha256:fileSha(edlFile),takes:picks.map(p=>({shot_id:p.shot.id,job_id:p.take.job_id,sha256:p.sha,verdict:'passed'})),
  created_at:new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),plan_sha256:planSha,server_acceptance:UNVERIFIED.server_acceptance});
 writeJson(receiptFile,receipt);
 return {result:{ok:true,data:{file:out,edl:edlFile,receipt:receiptFile,output_sha256:receipt.output_sha256,total_ms:at,...CHECKED}}};
}

export function verify(receiptPath,{takes}={}){
 const receipt=readJson(receiptPath,'qa-receipt'),base=dirname(resolve(receiptPath)),at=f=>isAbsolute(f)?f:join(base,f);
 const problems=[];
 const out=at(receipt.output_file);
 if(!existsSync(out))problems.push(`output ${receipt.output_file} is missing`);
 else{const film=readFileSync(out);if(sha(film)!==receipt.output_sha256)problems.push('output sha256 differs');if(film.length!==receipt.output_bytes)problems.push('output size differs');}
 const edlFile=at(receipt.edl_file);let edl=null;
 if(!existsSync(edlFile))problems.push(`EDL ${receipt.edl_file} is missing`);
 else{if(fileSha(edlFile)!==receipt.edl_sha256)problems.push('EDL sha256 differs');
  try{edl=readJson(edlFile,'edl');}catch(e){problems.push(`EDL: ${e.message}`);}}
 if(edl){
  if(edl.plan_sha256!==receipt.plan_sha256)problems.push('EDL and receipt name different plans');
  if(edl.entries.length!==receipt.takes.length)problems.push('EDL and receipt list a different number of takes');
  edl.entries.forEach((e,i)=>{const t=receipt.takes[i];if(!t||t.shot_id!==e.shot_id||t.job_id!==e.job_id||t.sha256!==e.sha256)problems.push(`EDL entry ${i} (${e.shot_id}) differs from the receipt`);});
  if(takes!==undefined)for(const e of edl.entries){const f=join(takes,e.shot_id+'.mp4');
   if(!existsSync(f))problems.push(`take ${f} is missing`);else if(fileSha(f)!==e.sha256)problems.push(`take ${e.shot_id} sha256 differs`);}
 }
 return problems;
}

export async function command(args){
 const o=parse(args);
 if(o.verify!==undefined){
  const problems=verify(o.verify,{takes:o.takes});
  if(problems.length)return {exit:3,result:{ok:false,error:{code:'RECEIPT_MISMATCH',message:problems.join('; ')},data:{problems}}};
  return {result:{ok:true,data:{receipt:o.verify,checked_takes:o.takes!==undefined,...UNVERIFIED}},done:'verify',notice:NOTICE};
 }
 return assemble(o);
}
