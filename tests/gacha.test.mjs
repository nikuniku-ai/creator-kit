// AC7 + AC6 client half (SPEC §3 S8–S9): the first take the SERVER passed is adopted; three failures of one class
// stop the shot; a take that did not pass is never adopted (no "best of the failures"); no provider/route/model is sent
// and the server's route is recorded as is. Also: budget stop, restart without double runs, ledger lock and mismatch.
import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {start,KEY,WS} from './mock-api.mjs';
import {cli,tmp} from './helpers.mjs';
import {makeFixtures} from '../scripts/make-fixtures.mjs';
import {decide,idempotencyKey,projectShot} from '../director/shoot.mjs';
import {validate} from '../director/jsonschema.mjs';
import {semantics} from '../director/semantics.mjs';
let mock;
before(async()=>{mock=await start();});
after(()=>mock.server.close());
beforeEach(()=>mock.reset());
const env=()=>({NIKUNIKU_API_BASE:mock.base,NIKUNIKU_API_KEY:KEY,NIKUNIKU_POLL_MS:'5'});
const ledgerSchema=JSON.parse(readFileSync('schemas/gacha-ledger.schema.json','utf8'));
function planFile(edit){const p=JSON.parse(readFileSync('schemas/examples/plan.ab-merge.json','utf8'));p.sources=[];edit?.(p);
 const dir=tmp(),f=join(dir,'plan.json');writeFileSync(f,JSON.stringify(p));return {dir,f,ledger:join(dir,'ledger.json')};}
const readLedger=f=>{const l=JSON.parse(readFileSync(f,'utf8'));assert.deepEqual([...validate(ledgerSchema,l),...semantics('gacha-ledger',l)],[],'ledger is schema-valid');return l;};
const shotOf=(l,id)=>l.shots.find(s=>s.shot_id===id);
const posts=kind=>mock.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/'+kind));
const F=c=>({verdict:'failed',failure_class:c}),P={verdict:'passed'};

// ── pure rule (director/shoot.mjs#decide) ──
const take=(n,verdict,failure_class=null)=>({take:n,verdict,failure_class,run_id:'r'+n,job_id:'r'+n});
test('decide: the first passed take is adopted even after failures',()=>{
 const d=decide([take(1,'failed','identity_match'),take(2,'failed','framing'),take(3,'passed')],{maxTakes:5,maxSameFailure:3});
 assert.equal(d.status,'adopted');assert.equal(d.adopted.take,3);assert.equal(d.next,'stop');
});
test('decide: three failures of one class stop the shot without adopting',()=>{
 const d=decide([take(1,'failed','framing'),take(2,'failed','identity_match'),take(3,'failed','framing'),take(4,'failed','framing')],{maxTakes:10,maxSameFailure:3});
 assert.equal(d.status,'stopped_same_failure');assert.equal(d.adopted,null);
 assert.equal(decide([take(1,'failed','x'),take(2,'failed','x')],{maxTakes:10,maxSameFailure:2}).status,'stopped_same_failure');
});
test('decide: out of takes with only failures → exhausted; never "the best of the failures"',()=>{
 const d=decide([take(1,'failed','a'),take(2,'failed','b')],{maxTakes:2,maxSameFailure:3});
 assert.equal(d.status,'exhausted');assert.equal(d.adopted,null);
 assert.equal(decide([take(1,'failed','a')],{maxTakes:2,maxSameFailure:3}).next,'retry');
 assert.equal(decide([],{maxTakes:2,maxSameFailure:3}).next,'retry');
});
test('decide: unavailable stops; pending waits; neither is adopted',()=>{
 assert.equal(decide([take(1,'unavailable')],{maxTakes:5,maxSameFailure:3}).status,'acceptance_unavailable');
 const w=decide([take(1,'pending')],{maxTakes:5,maxSameFailure:3});assert.equal(w.next,'wait');assert.equal(w.adopted,null);
});
test('idempotency key changes with workspace, recipe, plan, shot and take',()=>{
 const a=idempotencyKey(WS,'r','a'.repeat(64),'s1',1);assert.match(a,/^dk-[a-f0-9]{40}$/);
 for(const k of [idempotencyKey('ws2','r','a'.repeat(64),'s1',1),idempotencyKey(WS,'q','a'.repeat(64),'s1',1),idempotencyKey(WS,'r','b'.repeat(64),'s1',1),idempotencyKey(WS,'r','a'.repeat(64),'s2',1),idempotencyKey(WS,'r','a'.repeat(64),'s1',2)])assert.notEqual(k,a);
});
test('S8 projection: explicit shots send no free text; general shots send action and dialogue',()=>{
 const p=JSON.parse(readFileSync('schemas/examples/plan.ab-merge.json','utf8')),s=p.shots[0];
 const g=projectShot(s);assert.equal(g.action,s.action);assert.deepEqual(g.dialogue,s.dialogue);
 const e=projectShot({...s,rating:'explicit'});
 for(const k of ['action','dialogue'])assert.ok(!(k in e),k);
 assert.ok(e.accept.checks.every(c=>!('note' in c)));assert.ok(!JSON.stringify(e).includes(s.action));
 assert.ok(!('note' in g.accept.checks[0]),'check notes are never sent');
});

