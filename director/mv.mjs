// MV (docs/director/SPEC.md §3 MV, AC9): the existing MV flow (1–4 identity images + a song) under the director kit.
// The CLI reuses the exported `generate` path of cli/nikuniku.mjs (upload, prompt check, draft, quote, --max-credits,
// submit); this file only adds what MV requires on top — a song and at least one image, checked before anything is sent —
// and the MCP draft tool, which stops after the quote (submitting stays the explicit nikuniku_submit).
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Refusal,validId,call,uploadPng,uploadAudio,pickMode} from '../client/nikuniku-api.mjs';

export const MV_USAGE=`nikuniku mv --image <ref.png> [--image <ref.png> ... up to 4] --audio <song.wav|.mp3> --prompt <prompt.txt|->
             [--workspace <id>] [--project <id>] [--rights <rights_ref>] [--max-credits <n>] [--wait [--out <file>]]
    MV: identity images plus a song in the sold mode whose audio is external (GET /v1/capabilities). Same steps as
    generate: upload, prompt check (exit 3), draft, quote, refuse above --max-credits (exit 4), submit. A song and at least
    one image are required and checked before anything is sent.`;

export function mvPrecheck(o){
 const images=o.images??[];
 if(o.audio===undefined)throw new Refusal('USAGE','mv needs --audio <song.wav|.mp3>');
 if(images.length<1)throw new Refusal('USAGE','mv needs at least one --image');
 if(images.length>4)throw new Refusal('USAGE','--image may repeat at most 4 times');
 if(o.prompt===undefined)throw new Refusal('USAGE','mv needs --prompt <prompt.txt|->');
}

// MCP: upload images and song, pick the external-audio mode, check the prompt, save the draft and quote. Never submits.
export async function mvDraft(api,a,key){
 const images=a.image_paths??[];
 mvPrecheck({images,audio:a.audio_path,prompt:a.prompt});
 const ws=validId(a.workspace_id,'workspace_id'),rights=validId(a.rights_ref,'rights_ref');
 const read=f=>{try{return new Uint8Array(readFileSync(f));}catch{throw new Refusal('USAGE',`${f} could not be read`);}};
 const cap=(await call(api,'GET','/v1/capabilities',{})).data;
 const spec=pickMode(cap,{images:images.length,audio:true,continueFrom:null});
 if(!spec)throw new Refusal('UNSUPPORTED',`no sold release takes ${images.length} image(s) and a song; see GET /v1/capabilities`);
 const assets=[];for(const f of images)assets.push((await uploadPng(api,key,ws,read(f),{rights_ref:rights})).data.asset_id);
 const audio=(await uploadAudio(api,key,ws,read(a.audio_path),{rights_ref:rights})).data.audio_id;
 const check=(await call(api,'POST','/v1/prompts/check',{body:{workspace_id:ws,mode:spec.mode,prompt:a.prompt},key})).data;
 if(check.passed===false)return {ok:false,error:{code:'PROMPT_CHECK_FAILED',message:'the prompt check found errors; nothing was saved or charged'},data:{check}};
 const price=(await call(api,'GET','/v1/pricing',{})).data.price_version;
 const project=a.project_id?validId(a.project_id,'project_id'):'mv-'+createHash('sha256').update(JSON.stringify([ws,spec,price,assets,a.prompt,audio])).digest('hex').slice(0,24);
 const draft={project:{schema_version:1,workspace_id:ws,project_id:project,project_revision:1,shot_revision:1,capabilities_revision:spec.release,price_version:price,mode:spec.mode,prompt:a.prompt,duration_ms:spec.duration_ms,asset_ids:assets},
  character_source:'upload',reference_id:assets[0],scene:'As described in the prompt.',confirmed_revision:1,reference_audio_id:audio};
 await call(api,'POST','/v1/drafts',{body:{workspace_id:ws,draft_json:JSON.stringify(draft)},key});
 const quote=(await call(api,'POST','/v1/quotes',{body:{workspace_id:ws,project_id:project},key})).data;
 return {ok:true,data:{project_id:project,asset_ids:assets,audio_id:audio,mode:spec.mode,release:spec.release,quote:{quote_id:quote.quote_id,max_units:quote.max_units,unit_version:quote.unit_version},
  next:'review the quote, then submit with nikuniku_submit {quote_id, acknowledged_input_hash, user_acknowledged_max_units, idempotency_key}'}};
}
