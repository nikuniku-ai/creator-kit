// Director kit MCP tools (docs/director/SPEC.md §6), mounted on the existing `nikuniku` MCP server with the same key.
// Each tool returns the same {ok, data | error} envelope the CLI prints. Local tools (validate, lint, whitebox) need no
// key and send nothing. take_submit spends credits: it sends at most ONE new take and returns without waiting;
// take_status never submits. AC13: assertNoAdult() refuses any tool whose name, description or input schema carries an
// adult marker; the general package must not contain adult tools or adult hosts; adult entry points ship as a separate package.
import {readFileSync} from 'node:fs';
import {Refusal,ApiError} from '../client/nikuniku-api.mjs';
import {readJson} from './breakdown.mjs';
import {lint} from './lint.mjs';
import {createHash} from 'node:crypto';

export const ADULT_MARKERS=['adult','nsfw','porn','18+','r18','r-18','hentai','xxx','erotic'];
export function assertNoAdult(tools){
 for(const [name,t] of Object.entries(tools)){
  const text=[name,t.description,JSON.stringify(t.inputSchema)].join('\n').toLowerCase();
  const hit=ADULT_MARKERS.find(m=>text.includes(m));
  if(hit)throw new Error(`ADULT_TOOL_REFUSED: tool ${name} carries "${hit}"; adult tools belong to the separate adult package (C5), never this one`);
 }
 return tools;
}

const SCHEMAS=['source','breakdown','plan','lint-report','gacha-ledger','edl','qa-receipt'];
const path={type:'string',minLength:1,maxLength:4096},id={type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$',maxLength:128};
const paths={type:'array',items:path,maxItems:2};
const object=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
const local={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
// Same envelope as the CLI: refusals become {ok:false,error}; API errors pass the server's own envelope through.
async function envelope(fn){
 try{const r=await fn();return r.result??r;}
 catch(e){if(e instanceof ApiError)return e.body;if(e instanceof Refusal)return {ok:false,error:{code:e.code,message:e.message}};throw e;}
}
const sha=f=>createHash('sha256').update(readFileSync(f)).digest('hex');
async function take(api,a,key,maxNewTakes){
 const {shoot}=await import('./shoot.mjs');
 const o={positional:[a.plan_path],ledger:a.ledger_path,shot:[a.shot_id],source:a.source_paths??[],timeout:'0',apiKey:key,apiBase:api,maxNewTakes,
  ...(a.max_credits!==undefined?{'max-credits':String(a.max_credits)}:{})};
 const r=await shoot(o);
 // A take still being judged is the normal answer of a call that does not wait: report it, do not fail.
 if(r.result?.error?.code==='ACCEPTANCE_TIMEOUT')return {ok:true,data:r.result.data};
 return r.result;
}

export const DIRECTOR_TOOLS={
 nikuniku_director_validate:{local:true,annotations:local,
  description:`Validate a local director JSON file against its schema and the cross-field rules (one of: ${SCHEMAS.join(', ')}). Sends nothing.`,
  inputSchema:object({schema:{enum:SCHEMAS},path},['schema','path']),
  run:async(_api,a)=>envelope(()=>{if(!SCHEMAS.includes(a.schema))throw new Refusal('USAGE','unknown schema');readJson(a.path,a.schema);return {ok:true,data:{path:a.path,schema:a.schema,valid:true}};})},
 nikuniku_director_lint:{local:true,annotations:local,
  description:'Logic self-check of a plan.json (S4): characters, props, timeline, similarity to the source dialogue (pass the source breakdowns), accept blocks. Error codes are stable (L001–L011). Sends nothing.',
  inputSchema:object({path,source_paths:paths},['path']),
  run:async(_api,a)=>envelope(()=>{const plan=readJson(a.path,'plan'),files=a.source_paths??[];
   return {ok:true,data:lint(plan,{sources:files.map(f=>readJson(f,'breakdown')),sourceSha256s:files.map(sha),planSha256:sha(a.path)})};})},
 nikuniku_director_whitebox:{local:true,annotations:{...local,readOnlyHint:false},
  description:'Draw the whitebox SVG of one shot (S6): the scene layout boxes seen through the shot camera. Writes one SVG file; sends nothing.',
  inputSchema:object({plan_path:path,shot_id:id,out_path:path},['plan_path','shot_id','out_path']),
  run:async(_api,a)=>envelope(async()=>(await import('./whitebox.mjs')).command([a.plan_path,'--shot',a.shot_id,'--out',a.out_path]))},
 nikuniku_director_take_submit:{annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
  description:'Shoot ONE take of one shot through the nikuniku recipe API (S9). Spends credits up to max_credits: checks accept, sources and lint, quotes, refuses above max_credits, submits, polls once and returns at once. Call nikuniku_director_take_status until next is not "wait"; adoption is decided only by the server verdict. Needs generation:submit.',
  inputSchema:object({plan_path:path,ledger_path:path,shot_id:id,max_credits:{type:'integer',minimum:0,maximum:10000000},source_paths:paths},['plan_path','ledger_path','shot_id','max_credits']),
  run:(api,a,key)=>envelope(()=>take(api,a,key,1))},
 nikuniku_mv_draft:{annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true},
  description:'MV: upload 1–4 identity images and a song (WAV/MP3), pick the sold mode whose audio is external, check the prompt, save the draft (reference_audio_id) and quote it. Does NOT submit: review the quote, then use nikuniku_submit. Needs asset:upload and generation:quote.',
  inputSchema:object({workspace_id:id,image_paths:{type:'array',items:path,minItems:0,maxItems:4},audio_path:path,prompt:{type:'string',minLength:1,maxLength:10000},rights_ref:id,project_id:id},['workspace_id','image_paths','audio_path','prompt','rights_ref']),
  run:(api,a,key)=>envelope(async()=>(await import('./mv.mjs')).mvDraft(api,a,key))},
 nikuniku_director_take_status:{annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true},
  description:'Read the server verdict of the pending take of one shot, update the local ledger and say what is next: wait, retry or resend (call take_submit), or stop (adopted, or stopped by the rules). Never submits. Needs generation:read.',
  inputSchema:object({plan_path:path,ledger_path:path,shot_id:id,source_paths:paths},['plan_path','ledger_path','shot_id']),
  run:(api,a,key)=>envelope(()=>take(api,a,key,0))},
};
