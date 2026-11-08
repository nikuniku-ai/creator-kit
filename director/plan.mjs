// S3 (docs/director/SPEC.md §3 S3): build a plan.json SCAFFOLD from one breakdown (A) or two (A+B). It only carries
// structure across (shot order, durations, framing, camera moves, hook positions); it never copies source dialogue,
// characters or props, because the adaptation itself is the creator's IDE agent's job and the product only replicates
// structure (REQUIREMENTS D4). The result is validated against plan.schema.json + semantics before it is written.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Refusal} from '../client/nikuniku-api.mjs';
import {parse,need,number} from './cli.mjs';
import {readJson,writeJson} from './breakdown.mjs';
import {validate} from './jsonschema.mjs';
import {semantics} from './semantics.mjs';
import {LOCALES} from './i18n.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const MERGES=['a_then_b','interleave'];
const clampMs=s=>Math.min(60000,Math.max(500,Math.round(s*1000)));

// [{role, breakdown, sha256}] in role order → merged list of {role, shot}.
export function mergeShots(inputs,merge='a_then_b'){
 const lists=inputs.map(i=>i.breakdown.shots.map(shot=>({role:i.role,shot})));
 if(merge==='a_then_b'||lists.length===1)return lists.flat();
 const out=[];for(let k=0;k<Math.max(...lists.map(l=>l.length));k++)for(const l of lists)if(k<l.length)out.push(l[k]);
 return out;
}

export function scaffold(inputs,{brief,planLang,projectId,merge='a_then_b',maxCredits=0}){
 const merged=mergeShots(inputs,merge);
 const sceneOf=role=>'sc-'+role.toLowerCase();
 let at=0;const hooks=[];
 const shots=merged.map(({role,shot},order)=>{
  // Hook positions follow the plan's own (clamped) durations; hook and description TEXT stay in the breakdown: they can
  // quote the source's people, props and lines (REVIEW-codex-p2.2 #4, #7).
  const ms=clampMs(shot.end_s-shot.start_s);
  if(shot.hook)hooks.push({at_s:at/1000,text:`待改編：鉤子位置（來源 ${role}:${shot.shot_index}）`});
  at+=ms;
  return {id:`s${order+1}`,scene_id:sceneOf(role),order,duration_ms:ms,framing:shot.framing,camera_move:shot.camera_move,camera:null,
   characters:[],props_enter:[],props_used:[],
   action:`待改編：來源 ${role}:${shot.shot_index}，${(ms/1000).toFixed(2)}s`,dialogue:[],rating:'general',accept:null,continue_from:null,source_shot:`${role}:${shot.shot_index}`};
 });
 const firstLine=brief.split('\n').map(l=>l.trim()).find(Boolean)??'';
 return {schema_version:1,project_id:projectId,revision:1,
  source_revision:sha(inputs.map(i=>i.sha256).join('\n')),lang:planLang,
  sources:inputs.map(i=>({source_id:i.breakdown.source_id,role:i.role,breakdown_sha256:i.sha256,usable_for:i.breakdown.usable_for??'analysis_only'})),
  bible:{logline:firstLine.slice(0,1000),constitution:[],hooks:hooks.slice(0,50),creator_brief:brief},
  characters:[],props:[],
  scenes:inputs.map(i=>({id:sceneOf(i.role),title:`待改編：來源 ${i.role}`,story_time_min:0,flashback:false,location:'待改編',lighting:'待改編',layout:null})),
  gaps:[],audio_refs:[],shots,dependencies:[],provider_constraints:{via:'nikuniku_v1'},
  budget:{max_credits:maxCredits,max_same_failure:3},retention:{keep_takes_days:null}};
}

export async function command(args){
 const o=parse(args);
 const out=need(o,'out'),projectId=need(o,'project'),planLang=need(o,'plan-lang');
 if(!LOCALES.includes(planLang))throw new Refusal('USAGE',`--plan-lang must be one of ${LOCALES.join(' ')}`);
 const merge=o.merge??'a_then_b';if(!MERGES.includes(merge))throw new Refusal('USAGE',`--merge must be one of ${MERGES.join(' ')}`);
 let brief;try{brief=readFileSync(need(o,'brief'),'utf8').trim();}catch(e){if(e instanceof Refusal)throw e;throw new Refusal('USAGE',`brief not found: ${o.brief}`);}
 if(!brief)throw new Refusal('USAGE','the brief is empty');
 if(brief.length>10000)throw new Refusal('USAGE','the brief is longer than 10000 characters');
 const inputs=[['A',need(o,'a')],...(o.b?[['B',o.b]]:[])].map(([role,f])=>({role,breakdown:readJson(f,'breakdown'),sha256:sha(readFileSync(f))}));
 if(inputs.length===2&&inputs[0].breakdown.source_id===inputs[1].breakdown.source_id)throw new Refusal('USAGE','A and B have the same source_id');
 const plan=scaffold(inputs,{brief,planLang,projectId,merge,maxCredits:number(o,'max-credits',{min:0,max:10000000,fallback:0})});
 const schema=JSON.parse(readFileSync(new URL('../schemas/plan.schema.json',import.meta.url),'utf8'));
 let errors=validate(schema,plan);if(!errors.length)errors=semantics('plan',plan);
 if(errors.length)throw new Refusal('SCHEMA_INVALID','the scaffold does not match plan.schema.json: '+errors.slice(0,5).map(e=>`${e.path} ${e.message}`).join('; '));
 writeJson(out,plan);
 return {result:{ok:true,data:{file:out,shots:plan.shots.length,sources:plan.sources.length}}};
}
