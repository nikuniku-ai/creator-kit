// S4 (docs/director/SPEC.md §3 S4): logic self-check of a plan. Every rule is one entry of RULES with a stable code, so
// a machine acts on the code (never on translated text) and deleting a rule turns exactly its own test red.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Refusal} from '../client/nikuniku-api.mjs';
import {parse,number} from './cli.mjs';
import {readJson,writeJson} from './breakdown.mjs';
import {validate} from './jsonschema.mjs';
import {semantics} from './semantics.mjs';

const ordered=plan=>[...plan.shots].sort((a,b)=>a.order-b.order);
const finding=(code,severity,path,message,{shot_id=null,scene_id=null,evidence=null}={})=>({code,severity,path,shot_id,scene_id,message,evidence});
const shotPath=(plan,shot)=>`$.shots[${plan.shots.indexOf(shot)}]`;

// Tokens for n-grams, decided per run of text (never per line, REVIEW-codex-p2.2 #1: one CJK character must not switch a
// whole English line to character mode): each CJK, kana or hangul character is a token; any other run of letters and
// digits is one lower-cased word. NFKC first so full-width letters and compatibility forms cannot dodge the check.
const TOKEN=/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]|[^\s\p{P}\p{S}\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]+/gu;
export function tokens(raw){return raw.normalize('NFKC').toLowerCase().match(TOKEN)??[];}
export function grams(text,n=3){const t=tokens(text),out=new Set();for(let i=0;i+n<=t.length;i++)out.add(t.slice(i,i+n).join('\u0001'));return out;}
// Share of the adapted line's 3-grams that also occur in the source dialogue (containment, not Jaccard: a short copied
// line inside a long rewrite still counts as copied). Lines with fewer than three 3-grams are too short to judge.
export function containment(line,sourceGrams){const g=grams(line);if(g.size<3)return null;let hit=0;for(const x of g)if(sourceGrams.has(x))hit++;return hit/g.size;}
// Lines too short for three 3-grams: copied only when the normalized tokens equal a source line's and there are >= 2.
const key=text=>{const t=tokens(text);return t.length>=2?t.join('\u0001'):null;};

