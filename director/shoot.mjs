// S7–S9 (docs/director/SPEC.md §3 S7, S8, S9): shoot every shot of a plan through the nikuniku /v1 recipe routes and keep
// a failure ledger. The client only DECLARES acceptance (shot.accept); the verdict comes from the server
// (snapshot.acceptance.verdict, a CORE-ASKS C4 proposal that today exists only in the mock). Rules (AC7):
//   - the first take the server passed is adopted and the shot stops;
//   - max_same_failure failures of one class stop the shot; max_takes ends it;
//   - failed / pending / unavailable takes are NEVER adopted — there is no "best of the failures".
// Before any request (AC5, M5): the API key, every selected shot's accept block, the source breakdowns and a lint pass.
// The ledger is rewritten atomically after every step and guarded by an O_EXCL lock file, so a crash resumes with the same
// idempotency keys instead of paying twice. The ledger is a LOCAL record, not proof of acceptance (SPEC TL;DR 3).
import {createHash} from 'node:crypto';
import {readFileSync,existsSync,openSync,closeSync,unlinkSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {Refusal,ApiError,apiBase,apiKey,validId,call} from '../client/nikuniku-api.mjs';
import {parse,need,number} from './cli.mjs';
import {readJson,writeJson} from './breakdown.mjs';
import {validate} from './jsonschema.mjs';
import {semantics} from './semantics.mjs';
import {lint} from './lint.mjs';
import {downloadTake} from './net.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
export const DEFAULT_RECIPE='director_shot';
export function idempotencyKey(ws,recipe,planSha,shotId,take){return 'dk-'+sha([ws,recipe,planSha,shotId,take].join('|')).slice(0,40);}

// S8 white list. explicit shots carry no free text at all (action, dialogue, check notes): the server drafts them.
export function projectShot(s){
 const out={id:s.id,order:s.order,duration_ms:s.duration_ms,framing:s.framing,camera_move:s.camera_move,camera:s.camera??null,
  characters:s.characters,props_enter:s.props_enter,props_used:s.props_used,rating:s.rating,continue_from:s.continue_from??null,
  accept:{checks:s.accept.checks.map(c=>({id:c.id,kind:c.kind,threshold:c.threshold??null})),max_takes:s.accept.max_takes}};
 if(s.rating!=='explicit'){out.action=s.action;out.dialogue=s.dialogue;}
 return out;
}

// Pure gacha rule (AC7). takes are in order; returns {status, adopted, next: 'stop'|'retry'|'wait'|'resend'}.
export function decide(takes,{maxTakes,maxSameFailure}){
 const failures=new Map();
 for(const t of takes){
  if(t.verdict==='passed')return {status:'adopted',adopted:{take:t.take,job_id:t.job_id,run_id:t.run_id},next:'stop'};
  if(t.verdict==='unavailable')return {status:'acceptance_unavailable',adopted:null,next:'stop'};
  if(t.verdict==='pending')return {status:'in_progress',adopted:null,next:t.run_id===null?'resend':'wait'};
  const n=(failures.get(t.failure_class)??0)+1;failures.set(t.failure_class,n);
  if(n>=maxSameFailure)return {status:'stopped_same_failure',adopted:null,next:'stop'};
 }
 if(takes.length>=maxTakes)return {status:'exhausted',adopted:null,next:'stop'};
 return {status:takes.length?'in_progress':'not_started',adopted:null,next:'retry'};
}

const CLASS=/^[a-z][a-z0-9_]{0,63}$/,SHA=/^[a-f0-9]{64}$/;
// Snapshot → take fields, or null to keep waiting. Fail closed: anything we cannot read as a server verdict is unavailable.
export function judge(snap){
 const base={route:typeof snap.route==='string'&&snap.route.length<=64?snap.route:null,
  charged_units:Number.isSafeInteger(snap.charged_units)&&snap.charged_units>=0?snap.charged_units:null,output_sha256:null};
 if(snap.state==='failed'||snap.state==='cancelled')return {...base,verdict:'failed',failure_class:'run_'+snap.state};
 if(snap.state!=='succeeded')return null;
 const a=snap.acceptance;
 if(!a||typeof a!=='object')return {...base,verdict:'unavailable',failure_class:null};
 if(a.verdict==='pending')return null;
 if(a.verdict==='failed')return {...base,verdict:'failed',failure_class:typeof a.failure_class==='string'&&CLASS.test(a.failure_class)?a.failure_class:'unspecified'};
 // A pass we cannot bind to bytes is not a pass we can assemble: no output sha256 → unavailable.
 if(a.verdict==='passed'&&typeof snap.output_sha256==='string'&&SHA.test(snap.output_sha256))return {...base,verdict:'passed',failure_class:null,output_sha256:snap.output_sha256};
 return {...base,verdict:'unavailable',failure_class:null};
}

const ledgerSchema=()=>JSON.parse(readFileSync(new URL('../schemas/gacha-ledger.schema.json',import.meta.url),'utf8'));
function saveLedger(path,ledger){
 ledger.credits.quoted_total=ledger.shots.reduce((n,s)=>n+s.takes.reduce((m,t)=>m+t.quoted_units,0),0);
 const bad=[...validate(ledgerSchema(),ledger),...semantics('gacha-ledger',ledger)];
 if(bad.length)throw new Refusal('INTERNAL',`refusing to write an invalid ledger: ${bad[0].path} ${bad[0].message}`,1);
 writeJson(path,ledger);
}
function waitControls(o){
 const seconds=number(o,'timeout',{min:0,max:2147483,fallback:1800}),poll=Number(process.env.NIKUNIKU_POLL_MS??'5000');
 if(!Number.isFinite(poll)||poll<1||poll>2147483647)throw new Refusal('USAGE','NIKUNIKU_POLL_MS must be milliseconds from 1 to 2147483647');
 return {seconds,poll};
}
// Local checks; all of them run before the first request.
function preflight(o){
 // MCP passes its own key and base (o.apiKey/o.apiBase); the CLI reads the environment.
 const key=apiKey(o.apiKey??process.env.NIKUNIKU_API_KEY),api=o.apiBase??apiBase(process.env.NIKUNIKU_API_BASE);
 const file=o.positional[0];if(!file)throw new Refusal('USAGE','shoot needs a plan path');
 const ledgerPath=need(o,'ledger'),plan=readJson(file,'plan'),planSha=sha(readFileSync(file));
 const wanted=o.shot??null,shots=[...plan.shots].sort((a,b)=>a.order-b.order).filter(s=>!wanted||wanted.includes(s.id));
 if(wanted)for(const id of wanted)if(!plan.shots.some(s=>s.id===id))throw new Refusal('USAGE',`shot ${id} is not in the plan`);
 const missing=shots.filter(s=>!s.accept).map(s=>s.id);
 if(missing.length)throw new Refusal('ACCEPT_REQUIRED',`these shots have no accept block: ${missing.join(', ')}`);
 const files=o.source??[],sources=files.map(f=>readJson(f,'breakdown')),shas=files.map(f=>sha(readFileSync(f)));
 const unmatched=plan.sources.filter(src=>!sources.some((b,i)=>b.source_id===src.source_id&&shas[i]===src.breakdown_sha256));
 if(unmatched.length)throw new Refusal('SOURCES_REQUIRED',`pass the breakdown of ${unmatched.map(s=>s.source_id).join(', ')} with --source (sha256 must equal plan.sources[].breakdown_sha256)`);
 const report=lint(plan,{sources,sourceSha256s:shas,planSha256:planSha});
 if(!report.passed)return {refused:{exit:3,result:{ok:false,error:{code:'LINT_FAILED',message:`${report.findings.filter(f=>f.severity==='error').length} lint error(s); run nikuniku lint`},data:report}}};
 const cap=o['max-credits']===undefined?plan.budget.max_credits:Math.min(plan.budget.max_credits,number(o,'max-credits',{min:0,max:10000000,fallback:0}));
 if(!Number.isSafeInteger(cap))throw new Refusal('USAGE','--max-credits must be a whole number');
 return {key,api,plan,planSha,shots,ledgerPath,cap,wait:waitControls(o)};
}

export async function shoot(o){
 const pre=preflight(o);if(pre.refused)return pre.refused;
 const {key,api,plan,planSha,shots,ledgerPath,cap,wait}=pre;
 let ledger=null;
 if(existsSync(ledgerPath)){ledger=readJson(ledgerPath,'gacha-ledger');
  if(ledger.plan_sha256!==planSha||ledger.project_id!==plan.project_id)throw new Refusal('LEDGER_MISMATCH','the ledger belongs to another plan (plan_sha256 differs); use a new --ledger');}
 const lock=ledgerPath+'.lock';let fd;
 try{fd=openSync(lock,'wx');writeSync(fd,String(process.pid));closeSync(fd);}
 catch(e){if(e.code==='EEXIST')throw new Refusal('LEDGER_LOCKED',`${lock} exists: another shoot is using this ledger (remove the lock only if no other process is running)`,1);throw e;}
 try{
  const req=(method,path,body)=>call(api,method,path,{body,key});
  const ws=o.workspace!==undefined?validId(o.workspace,'--workspace'):validId((await req('GET','/v1/me')).data.workspace_id,'workspace_id');
  if(ledger&&ledger.workspace_id!==ws)throw new Refusal('LEDGER_MISMATCH','the ledger belongs to another workspace; use a new --ledger');
  ledger??={schema_version:1,plan_sha256:planSha,project_id:plan.project_id,workspace_id:ws,credits:{max:cap,quoted_total:0},shots:[]};
  ledger.credits.max=cap;
  const save=()=>saveLedger(ledgerPath,ledger);
  const q=encodeURIComponent;
  const rules=s=>({maxTakes:s.accept.max_takes,maxSameFailure:plan.budget.max_same_failure});
  const outcome={unavailable:[],timeout:[],notAdopted:[],budget:null};
  // maxNewTakes bounds how many takes this call may submit (MCP: submit = 1, status = 0); the CLI has no bound.
  let newTakes=0;const maxNew=o.maxNewTakes??Infinity;
  for(const shot of shots){
   let entry=ledger.shots.find(e=>e.shot_id===shot.id);
   if(!entry){entry={shot_id:shot.id,status:'not_started',adopted:null,takes:[]};ledger.shots.push(entry);}
   const recipe=shot.recipe_id??o.recipe??DEFAULT_RECIPE;
   const inputs=n=>({shot_json:JSON.stringify(projectShot(shot)),plan_sha256:planSha,take:String(n)});
   const runBody=t=>({workspace_id:ws,inputs:inputs(t.take),max_credits:t.quoted_units,dry_run:false,idempotency_key:t.idempotency_key});
   const apply=d=>{entry.status=d.status;entry.adopted=d.adopted;};
   for(;;){
    const d=decide(entry.takes,rules(shot));apply(d);
    if(d.next==='stop')break;
    let t=entry.takes.at(-1);
    if(d.next==='retry'){
     if(newTakes>=maxNew)break;
     const n=entry.takes.length+1;
     const quote=(await req('POST',`/v1/recipes/${q(recipe)}/quotes`,{workspace_id:ws,inputs:inputs(n)})).data;
     if(!Number.isSafeInteger(quote.max_units)||quote.max_units<0)throw new Refusal('INVALID_RESPONSE','the quote has no max_units',1);
     if(ledger.credits.quoted_total+quote.max_units>cap){entry.status='budget_stopped';save();outcome.budget={shot:shot.id,quote:quote.max_units};break;}
     t={take:n,idempotency_key:idempotencyKey(ws,recipe,planSha,shot.id,n),quote_id:validId(quote.quote_id,'quote_id'),quoted_units:quote.max_units,
      run_id:null,job_id:null,verdict:'pending',failure_class:null,route:null,charged_units:null,output_sha256:null};
     entry.takes.push(t);entry.status='in_progress';newTakes++;save();
    }
    if(t.run_id===null){
     // A resend may spend (if the first call never reached the server), so it counts against maxNewTakes like a new take.
     if(d.next==='resend'){if(newTakes>=maxNew)break;newTakes++;}
     const run=(await req('POST',`/v1/recipes/${q(recipe)}/runs`,runBody(t))).data;
     t.run_id=validId(run.run_id??run.job_id,'run_id');t.job_id=validId(run.job_id??run.run_id,'job_id');save();
    }
    const deadline=Date.now()+wait.seconds*1000;let judged=null;
    for(;;){
     judged=judge((await req('GET',`/v1/recipe-runs/${q(t.run_id)}?workspace_id=${q(ws)}`)).data);
     if(judged||Date.now()+wait.poll>deadline)break;
     await new Promise(r=>setTimeout(r,wait.poll));
    }
    if(!judged){entry.status='acceptance_timeout';save();outcome.timeout.push(shot.id);break;}
    Object.assign(t,judged);save();
   }
   if(outcome.budget)break;
   if(entry.status==='adopted'&&o.takes){const t=entry.takes.find(x=>x.take===entry.adopted.take);await downloadTake(api,key,ws,t.job_id,t.output_sha256,join(o.takes,shot.id+'.mp4'));}
   if(entry.status==='acceptance_unavailable')outcome.unavailable.push(shot.id);
   else if(!['adopted','acceptance_timeout','in_progress','not_started'].includes(entry.status))outcome.notAdopted.push(shot.id);
   else if(['in_progress','not_started'].includes(entry.status)&&maxNew===Infinity)outcome.notAdopted.push(shot.id);
  }
  save();
  const data={ledger:ledgerPath,quoted_total:ledger.credits.quoted_total,shots:ledger.shots.filter(e=>shots.some(s=>s.id===e.shot_id)).map(e=>({shot_id:e.shot_id,status:e.status,adopted_take:e.adopted?.take??null,takes:e.takes.length,
   next:decide(e.takes,rules(plan.shots.find(s=>s.id===e.shot_id))).next}))};
  const fail=(exit,code,message)=>({exit,result:{ok:false,error:{code,message},data}});
  if(outcome.budget)return fail(4,'ABOVE_MAX_CREDITS',`the next take of ${outcome.budget.shot} would quote ${outcome.budget.quote} credits, above the ${cap} credit limit; no run was sent`);
  if(outcome.unavailable.length)return fail(1,'ACCEPTANCE_UNAVAILABLE',`the server returned no acceptance verdict for ${outcome.unavailable.join(', ')}; nothing was adopted`);
  if(outcome.timeout.length)return fail(1,'ACCEPTANCE_TIMEOUT',`no verdict in time for ${outcome.timeout.join(', ')}; run shoot again to keep waiting (nothing is re-sent)`);
  if(outcome.notAdopted.length)return fail(3,'SHOTS_NOT_ADOPTED',`no take passed for ${outcome.notAdopted.join(', ')}`);
  return {result:{ok:true,data}};
 }catch(e){
  // Keep whatever was learnt (quotes, run ids) so the next run resumes with the same keys.
  if(ledger&&(e instanceof ApiError||e instanceof Refusal))try{saveLedger(ledgerPath,ledger);}catch{}
  throw e;
 }finally{try{unlinkSync(lock);}catch{}}
}
export async function command(args){return shoot(parse(args,{multi:['source','shot']}));}
