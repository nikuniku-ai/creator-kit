// W4.1/W4.3 (docs/development/commercial-completion-plan-2026-11-02.md): the one HTTP client the CLI and the MCP server
// share for the public /v1 API. The base must be https (plain http only on a loopback host, for local development); the
// API key is sent as a bearer token; requests are never retried and redirects are never followed. An API error is thrown
// as ApiError carrying the server's own envelope unchanged; anything else is a Refusal with a stable code.
import {createHash} from 'node:crypto';

export class Refusal extends Error{constructor(code,message,exit=2){super(message);this.code=code;this.exit=exit;}}
export class ApiError extends Error{constructor(body){super('API_ERROR');this.body=body;}}

export function apiBase(value){
 let url;try{url=new URL(value||'https://api.nikuniku.ai');}catch{throw new Refusal('INVALID_BASE','NIKUNIKU_API_BASE is not a URL');}
 const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback)||url.username||url.password||url.search||url.hash||(url.pathname!=='/'&&url.pathname!==''))
  throw new Refusal('INVALID_BASE','NIKUNIKU_API_BASE must be https (plain http only on a loopback host)');
 return {origin:url.origin,loopback};
}
export function apiKey(value){if(!value||!/^\S{8,512}$/.test(value))throw new Refusal('API_KEY_REQUIRED','set NIKUNIKU_API_KEY to an API key from studio.nikuniku.ai');return value;}
export const validId=(v,name)=>{if(typeof v!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v))throw new Refusal('USAGE',`${name} is not a valid id`);return v;};

export async function call(api,method,path,{body,raw,key,signal}={}){
 const headers={accept:'application/json'};if(key!==undefined)headers.authorization='Bearer '+key;
 if(body!==undefined)headers['content-type']='application/json';
 if(raw!==undefined)headers['content-type']=raw.type;
 let response;
 try{response=await fetch(api.origin+path,{method,headers,body:raw!==undefined?raw.bytes:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});}
 catch{throw new Refusal('NETWORK_ERROR','the API could not be reached',1);}
 // Recovery responses are untrusted too. Bound decompressed bytes (including chunked bodies),
 // decode strictly, and cancel an unread remainder instead of buffering it through response.json().
 let value,reader,finished=false;
 try{
  reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
  while(true){const part=await reader.read();if(part.done){finished=true;break;}size+=part.value.byteLength;
   if(size>1048576)throw new Error('RESPONSE_TOO_LARGE');text+=decoder.decode(part.value,{stream:true});}
  value=JSON.parse(text+decoder.decode());
 }catch{throw new Refusal('INVALID_RESPONSE',`HTTP ${response.status} without a bounded valid UTF-8 JSON body`,1);}
 finally{if(reader){if(!finished)void reader.cancel().catch(()=>{});reader.releaseLock();}}
 if(response.ok&&value&&value.ok===true)return value;
 if(value&&value.ok===false&&value.error)throw new ApiError(value);
 throw new Refusal('INVALID_RESPONSE',`HTTP ${response.status} with an unexpected body`,1);
}
const q=v=>encodeURIComponent(v);
export const paths={
 request:(key,ws)=>`/v1/requests/${q(key)}?workspace_id=${q(ws)}`,
 job:(job,ws)=>`/v1/jobs/${q(job)}?workspace_id=${q(ws)}`,
 output:(job,ws)=>`/v1/jobs/${q(job)}/output?workspace_id=${q(ws)}`,
 billingChannel:ws=>`/v1/billing/channel?workspace_id=${q(ws)}`,
 wallet:ws=>`/v1/wallet?workspace_id=${q(ws)}`,
 content:(asset,ws)=>`/v1/assets/${q(asset)}/content?workspace_id=${q(ws)}`,
};
const PNG=[137,80,78,71,13,10,26,10];
// Reference images: declare the exact size, then PUT the bytes. The default idempotency key is derived from the bytes, so
// uploading the same file again returns the same asset instead of a second one.
// Production creator run 2026-11-04: ordinary encoders write ancillary chunks (ffmpeg writes pHYs) and the service refused
// such a PNG as INVALID_MEDIA and quarantined it. Ancillary chunks (lowercase first letter) never change the pixels, so the
// client drops them before the size is declared. Anything that is not a well-formed chunk sequence is sent unchanged and
// judged by the server.
export function stripAncillary(bytes){
 if(!(bytes instanceof Uint8Array)||bytes.length<8||!PNG.every((b,i)=>bytes[i]===b))return bytes;
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),keep=[bytes.subarray(0,8)];let at=8;
 while(at+12<=bytes.length){const n=view.getUint32(at);if(at+12+n>bytes.length)return bytes;const first=bytes[at+4];
  if(!(first>=97&&first<=122))keep.push(bytes.subarray(at,at+12+n));at+=12+n;}
 if(at!==bytes.length)return bytes;
 const out=new Uint8Array(keep.reduce((n,b)=>n+b.length,0));let o=0;for(const b of keep){out.set(b,o);o+=b.length;}return out;
}
export async function uploadPng(api,key,ws,input,{rights_ref,idempotency_key,signal}={}){
 const bytes=stripAncillary(input);
 // PR #7 P0-2: say what is wrong before anything is sent (a refused upload quarantines the asset), and how to fix it.
 const fix='convert it first, e.g. ffmpeg -i in.jpg -vf "scale=512:512:force_original_aspect_ratio=decrease" -pix_fmt rgba ref.png';
 if(!(bytes instanceof Uint8Array)||!PNG.every((b,i)=>bytes[i]===b))throw new Refusal('USAGE',`the file must be a PNG (8-bit RGBA, at most 512x512, 1 MiB); ${fix}`);
 if(bytes.length>1048576)throw new Refusal('USAGE',`the file is ${bytes.length} bytes; the limit is 1 MiB; ${fix}`);
 const head=Buffer.from(bytes.subarray(16,29));
 if(bytes.length>=29){const width=head.readUInt32BE(0),height=head.readUInt32BE(4);
  if(width>512||height>512)throw new Refusal('USAGE',`the image is ${width}x${height}; the limit is 512x512; ${fix}`);
  if(head[8]!==8||head[9]!==6||head[12]!==0)throw new Refusal('USAGE',`the PNG must be 8-bit RGBA and non-interlaced (found bit depth ${head[8]}, color type ${head[9]}${head[12]?', interlaced':''}); ${fix}`);}
 const k=idempotency_key??'png-'+createHash('sha256').update(bytes).digest('hex').slice(0,32);
 const declared=await call(api,'POST','/v1/assets',{body:{workspace_id:ws,declaration:{idempotency_key:k,declared_bytes:bytes.length,mime:'image/png',rights_ref}},key,signal});
 if(declared.data.state==='available')return declared;
 return call(api,'PUT',paths.content(declared.data.asset_id,ws),{raw:{bytes,type:'image/png'},key,signal});
}

