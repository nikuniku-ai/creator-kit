#!/usr/bin/env node
// W4.1 (docs/development/commercial-completion-plan-2026-11-02.md): MCP server for the public /v1 API — pricing, wallet,
// reference image upload, draft, quote, submit, job status and the signed output link. Run over stdio with NIKUNIKU_API_KEY (an API key from
// studio.nikuniku.ai) and optionally NIKUNIKU_API_BASE (https; plain http only on loopback). It reuses the CLI's shared
// client (integrations/client/nikuniku-api.mjs): every tool is one request, never retried, redirects never followed. An
// API error comes back unchanged as the tool's structuredContent with isError; a refusal before any request uses the
// same {ok:false,error:{code,message}} shape. (readonly-fixture.mjs is the older local simulation server, not this one.)
import {Server} from '@modelcontextprotocol/server';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {Refusal,ApiError,apiBase,apiKey,validId,call,paths,uploadPng,uploadAudio} from '../client/nikuniku-api.mjs';
import {DIRECTOR_TOOLS,assertNoAdult} from '../director/mcp-tools.mjs'; // director kit (docs/director/SPEC.md §6); not part of the core export

const idSchema={type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$',maxLength:128};
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const read={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true};
const write=idempotent=>({readOnlyHint:false,destructiveHint:false,idempotentHint:idempotent,openWorldHint:true});
const ws=a=>validId(a.workspace_id,'workspace_id');
const TOOLS={
 nikuniku_pricing:{description:'Current public price book (credit_v1: 1 credit = US$0.01). No key needed.',inputSchema:object({}),annotations:read,
  run:api=>call(api,'GET','/v1/pricing')},
 nikuniku_me:{description:'The workspace_id and scopes of the configured API key: call this first instead of asking the user for a workspace id.',inputSchema:object({}),annotations:read,
  run:(api,_a,key,signal)=>call(api,'GET','/v1/me',{key,signal})},
 nikuniku_capabilities:{description:"What each sold release accepts: modes, size, duration, how many reference images, and audio ('external' takes a song from nikuniku_upload_audio; tail_continuation takes continue_from_job_id). Read it before writing a draft. No key needed.",inputSchema:object({}),annotations:read,
  run:api=>call(api,'GET','/v1/capabilities')},
 nikuniku_wallet:{description:'Credit balance of a workspace (available, reserved, consumed). Needs billing:read.',inputSchema:object({workspace_id:idSchema}),annotations:read,
  run:(api,a,key,signal)=>call(api,'GET',paths.wallet(ws(a)),{key,signal})},
 nikuniku_upload_png:{description:'Upload a local PNG (8-bit RGBA, at most 512x512 and 1 MiB) as a reference image; returns its asset_id for draft asset_ids. rights_ref names your right to use the image. The same file uploaded again returns the same asset. Needs asset:upload.',
  inputSchema:object({workspace_id:idSchema,path:{type:'string',minLength:1,maxLength:4096},rights_ref:idSchema}),annotations:write(true),
  run:async(api,a,key,signal)=>{let bytes;try{bytes=new Uint8Array(await readFile(a.path));}catch{throw new Refusal('USAGE','the file could not be read');}
   return uploadPng(api,key,ws(a),bytes,{rights_ref:validId(a.rights_ref,'rights_ref'),signal});}},
 // E1 (issue #22): a song for a mode whose audio is 'external'; the draft names it as reference_audio_id.
 nikuniku_upload_audio:{description:'Upload a local song (WAV or MP3, at most 16 MiB and 10 minutes) for MV-style generation; returns its audio_id and measured duration_ms for the draft field reference_audio_id. The same file uploaded again returns the same audio. Needs asset:upload.',
  inputSchema:object({workspace_id:idSchema,path:{type:'string',minLength:1,maxLength:4096},rights_ref:idSchema}),annotations:write(true),
  run:async(api,a,key,signal)=>{let bytes;try{bytes=new Uint8Array(await readFile(a.path));}catch{throw new Refusal('USAGE','the file could not be read');}
   return uploadAudio(api,key,ws(a),bytes,{rights_ref:validId(a.rights_ref,'rights_ref'),signal});}},
 nikuniku_save_draft:{description:'Save the generation draft of a project; returns the project id and its revision. Optional draft fields: reference_audio_id (a song, for a mode whose audio is external) and continue_from_job_id (a delivered job, for tail_continuation). Needs generation:quote.',
  inputSchema:object({workspace_id:idSchema,draft_json:{type:'string',maxLength:65536}}),annotations:write(false),
  run:(api,a,key,signal)=>call(api,'POST','/v1/drafts',{body:{workspace_id:ws(a),draft_json:a.draft_json},key,signal})},
 nikuniku_draft_prompt:{description:"Write H3's official prompt from a description in any language with nikuniku's drafting model. Charges credits by the model's token usage (usually 1, at most 6, held first and released in full on failure); the same idempotency_key returns the same prompt without a second charge. Needs generation:submit.",
  inputSchema:object({workspace_id:idSchema,description:{type:'string',minLength:1,maxLength:10000},idempotency_key:idSchema}),annotations:write(true),
  run:(api,a,key,signal)=>call(api,'POST','/v1/prompts/draft',{body:{workspace_id:ws(a),description:a.description,idempotency_key:validId(a.idempotency_key,'idempotency_key')},key,signal})},
 nikuniku_check_prompt:{description:"Check a prompt against H3's official format before saving a draft (image_to_video = Ref2VA six sections) and against the inputs the mode really sends; do not submit while passed is false. Free; saves and charges nothing. Needs generation:quote.",
  inputSchema:object({workspace_id:idSchema,mode:{type:'string',maxLength:64},prompt:{type:'string',maxLength:10000}}),annotations:read,
  run:(api,a,key,signal)=>call(api,'POST','/v1/prompts/check',{body:{workspace_id:ws(a),mode:a.mode,prompt:a.prompt},key,signal})},
 nikuniku_quote:{description:'Quote the current draft revision of a project in credits. Charges nothing. Needs generation:quote.',
  inputSchema:object({workspace_id:idSchema,project_id:idSchema}),annotations:write(false),
  run:(api,a,key,signal)=>call(api,'POST','/v1/quotes',{body:{workspace_id:ws(a),project_id:validId(a.project_id,'project_id')},key,signal})},
 nikuniku_submit:{description:'Submit a quoted job. This reserves credits from the wallet; command.idempotency_key makes a replay return the same job. Needs generation:submit.',
  inputSchema:object({workspace_id:idSchema,command:{type:'object'}}),annotations:write(true),
  run:(api,a,key,signal)=>call(api,'POST','/v1/jobs',{body:{workspace_id:ws(a),command:a.command},key,signal})},
 nikuniku_job_status:{description:'Job snapshot: state, outcome, billing summary and output reference. Needs generation:read.',
  inputSchema:object({workspace_id:idSchema,job_id:idSchema}),annotations:read,
  run:(api,a,key,signal)=>call(api,'GET',paths.job(validId(a.job_id,'job_id'),ws(a)),{key,signal})},
 nikuniku_request_status:{description:'Explicitly recover the original admitted job after an unknown submit result using its unchanged idempotency_key. Needs current original actor and generation:read plus generation:submit. One read only; NOT_FOUND remains unresolved and never authorizes a replacement or retry. No automatic submission, cancellation, refund or execution.',
  inputSchema:object({workspace_id:idSchema,idempotency_key:idSchema}),annotations:read,
  run:(api,a,key,signal)=>call(api,'GET',paths.request(validId(a.idempotency_key,'idempotency_key'),ws(a)),{key,signal})},
 nikuniku_job_output:{description:'Short-lived signed https download link (5 minutes) and sha256 of a delivered output. Needs generation:read.',
  inputSchema:object({workspace_id:idSchema,job_id:idSchema}),annotations:read,
  run:(api,a,key,signal)=>call(api,'GET',paths.output(validId(a.job_id,'job_id'),ws(a)),{key,signal})},
};
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
const failure=value=>({...result(value),isError:true});

const allTools=(extra={})=>assertNoAdult({...TOOLS,...DIRECTOR_TOOLS,...extra});
export const toolList=(extra)=>Object.entries(allTools(extra)).map(([name,t])=>({name,description:t.description,inputSchema:t.inputSchema,annotations:t.annotations}));
export function createNikunikuMcpServer({base,key,extraTools}={}){
 const api=apiBase(base),tools=allTools(extraTools); // AC13: refuses to start with an adult tool
 const server=new Server({name:'nikuniku',version:'1.0.0'},{capabilities:{tools:{}}});
 server.setRequestHandler('tools/list',async()=>({tools:toolList(extraTools)}));
 server.setRequestHandler('tools/call',async(request,ctx)=>{
  const name=request.params.name,tool=Object.hasOwn(tools,name)?tools[name]:null,args=request.params.arguments??{};
  try{
   if(!tool)throw new Refusal('USAGE','unknown tool');
   const keys=typeof args==='object'&&!Array.isArray(args)?Object.keys(args):null;
   if(!keys||keys.some(k=>!Object.hasOwn(tool.inputSchema.properties,k))||tool.inputSchema.required.some(k=>!keys.includes(k)))throw new Refusal('USAGE','arguments do not match the tool schema');
   const token=name==='nikuniku_pricing'||tool.local?undefined:apiKey(key);
   const value=await tool.run(api,args,token,ctx?.mcpReq?.signal);
   return value?.ok===false?failure(value):result(value);
  }catch(error){
   if(error instanceof ApiError)return failure(error.body);
   const refusal=error instanceof Refusal?error:new Refusal('INTERNAL','unexpected error');
   return failure({ok:false,error:{code:refusal.code,message:refusal.message}});
  }
 });
 return server;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const {StdioServerTransport}=await import('@modelcontextprotocol/server/stdio');
 await createNikunikuMcpServer({base:process.env.NIKUNIKU_API_BASE,key:process.env.NIKUNIKU_API_KEY}).connect(new StdioServerTransport());
}