export const RULES=[
 // L001 + L009 references first: later rules assume ids resolve.
 function undefinedCharacters(plan,out){
  const known=new Set(plan.characters.map(c=>c.id));
  for(const s of plan.shots){
   s.characters.forEach((c,i)=>{if(!known.has(c))out.push(finding('L001_CHARACTER_UNDEFINED','error',`${shotPath(plan,s)}.characters[${i}]`,`character ${c} is not defined in characters[]`,{shot_id:s.id}));});
   s.dialogue.forEach((d,i)=>{if(d.speaker!==null&&!known.has(d.speaker))out.push(finding('L001_CHARACTER_UNDEFINED','error',`${shotPath(plan,s)}.dialogue[${i}].speaker`,`speaker ${d.speaker} is not defined in characters[]`,{shot_id:s.id}));});
  }
 },
 function charactersBeforeIntro(plan,out){
  const position=new Map();ordered(plan).forEach(s=>{if(!position.has(s.scene_id))position.set(s.scene_id,position.size);});
  const intro=new Map(plan.characters.map(c=>[c.id,position.get(c.first_scene)??Infinity]));
  // Listed characters and speakers both count as appearing (REVIEW-codex-p2.2 #2); one finding per character per shot.
  for(const s of ordered(plan)){
   const present=new Map();s.characters.forEach((c,i)=>{if(!present.has(c))present.set(c,`${shotPath(plan,s)}.characters[${i}]`);});
   s.dialogue.forEach((d,i)=>{if(d.speaker!==null&&!present.has(d.speaker))present.set(d.speaker,`${shotPath(plan,s)}.dialogue[${i}].speaker`);});
   for(const [c,path] of present)if(intro.has(c)&&position.get(s.scene_id)<intro.get(c))out.push(finding('L002_CHARACTER_BEFORE_INTRO','error',path,`character ${c} appears in scene ${s.scene_id} before their first scene`,{shot_id:s.id,scene_id:s.scene_id}));
  }
 },
 function propsNotEntered(plan,out){
  const entered=new Set(),known=new Set(plan.props.map(p=>p.id));
  for(const s of ordered(plan)){
   s.props_enter.forEach(p=>entered.add(p));
   s.props_used.forEach((p,i)=>{if(known.has(p)&&!entered.has(p))out.push(finding('L003_PROP_NOT_ENTERED','error',`${shotPath(plan,s)}.props_used[${i}]`,`prop ${p} is used before it enters`,{shot_id:s.id}));});
  }
 },
 function similarity(plan,out,ctx){
  const sourceGrams=new Set(),sourceLines=new Set();
  for(const b of ctx.sources)for(const s of b.shots)for(const d of s.dialogue){for(const g of grams(d.text))sourceGrams.add(g);const k=key(d.text);if(k)sourceLines.add(k);}
  ctx.similarity.max=0;if(!sourceGrams.size&&!sourceLines.size)return;
  for(const s of plan.shots)s.dialogue.forEach((d,i)=>{
   let c=containment(d.text,sourceGrams);if(c===null){const k=key(d.text);if(!k||!sourceLines.has(k))return;c=1;}
   ctx.similarity.max=Math.max(ctx.similarity.max,c);
   if(c>ctx.similarity.threshold)out.push(finding('L004_SIMILARITY_TOO_HIGH','error',`${shotPath(plan,s)}.dialogue[${i}].text`,`dialogue repeats the source (3-gram containment ${c.toFixed(2)} > ${ctx.similarity.threshold})`,{shot_id:s.id,evidence:d.text}));});
 },
 function timeline(plan,out){
  // Every scene switch is checked, including a return to a scene already shown (REVIEW-codex-p2.2 #3); consecutive shots
  // in the same scene are one appearance.
  const scenes=new Map(plan.scenes.map(s=>[s.id,s]));let latest=-Infinity,previous=null;
  for(const s of ordered(plan)){
   if(s.scene_id===previous)continue;previous=s.scene_id;
   const scene=scenes.get(s.scene_id);if(!scene||scene.flashback)continue;
   if(scene.story_time_min<latest)out.push(finding('L005_TIMELINE_REGRESSION','error',`$.scenes[${plan.scenes.indexOf(scene)}].story_time_min`,`scene ${scene.id} starts at minute ${scene.story_time_min}, before minute ${latest} already shown, and is not marked flashback`,{shot_id:s.id,scene_id:scene.id}));
   latest=Math.max(latest,scene.story_time_min);
  }
 },
 function acceptMissing(plan,out){for(const s of plan.shots)if(!s.accept)out.push(finding('L006_ACCEPT_MISSING','warning',`${shotPath(plan,s)}.accept`,'shot has no accept block; shoot refuses it',{shot_id:s.id}));},
 function gapsUnfilled(plan,out){plan.gaps.forEach((g,i)=>{if(!g.filled)out.push(finding('L007_GAP_UNFILLED','warning',`$.gaps[${i}]`,`gap ${g.id} is not filled yet`));});},
 // L010: similarity only counts as checked when every plan source's breakdown was given with its file hash equal to
 // plan.sources[].breakdown_sha256. A plan without sources has nothing to compare against.
 function similarityChecked(plan,out,ctx){
  // Without the file hashes nothing proves these are the breakdowns the plan was built from (REVIEW-codex-p2.2 #5).
  ctx.similarity.checked=plan.sources.every(src=>ctx.sources.some((b,i)=>b.source_id===src.source_id&&ctx.sourceSha256s?.[i]===src.breakdown_sha256));
  if(!ctx.similarity.checked)out.push(finding('L010_SIMILARITY_NOT_CHECKED','warning','$.sources','similarity to the source dialogue was not checked: pass every breakdown in sources[] with --source'));
 },
 function names(plan,out){
  for(const s of plan.shots)s.dialogue.forEach((d,i)=>{
   for(const c of plan.characters){const own=c.names[d.lang];if(!own||d.text.includes(own))continue;
    const other=Object.entries(c.names).find(([l,n])=>l!==d.lang&&n!==own&&d.text.includes(n));
    if(other)out.push(finding('L008_NAME_INCONSISTENT','warning',`${shotPath(plan,s)}.dialogue[${i}].text`,`a ${d.lang} line calls ${c.id} "${other[1]}" (${other[0]}) instead of "${own}"`,{shot_id:s.id}));}
  });
 },
 function references(plan,out){
  const scenes=new Set(plan.scenes.map(s=>s.id)),props=new Set(plan.props.map(p=>p.id)),shots=new Set(plan.shots.map(s=>s.id));
  const miss=(path,what,id,shot_id=null)=>out.push(finding('L009_REFERENCE_UNDEFINED','error',path,`${what} ${id} does not exist`,{shot_id}));
  for(const s of plan.shots){const p=shotPath(plan,s);
   if(!scenes.has(s.scene_id))miss(`${p}.scene_id`,'scene',s.scene_id,s.id);
   for(const k of ['props_enter','props_used'])s[k].forEach((x,i)=>{if(!props.has(x))miss(`${p}.${k}[${i}]`,'prop',x,s.id);});
   if(s.continue_from!=null&&!shots.has(s.continue_from))miss(`${p}.continue_from`,'shot',s.continue_from,s.id);}
  plan.characters.forEach((c,i)=>{if(!scenes.has(c.first_scene))miss(`$.characters[${i}].first_scene`,'scene',c.first_scene);});
  plan.dependencies.forEach((d,i)=>{for(const k of ['shot_id','depends_on'])if(!shots.has(d[k]))miss(`$.dependencies[${i}].${k}`,'shot',d[k]);});
 },
];