// E1 (issue #22): a song for MV-style generation. The mime is read from the bytes (RIFF/WAVE or MPEG audio), the size is
// declared exactly, then the bytes are PUT; the default idempotency key derives from the bytes, as for images.
export const AUDIO_MAX_BYTES=16777216;
export function audioMime(bytes){
 const at=(i,s)=>s.split('').every((c,j)=>bytes[i+j]===c.charCodeAt(0));
 if(bytes.length>=12&&at(0,'RIFF')&&at(8,'WAVE'))return 'audio/wav';
 if(bytes.length>=3&&at(0,'ID3')||bytes.length>=2&&bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0)return 'audio/mpeg';
 return null;
}
export async function uploadAudio(api,key,ws,bytes,{rights_ref,idempotency_key,signal}={}){
 const fix='convert it first, e.g. ffmpeg -i in.m4a -ar 44100 -ac 2 song.wav';
 const mime=bytes instanceof Uint8Array?audioMime(bytes):null;
 if(!mime)throw new Refusal('USAGE',`the audio must be WAV or MP3; ${fix}`);
 if(bytes.length>AUDIO_MAX_BYTES)throw new Refusal('USAGE',`the audio is ${bytes.length} bytes; the limit is 16 MiB; trim it or use MP3`);
 const k=idempotency_key??'audio-'+createHash('sha256').update(bytes).digest('hex').slice(0,32);
 const declared=await call(api,'POST','/v1/audio',{body:{workspace_id:ws,declaration:{idempotency_key:k,declared_bytes:bytes.length,mime,rights_ref}},key,signal});
 if(declared.data.state==='available')return declared;
 return call(api,'PUT',`/v1/audio/${encodeURIComponent(declared.data.audio_id)}/content?workspace_id=${encodeURIComponent(ws)}`,{raw:{bytes,type:mime},key,signal});
}
// The sold mode that takes this many reference images, a song (audio 'external') and a continuation (tail_continuation),
// read from GET /v1/capabilities; null when none does.
export function pickMode(table,{images,audio,continueFrom,release,mode,duration_ms}){
 if(!Array.isArray(table?.releases))return null;
 for(const r of table.releases){
  if(!r||typeof r.alias!=='string'||!Array.isArray(r.modes)||(release!==undefined&&r.alias!==release))continue;
  for(const m of r.modes){
   if(!m||typeof m.mode!=='string'||!Number.isSafeInteger(m.duration_ms)||m.duration_ms<1||
     !Number.isSafeInteger(m.references_min)||!Number.isSafeInteger(m.references_max)||m.references_min<0||m.references_max<m.references_min||
     !['silent','native','master','external'].includes(m.audio))continue;
   if((mode===undefined||m.mode===mode)&&(duration_ms===undefined||m.duration_ms===duration_ms)&&
      (m.audio==='external')===Boolean(audio)&&(m.mode==='tail_continuation')===Boolean(continueFrom)&&m.references_min<=images&&images<=m.references_max)
    return {release:r.alias,mode:m.mode,duration_ms:m.duration_ms};
  }
 }
 return null;
}