// ── CLI against mock /v1 ──
test('AC7: two failures then a pass → the third take is adopted; every take is in the failure ledger',async()=>{
 mock.director.outcomes={s1:[F('identity_match'),F('framing'),P]};
 const {f,ledger}=planFile();const r=await cli(['shoot',f,'--ledger',ledger],env());
 assert.equal(r.code,0,r.stderr);
 const l=readLedger(ledger),s1=shotOf(l,'s1');
 assert.equal(s1.status,'adopted');assert.equal(s1.adopted.take,3);assert.deepEqual(s1.takes.map(t=>t.verdict),['failed','failed','passed']);
 assert.deepEqual(s1.takes.map(t=>t.failure_class),['identity_match','framing',null]);
 assert.equal(shotOf(l,'s2').adopted.take,1);assert.equal(posts('runs').length,4);
 assert.equal(l.credits.quoted_total,160);
});
test('AC7: three failures of one class stop that shot (exit 3) and the others are still shot',async()=>{
 mock.director.outcomes={s1:[F('framing'),F('framing'),F('framing'),P]};
 const {f,ledger}=planFile();const r=await cli(['shoot',f,'--ledger',ledger],env());
 assert.equal(r.code,3);assert.equal(r.err.error.code,'SHOTS_NOT_ADOPTED');
 const l=readLedger(ledger);assert.equal(shotOf(l,'s1').status,'stopped_same_failure');assert.equal(shotOf(l,'s1').takes.length,3);
 assert.equal(shotOf(l,'s1').adopted,null);assert.equal(shotOf(l,'s2').status,'adopted');
});
test('AC7: when every take fails nothing is adopted, even the take the server scored best',async()=>{
 mock.director.outcomes={s1:['a','b','c','d','e'].map(F)};
 const {f,ledger}=planFile();const r=await cli(['shoot',f,'--ledger',ledger,'--shot','s1'],env());
 assert.equal(r.code,3);const s1=shotOf(readLedger(ledger),'s1');
 assert.equal(s1.status,'exhausted');assert.equal(s1.adopted,null);assert.equal(s1.takes.length,5);
});
test('run failures count as a failure class; a failed run with no class is "run_failed"',async()=>{
 mock.director.outcomes={s1:[{state:'failed'},{state:'cancelled'},P]};
 const {f,ledger}=planFile();const r=await cli(['shoot',f,'--ledger',ledger,'--shot','s1'],env());
 assert.equal(r.code,0,r.stderr);assert.deepEqual(shotOf(readLedger(ledger),'s1').takes.map(t=>t.failure_class),['run_failed','run_cancelled',null]);
});
test('no acceptance field (or an unknown verdict) → unavailable, not adopted, exit 1 ACCEPTANCE_UNAVAILABLE',async()=>{
 for(const o of [{verdict:'passed',acceptance:'absent'},{verdict:'weird'}]){
  mock.reset();mock.director.outcomes={s1:[o,P]};
  const {f,ledger}=planFile();const r=await cli(['shoot',f,'--ledger',ledger,'--shot','s1'],env());
  assert.equal(r.code,1,JSON.stringify(o));assert.equal(r.err.error.code,'ACCEPTANCE_UNAVAILABLE');
  const s1=shotOf(readLedger(ledger),'s1');assert.equal(s1.status,'acceptance_unavailable');assert.equal(s1.takes.length,1);assert.equal(s1.adopted,null);
 }
});
test('AC6 client half: no provider/route/model key anywhere in a request; the server route is recorded, not the declared rating',async()=>{
 mock.director.outcomes={s1:[{verdict:'passed',route:'explicit'}]};
 const {f,ledger}=planFile();const r=await cli(['shoot',f,'--ledger',ledger,'--shot','s1'],env());assert.equal(r.code,0,r.stderr);
 const keys=v=>v&&typeof v==='object'?Object.entries(v).flatMap(([k,x])=>[k,...keys(typeof x==='string'&&x.startsWith('{')?JSON.parse(x):x)]):[];
 for(const q of mock.requests)for(const k of keys(q.body))assert.ok(!['provider','route','model'].includes(k),`${q.path} sent ${k}`);
 assert.equal(shotOf(readLedger(ledger),'s1').takes[0].route,'explicit');
 const sent=JSON.parse(posts('quotes')[0].body.inputs.shot_json);assert.equal(sent.rating,'general');
});
test('budget: a quote that would pass --max-credits stops before the run (exit 4)',async()=>{
 mock.director.outcomes={s1:[F('x'),P]};
 const {f,ledger}=planFile();const r=await cli(['shoot',f,'--ledger',ledger,'--shot','s1','--max-credits','70'],env());
 assert.equal(r.code,4);assert.equal(r.err.error.code,'ABOVE_MAX_CREDITS');assert.equal(posts('runs').length,1);
 const s1=shotOf(readLedger(ledger),'s1');assert.equal(s1.status,'budget_stopped');assert.equal(s1.adopted,null);
 const zero=planFile(p=>{p.budget.max_credits=0;});mock.requests.length=0;
 const z=await cli(['shoot',zero.f,'--ledger',zero.ledger,'--shot','s1'],env());assert.equal(z.code,4);assert.equal(posts('runs').length,0);
});
test('restart: a take already running is polled, not sent again',async()=>{
 mock.director.outcomes={s1:[{verdict:'passed',polls:3}]};
 const {f,ledger}=planFile();
 const first=await cli(['shoot',f,'--ledger',ledger,'--shot','s1','--timeout','0'],env());
 assert.equal(first.code,1);assert.equal(first.err.error.code,'ACCEPTANCE_TIMEOUT');
 assert.equal(shotOf(readLedger(ledger),'s1').status,'acceptance_timeout');
 const again=await cli(['shoot',f,'--ledger',ledger,'--shot','s1'],env());
 assert.equal(again.code,0,again.stderr);assert.equal(posts('runs').length,1);assert.equal(posts('quotes').length,1);
 assert.equal(shotOf(readLedger(ledger),'s1').adopted.take,1);
});
test('restart: a take whose run call failed is re-sent with the SAME idempotency key and no new quote',async()=>{
 mock.director.failRunOnce=true;
 const {f,ledger}=planFile();
 const first=await cli(['shoot',f,'--ledger',ledger,'--shot','s1'],env());assert.equal(first.code,1);
 const t=shotOf(readLedger(ledger),'s1').takes[0];assert.equal(t.run_id,null);assert.equal(t.verdict,'pending');
 const again=await cli(['shoot',f,'--ledger',ledger,'--shot','s1'],env());assert.equal(again.code,0,again.stderr);
 const runs=posts('runs');assert.equal(runs.length,2);assert.equal(runs[0].body.idempotency_key,runs[1].body.idempotency_key);
 assert.equal(posts('quotes').length,1);
});
test('ledger lock: another process holding <ledger>.lock → exit 1 LEDGER_LOCKED, 0 requests; the lock is released after a run',async()=>{
 const {f,ledger}=planFile();writeFileSync(ledger+'.lock',String(process.pid)); // a live process holds it
 const r=await cli(['shoot',f,'--ledger',ledger],env());assert.equal(r.code,1);assert.equal(r.err.error.code,'LEDGER_LOCKED');assert.equal(mock.requests.length,0);
 const other=planFile();assert.equal((await cli(['shoot',other.f,'--ledger',other.ledger,'--shot','s1'],env())).code,0);
 assert.equal(existsSync(other.ledger+'.lock'),false);
});
test('a ledger for another plan or workspace is refused (LEDGER_MISMATCH), 0 requests',async()=>{
 const {f,ledger}=planFile();
 writeFileSync(ledger,JSON.stringify({schema_version:1,plan_sha256:'c'.repeat(64),project_id:'demo-ab',workspace_id:WS,credits:{max:300,quoted_total:0},shots:[]}));
 const r=await cli(['shoot',f,'--ledger',ledger],env());assert.equal(r.code,2);assert.equal(r.err.error.code,'LEDGER_MISMATCH');assert.equal(mock.requests.length,0);
});
test('M5: a plan with sources needs the matching breakdowns (SOURCES_REQUIRED), and lint errors stop it (LINT_FAILED); 0 requests',async()=>{
 const withSources=planFile(p=>{p.sources=[{source_id:'src-a',role:'A',breakdown_sha256:'a'.repeat(64),usable_for:'analysis_only'}];});
 const r=await cli(['shoot',withSources.f,'--ledger',withSources.ledger],env());assert.equal(r.code,2);assert.equal(r.err.error.code,'SOURCES_REQUIRED');
 const bad=planFile(p=>{p.scenes[0].story_time_min=60;});
 const b=await cli(['shoot',bad.f,'--ledger',bad.ledger],env());assert.equal(b.code,3);assert.equal(b.err.error.code,'LINT_FAILED');
 assert.equal(mock.requests.length,0);
});
test('--takes downloads each adopted take and checks it against the server sha256',async()=>{
 mock.director.outcomes={s1:[P]};
 const {f,ledger,dir}=planFile();const takes=join(dir,'takes');
 const r=await cli(['shoot',f,'--ledger',ledger,'--shot','s1','--takes',takes],env());assert.equal(r.code,0,r.stderr);
 const bytes=readFileSync(join(takes,'s1.mp4'));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),shotOf(readLedger(ledger),'s1').takes[0].output_sha256);
 const dl=mock.requests.find(q=>q.path.startsWith('/files/'));assert.equal(dl.authorization,null,'the signed link is fetched without the API key');
});