// lint-report.schema.json allows 10000 findings. Beyond that, errors are kept before warnings and the last slot says how
// many were omitted (REVIEW-codex-p2.2 #6); `passed` is decided on the full list, and an error always survives the cut.
export const MAX_FINDINGS=10000;
function cap(all){
 if(all.length<=MAX_FINDINGS)return all;
 const sorted=[...all.filter(f=>f.severity==='error'),...all.filter(f=>f.severity!=='error')],kept=sorted.slice(0,MAX_FINDINGS-1);
 return [...kept,finding('L011_FINDINGS_TRUNCATED','warning','$',`omitted ${all.length-kept.length} more findings; fix these and lint again`)];
}
export function lint(plan,{sources=[],sourceSha256s=null,threshold=0.35,planSha256}={}){
 const all=[],ctx={sources,sourceSha256s,similarity:{max:0,threshold,n:3,checked:false}};
 for(const rule of RULES)rule(plan,all,ctx);
 const findings=cap(all);
 return {schema_version:1,plan_sha256:planSha256??createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
  passed:!findings.some(f=>f.severity==='error'),similarity:{max:Math.round(ctx.similarity.max*1000)/1000,threshold,n:3,checked:ctx.similarity.checked},findings};
}

export async function command(args){
 const o=parse(args,{multi:['source']});
 const file=o.positional[0];if(!file)throw new Refusal('USAGE','lint needs a plan path');
 const plan=readJson(file,'plan'),sources=(o.source??[]).map(f=>readJson(f,'breakdown'));
 const sourceSha256s=(o.source??[]).map(f=>createHash('sha256').update(readFileSync(f)).digest('hex'));
 const threshold=number(o,'threshold',{min:0,max:1,fallback:0.35});
 const report=lint(plan,{sources,sourceSha256s,threshold,planSha256:createHash('sha256').update(readFileSync(file)).digest('hex')});
 // The report is checked against its own schema before it leaves (REVIEW-codex-p2.2 #6): a report we cannot read back is a bug.
 const schema=JSON.parse(readFileSync(new URL('../schemas/lint-report.schema.json',import.meta.url),'utf8'));
 const bad=[...validate(schema,report),...semantics('lint-report',report)];
 if(bad.length)throw new Refusal('INTERNAL',`lint produced an invalid report: ${bad[0].path} ${bad[0].message}`,1);
 if(o.out)writeJson(o.out,report);
 const errorsCount=report.findings.filter(f=>f.severity==='error').length;
 if(!report.passed)return {exit:3,result:{ok:false,error:{code:'LINT_FAILED',message:`${errorsCount} error(s); see findings`},data:report}};
 return {result:{ok:true,data:report}};
}