// A5 (docs/creator/recipe-pipeline/SPEC.md §6): recipes are read from the API, never from a list built into the client.
// A run is quoted first; a quote above the creator's ceiling is refused before /runs is called, and a dry run stops after
// the quote, so neither can charge. The idempotency key derives from (workspace, recipe, inputs) exactly as the Python
// client derives it, so running the same command again resumes the same run.
export const validRecipe=v=>{if(typeof v!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(v))throw new Refusal('USAGE','recipe_id must be lower snake_case');return v;};
export const recipePaths={
 list:()=>'/v1/recipes',
 one:r=>`/v1/recipes/${q(validRecipe(r))}`,
 quotes:r=>`/v1/recipes/${q(validRecipe(r))}/quotes`,
 runs:r=>`/v1/recipes/${q(validRecipe(r))}/runs`,
 run:(id,ws)=>`/v1/recipe-runs/${q(id)}?workspace_id=${q(ws)}`,
};
export const recipeRunKey=(ws,recipe,inputs)=>'rr-'+createHash('sha256').update(JSON.stringify([ws,recipe,Object.fromEntries(Object.entries(inputs).sort(([a],[b])=>a<b?-1:a>b?1:0))])).digest('hex').slice(0,32);
export async function runRecipe(api,key,{workspace,recipe,inputs,maxCredits,dryRun=false,idempotencyKey,signal}){
 validRecipe(recipe);validId(workspace,'workspace_id');
 if(!inputs||typeof inputs!=='object'||Array.isArray(inputs))throw new Refusal('USAGE','inputs must be an object of name: value');
 if(maxCredits===undefined&&!dryRun)throw new Refusal('USAGE','a run needs a credit ceiling (max credits); use a dry run to see the quote first');
 if(maxCredits!==undefined&&(!Number.isSafeInteger(maxCredits)||maxCredits<0))throw new Refusal('USAGE','max credits must be a nonnegative safe whole number');
 const quote=(await call(api,'POST',recipePaths.quotes(recipe),{body:{workspace_id:workspace,inputs},key,signal})).data;
 if(!Number.isSafeInteger(quote?.max_units)||quote.max_units<0)throw new Refusal('INVALID_RESPONSE','the recipe quote has no max_units',1);
 if(maxCredits!==undefined&&quote.max_units>maxCredits)
  throw new ApiError({ok:false,error:{code:'ABOVE_MAX_CREDITS',message:`the quote is ${quote.max_units} credits, above the ceiling ${maxCredits}; nothing was charged`,details:{quote}}});
 if(dryRun)return {ok:true,data:{dry_run:true,recipe_id:recipe,quote}};
 return call(api,'POST',recipePaths.runs(recipe),{body:{workspace_id:workspace,inputs,max_credits:maxCredits,dry_run:false,
  idempotency_key:idempotencyKey===undefined?recipeRunKey(workspace,recipe,inputs):validId(idempotencyKey,'idempotency_key')},key,signal});
}