// ── counter-examples from an independent review (each reproduced before the fix) ──
const runsTo=r=>mock.requests.filter(q=>q.method==='POST'&&q.path===`/v1/recipes/${r}/runs`).length;
test('V1: resending a take whose run call failed is budget-checked too (a lower --max-credits stops it, exit 4)',async()=>{
 mock.director.failRunOnce=true;const {f,ledger}=planFile();
 assert.equal((await cli(['shoot',f,'--ledger',ledger,'--shot','s1','--max-credits','100'],env())).code,1);
 const r=await cli(['shoot',f,'--ledger',ledger,'--shot','s1','--max-credits','0'],env());
 assert.equal(r.code,4);assert.equal(r.err.error.code,'ABOVE_MAX_CREDITS');assert.equal(posts('runs').length,1,'no resend');
 assert.equal(shotOf(readLedger(ledger),'s1').status,'budget_stopped');
});
test('V2: the server route is recorded unchanged up to 64 code points; a longer one is not silently dropped',async()=>{
 const emoji='🎬'.repeat(33);mock.director.outcomes={s1:[{verdict:'passed',route:emoji}]};
 const a=planFile();assert.equal((await cli(['shoot',a.f,'--ledger',a.ledger,'--shot','s1'],env())).code,0);
 assert.equal(shotOf(readLedger(a.ledger),'s1').takes[0].route,emoji);
 mock.reset();mock.director.outcomes={s1:[{verdict:'passed',route:'r'.repeat(65)}]};
 const b=planFile();const r=await cli(['shoot',b.f,'--ledger',b.ledger,'--shot','s1'],env());
 assert.equal(r.code,1);assert.equal(r.err.error.code,'ACCEPTANCE_UNAVAILABLE');assert.equal(shotOf(readLedger(b.ledger),'s1').adopted,null);
});
test('V3: a pass without a valid output sha256 cannot be bound to bytes and is unavailable',async()=>{
 const {judge}=await import('../director/shoot.mjs');
 assert.equal(judge({state:'succeeded',acceptance:{verdict:'passed'}}).verdict,'unavailable');
 assert.equal(judge({state:'succeeded',acceptance:{verdict:'passed'},output_sha256:'A'.repeat(64)}).verdict,'unavailable');
 assert.equal(judge({state:'succeeded',acceptance:{verdict:'passed'},output_sha256:'a'.repeat(64)}).verdict,'passed');
});
test('V4: a ledger take made for another recipe is not resent to a new one (LEDGER_MISMATCH)',async()=>{
 mock.director.failRunOnce=true;const {f,ledger}=planFile(p=>{for(const s of p.shots)delete s.recipe_id;});
 assert.equal((await cli(['shoot',f,'--ledger',ledger,'--shot','s1','--recipe','recipe_one'],env())).code,1);
 const r=await cli(['shoot',f,'--ledger',ledger,'--shot','s1','--recipe','recipe_two'],env());
 assert.equal(r.code,2);assert.equal(r.err.error.code,'LEDGER_MISMATCH');assert.equal(runsTo('recipe_two'),0);
});
test('V5: a lock left by a process that no longer exists is taken over; a live holder still blocks',async()=>{
 const {f,ledger}=planFile();writeFileSync(ledger+'.lock','2147483646');
 const r=await cli(['shoot',f,'--ledger',ledger,'--shot','s1'],env());assert.equal(r.code,0,r.stderr);assert.equal(existsSync(ledger+'.lock'),false);
});
test('V6: malformed server answers after a request are INVALID_RESPONSE exit 1 (not exit 2), and the ledger stays valid',async()=>{
 mock.director.badRunId=true;const a=planFile();
 const r=await cli(['shoot',a.f,'--ledger',a.ledger,'--shot','s1'],env());assert.equal(r.code,1);assert.equal(r.err.error.code,'INVALID_RESPONSE');readLedger(a.ledger);
 mock.reset();mock.director.nullSnapshot=true;const b=planFile();
 const n=await cli(['shoot',b.f,'--ledger',b.ledger,'--shot','s1'],env());assert.equal(n.code,1);assert.equal(n.err.error.code,'INVALID_RESPONSE');readLedger(b.ledger);
});
test('V7: one error does not hide another; the budget message names the running total',async()=>{
 mock.director.outcomes={s1:[{verdict:'passed',acceptance:'absent'}]};
 const {f,ledger}=planFile();const r=await cli(['shoot',f,'--ledger',ledger,'--max-credits','40'],env());
 assert.equal(r.code,4);assert.match(r.err.error.message,/ACCEPTANCE_UNAVAILABLE[^;]*s1/);assert.match(r.err.error.message,/40 already quoted \+ 40/);
});
test('V5: Ctrl-C while waiting for a verdict removes the lock (exit 130)',async()=>{
 const {spawn}=await import('node:child_process');
 mock.director.outcomes={s1:[{verdict:'passed',polls:1000}]};const {f,ledger}=planFile();
 const child=spawn(process.execPath,['cli/nikuniku.mjs','shoot',f,'--ledger',ledger,'--shot','s1'],{env:{...process.env,...env(),NIKUNIKU_POLL_MS:'20'},stdio:'ignore'});
 for(let i=0;i<200&&!mock.requests.some(q=>q.path.startsWith('/v1/recipe-runs/'));i++)await new Promise(r=>setTimeout(r,20));
 assert.ok(existsSync(ledger+'.lock'),'lock held while waiting');
 const code=await new Promise(r=>{child.on('exit',(c,sig)=>r(c??sig));child.kill('SIGINT');});
 assert.equal(code,130);assert.equal(existsSync(ledger+'.lock'),false);
});

