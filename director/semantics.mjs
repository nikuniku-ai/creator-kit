// Cross-field rules the JSON Schema subset cannot express.
// Applied after the schema everywhere a director file is read (readJson) and by scripts/validate-schemas.mjs, so a file
// that breaks one is refused as SCHEMA_INVALID before anything else happens. Returns [{path, keyword:'semantic', message}].
const err=(out,path,message)=>out.push({path,keyword:'semantic',message});
function unique(out,list,key,path){const seen=new Set();list.forEach((x,i)=>{const v=x[key];if(seen.has(v))err(out,`${path}[${i}].${key}`,`duplicate ${key} ${v}`);seen.add(v);});}
const EPS=0.001;
export const RULES={
 source(d,out){
  if((d.url===null)===(d.local_file===null))err(out,'$','exactly one of url and local_file must be set');
  if(d.local_file!==null&&d.sha256===null)err(out,'$.sha256','a local file needs its sha256');
  if(['unlicensed_reference','unknown'].includes(d.rights.status)&&d.usable_for!=='analysis_only')err(out,'$.usable_for',`rights ${d.rights.status} can only be used for analysis`);
 },
 breakdown(d,out){
  d.shots.forEach((s,i)=>{
   if(s.shot_index!==i)err(out,`$.shots[${i}].shot_index`,`expected ${i}`);
   if(!(s.end_s>s.start_s))err(out,`$.shots[${i}]`,'end_s must be after start_s');
   if(s.end_s>d.duration_s+0.05)err(out,`$.shots[${i}].end_s`,'shot ends after the video');
   if(i>0&&s.start_s<d.shots[i-1].end_s-EPS)err(out,`$.shots[${i}].start_s`,'shots overlap');
  });
 },
 plan(d,out){
  for(const k of ['characters','props','scenes','shots','gaps','audio_refs'])unique(out,d[k],'id',`$.${k}`);
  unique(out,d.shots,'order','$.shots');
  unique(out,d.sources,'role','$.sources');unique(out,d.sources,'source_id','$.sources');
  if(d.sources.length===2&&d.sources[0].role!=='A')err(out,'$.sources','A comes before B');
  d.characters.forEach((c,i)=>{if(!c.names[d.lang])err(out,`$.characters[${i}].names`,`needs a name in the plan language ${d.lang}`);});
  d.shots.forEach((s,i)=>{if(s.camera&&s.camera.position.every((v,j)=>Math.abs(v-s.camera.look_at[j])<1e-9))err(out,`$.shots[${i}].camera`,'position and look_at are the same point');
   if(s.continue_from===s.id)err(out,`$.shots[${i}].continue_from`,'a shot cannot continue from itself');});
  // Dependencies (and continue_from) must form a graph without cycles: a cycle can never be shot.
  const edges=new Map();const add=(a,b)=>{if(!edges.has(a))edges.set(a,[]);edges.get(a).push(b);};
  d.dependencies.forEach((x,i)=>{if(x.shot_id===x.depends_on)err(out,`$.dependencies[${i}]`,'a shot cannot depend on itself');add(x.shot_id,x.depends_on);});
  d.shots.forEach(s=>{if(s.continue_from)add(s.id,s.continue_from);});
  const state=new Map();let cyclic=false;
  const visit=n=>{if(state.get(n)===1){cyclic=true;return;}if(state.get(n)===2)return;state.set(n,1);for(const m of edges.get(n)??[])visit(m);state.set(n,2);};
  for(const n of edges.keys())visit(n);
  if(cyclic)err(out,'$.dependencies','dependencies form a cycle');
 },
 'lint-report'(d,out){
  const hasError=d.findings.some(f=>f.severity==='error');
  if(d.passed===hasError)err(out,'$.passed','passed must equal "no error findings"');
 },
 'gacha-ledger'(d,out){
  unique(out,d.shots,'shot_id','$.shots');
  let quoted=0;
  d.shots.forEach((s,i)=>{
   const p=`$.shots[${i}]`;
   s.takes.forEach((t,j)=>{quoted+=t.quoted_units;if(t.take!==j+1)err(out,`${p}.takes[${j}].take`,`expected ${j+1}`);
    if(t.verdict==='failed'&&!t.failure_class)err(out,`${p}.takes[${j}].failure_class`,'a failed take needs its failure class');});
   const firstPassed=s.takes.find(t=>t.verdict==='passed');
   if((s.status==='adopted')!==(s.adopted!==null))err(out,`${p}.adopted`,'adopted is set exactly when status is adopted');
   if(s.adopted){
    if(!firstPassed||s.adopted.take!==firstPassed.take)err(out,`${p}.adopted.take`,'the adopted take must be the first passed take');
    else if(s.adopted.job_id!==firstPassed.job_id||s.adopted.run_id!==firstPassed.run_id)err(out,`${p}.adopted`,'adopted ids differ from the take');
    if(s.takes.indexOf(firstPassed)!==s.takes.length-1)err(out,`${p}.takes`,'no take may follow the adopted one');
   }
  });
  if(d.credits.quoted_total!==quoted)err(out,'$.credits.quoted_total',`must equal the sum of quoted_units (${quoted})`);
 },
 edl(d,out){
  let at=0;unique(out,d.entries,'shot_id','$.entries');
  d.entries.forEach((e,i)=>{if(!(e.out_ms>e.in_ms))err(out,`$.entries[${i}]`,'out_ms must be after in_ms');
   if(e.record_in_ms!==at)err(out,`$.entries[${i}].record_in_ms`,`expected ${at}`);at+=Math.max(0,e.out_ms-e.in_ms);});
  if(d.total_ms!==at)err(out,'$.total_ms',`expected ${at}`);
 },
 'qa-receipt'(d,out){unique(out,d.takes,'shot_id','$.takes');},
};
export function semantics(name,value){const out=[];RULES[name]?.(value,out);return out;}