// ── an output folder that does not exist yet is created, not reported as a missing input ──
test('D1: run --out into a folder that does not exist yet creates it and finishes; shoot --ledger likewise',async()=>{
 const t=makeFixtures().takes;mock.director.files={s1:join(t,'s1.mp4'),s2:join(t,'s2.mp4')};
 const {f,dir}=planFile();const out=join(dir,'never','created','final.mp4');
 const r=await cli(['run',f,'--out',out],env());
 assert.equal(r.code,0,r.stderr);assert.equal(existsSync(out),true);
 assert.equal(existsSync(join(dir,'never','created','gacha-ledger.json')),true);
 // AC11: run's assemble step re-asks the server about every adopted run before cutting.
 assert.equal(r.json.data.assemble.server_accepted,true);assert.equal(r.json.data.assemble.server_acceptance,'checked_at_assemble');
 const checks=mock.requests.filter(q=>q.method==='GET'&&q.path.startsWith('/v1/recipe-runs/')).map(q=>q.path);
 assert.ok(checks.filter(p=>p==='/v1/recipe-runs/job_s1_1').length>=2,'s1 polled by shoot and checked again by assemble');
 mock.reset();const x=planFile(),ledger=join(x.dir,'new-dir','ledger.json');
 const s=await cli(['shoot',x.f,'--ledger',ledger,'--shot','s1'],env());
 assert.equal(s.code,0,s.stderr);readLedger(ledger);
});
