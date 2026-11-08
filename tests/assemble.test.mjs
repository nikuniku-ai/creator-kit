// AC8 (SPEC §3 S10): only adopted takes whose file matches the server sha256 are cut together (hard cuts, stream
// copy); the QaReceipt binds the output sha256, the EDL sha256 and every take; --verify fails on a single changed byte.
import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,copyFileSync,existsSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {makeFixtures} from '../scripts/make-fixtures.mjs';
import {validate} from '../director/jsonschema.mjs';
import {semantics} from '../director/semantics.mjs';
import {cli,tmp} from './helpers.mjs';
import {projectShot} from '../director/shoot.mjs';
import {start,KEY} from './mock-api.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const schema=n=>JSON.parse(readFileSync(`schemas/${n}.schema.json`,'utf8'));
const valid=(n,v)=>assert.deepEqual([...validate(schema(n),v),...semantics(n,v)],[],n);
let fixtures,mock;
before(async()=>{fixtures=makeFixtures().takes;mock=await start();});after(()=>mock.server.close());beforeEach(()=>mock.reset());
const env=()=>({NIKUNIKU_API_BASE:mock.base,NIKUNIKU_API_KEY:KEY});
// The server side of a ledger: every adopted take is a run the mock knows, passed, with these take files as its output.
// The recipe is the plan shot's recipe_id (the example plan: white_studio_single), as shoot sends it.
// Each run echoes the inputs shoot sent for it (the shot's projection, the plan sha256, the take number).
function serve(x,outcome={verdict:'passed'},{recipe='white_studio_single',files,plan=x.planFile}={}){
 const l=JSON.parse(readFileSync(x.ledgerFile,'utf8')),p=JSON.parse(readFileSync(plan,'utf8')),planSha=sha(readFileSync(plan));
 for(const s of l.shots)if(s.adopted){mock.director.files[s.shot_id]=files?.[s.shot_id]??join(x.takes,s.shot_id+'.mp4');
  const inputs={shot_json:JSON.stringify(projectShot(p.shots.find(v=>v.id===s.shot_id))),plan_sha256:planSha,take:String(s.adopted.take)};
  mock.runs.set(s.adopted.run_id,{public:{run_id:s.adopted.run_id,job_id:s.adopted.job_id,state:'queued',recipe_id:recipe,recipe_version:'1'},shot:s.shot_id,take:s.adopted.take,outcome,polls:0,workspace:l.workspace_id,inputs});}
 return x;
}

// A plan, its takes and a ledger in which the server adopted s1 take 2 and s2 take 1.
function project({edit,ledgerEdit,takesDir}={}){
 const dir=tmp(),takes=takesDir?takesDir(dir):join(dir,'takes');mkdirSync(takes,{recursive:true});
 const p=JSON.parse(readFileSync('schemas/examples/plan.ab-merge.json','utf8'));p.sources=[];edit?.(p);
 const planFile=join(dir,'plan.json');writeFileSync(planFile,JSON.stringify(p));
 for(const s of ['s1','s2'])copyFileSync(join(fixtures,s+'.mp4'),join(takes,s+'.mp4'));
 const h=s=>sha(readFileSync(join(takes,s+'.mp4')));
 const t=(n,verdict,shot,extra={})=>({take:n,idempotency_key:`dk-${shot}${n}`,quote_id:`q_${shot}${n}`,quoted_units:40,run_id:`job_${shot}_${n}`,job_id:`job_${shot}_${n}`,
  verdict,failure_class:verdict==='failed'?'framing':null,route:'general',charged_units:verdict==='passed'?40:null,output_sha256:verdict==='passed'?h(shot):null,...extra});
 const ledger={schema_version:1,plan_sha256:sha(readFileSync(planFile)),project_id:p.project_id,workspace_id:'ws_000000000000000000000001',credits:{max:300,quoted_total:120},
  shots:[{shot_id:'s1',status:'adopted',adopted:{take:2,job_id:'job_s1_2',run_id:'job_s1_2'},takes:[t(1,'failed','s1'),t(2,'passed','s1')]},
         {shot_id:'s2',status:'adopted',adopted:{take:1,job_id:'job_s2_1',run_id:'job_s2_1'},takes:[t(1,'passed','s2')]}]};
 ledgerEdit?.(ledger);valid('gacha-ledger',ledger);
 const ledgerFile=join(dir,'ledger.json');writeFileSync(ledgerFile,JSON.stringify(ledger));
 return {dir,planFile,ledgerFile,takes,out:join(dir,'out','final.mp4')};
}
const assemble=(x,e=env())=>cli(['assemble',x.planFile,'--ledger',x.ledgerFile,'--takes',x.takes,'--out',x.out],e);

test('AC8: assemble writes the film, an EDL and a receipt whose hash is the film sha256; --verify passes',async()=>{
 const x=serve(project());const r=await assemble(x);assert.equal(r.code,0,r.stderr);
 const dir=join(x.dir,'out'),receipt=JSON.parse(readFileSync(join(dir,'qa-receipt.json'),'utf8')),edl=JSON.parse(readFileSync(join(dir,'edl.json'),'utf8'));
 valid('qa-receipt',receipt);valid('edl',edl);
 assert.equal(receipt.output_sha256,sha(readFileSync(x.out)));assert.equal(receipt.output_bytes,readFileSync(x.out).length);
 assert.equal(receipt.edl_sha256,sha(readFileSync(join(dir,'edl.json'))));
 assert.deepEqual(edl.entries.map(e=>[e.shot_id,e.job_id]),[['s1','job_s1_2'],['s2','job_s2_1']]);
 assert.ok(Math.abs(edl.total_ms-2000)<=200,`total ${edl.total_ms}`);
 assert.deepEqual(receipt.takes.map(t=>t.sha256),edl.entries.map(e=>e.sha256));
 const v=await cli(['assemble','--verify',join(dir,'qa-receipt.json'),'--takes',x.takes]);assert.equal(v.code,0,v.stderr);
});
test('AC8: one changed byte in the film → --verify exit 3 RECEIPT_MISMATCH',async()=>{
 const x=serve(project());assert.equal((await assemble(x)).code,0);
 const film=readFileSync(x.out);film[film.length-1]^=1;writeFileSync(x.out,film);
 const v=await cli(['assemble','--verify',join(x.dir,'out','qa-receipt.json')]);
 assert.equal(v.code,3);assert.equal(v.err.error.code,'RECEIPT_MISMATCH');
});
test('--verify also catches an edited EDL and, with --takes, an edited take',async()=>{
 const x=serve(project());assert.equal((await assemble(x)).code,0);const dir=join(x.dir,'out');
 const edlPath=join(dir,'edl.json'),edl=readFileSync(edlPath,'utf8');
 writeFileSync(edlPath,edl.replace('job_s2_1','job_s2_9'));
 assert.equal((await cli(['assemble','--verify',join(dir,'qa-receipt.json')])).code,3);
 writeFileSync(edlPath,edl);assert.equal((await cli(['assemble','--verify',join(dir,'qa-receipt.json')])).code,0);
 const take=readFileSync(join(x.takes,'s2.mp4'));take[100]^=1;writeFileSync(join(x.takes,'s2.mp4'),take);
 assert.equal((await cli(['assemble','--verify',join(dir,'qa-receipt.json')])).code,0,'without --takes the takes are not re-read');
 const v=await cli(['assemble','--verify',join(dir,'qa-receipt.json'),'--takes',x.takes]);assert.equal(v.code,3);assert.equal(v.err.error.code,'RECEIPT_MISMATCH');
});
test('a shot without an adopted take → exit 3 TAKE_NOT_ACCEPTED and nothing is written',async()=>{
 const x=project({ledgerEdit:l=>{l.shots[1]={shot_id:'s2',status:'exhausted',adopted:null,takes:[{...l.shots[1].takes[0],verdict:'failed',failure_class:'framing',output_sha256:null,charged_units:null}]};}});
 const r=await assemble(x);assert.equal(r.code,3);assert.equal(r.err.error.code,'TAKE_NOT_ACCEPTED');assert.match(r.err.error.message,/\bs2\b/);
 assert.equal(existsSync(join(x.dir,'out')),false);
});
test('a take file that differs from the server sha256 → exit 3 TAKE_FILE_MISMATCH, nothing written',async()=>{
 const x=serve(project());const f=join(x.takes,'s1.mp4'),b=readFileSync(f);b[50]^=1;writeFileSync(f,b);
 const r=await assemble(x);assert.equal(r.code,3);assert.equal(r.err.error.code,'TAKE_FILE_MISMATCH');assert.equal(existsSync(x.out),false);
});
test('a ledger for another plan → exit 2 LEDGER_MISMATCH',async()=>{
 const x=serve(project());writeFileSync(x.planFile,readFileSync(x.planFile,'utf8').replace('"revision":1','"revision":2'));
 const r=await assemble(x);assert.equal(r.code,2);assert.equal(r.err.error.code,'LEDGER_MISMATCH');
});
test('--verify: each EDL check stands alone — re-formatted bytes (sha) and a re-hashed edit (entry ↔ receipt)',async()=>{
 const x=serve(project());assert.equal((await assemble(x)).code,0);const dir=join(x.dir,'out'),edlPath=join(dir,'edl.json'),rPath=join(dir,'qa-receipt.json');
 const edl=readFileSync(edlPath,'utf8');
 writeFileSync(edlPath,JSON.stringify(JSON.parse(edl)));            // same content, other bytes: only the sha256 check sees it
 let v=await cli(['assemble','--verify',rPath]);assert.equal(v.code,3);assert.match(v.err.error.message,/EDL sha256 differs/);
 const edited=edl.replace('job_s2_1','job_s2_9');writeFileSync(edlPath,edited);
 const receipt=JSON.parse(readFileSync(rPath,'utf8'));receipt.edl_sha256=sha(Buffer.from(edited));writeFileSync(rPath,JSON.stringify(receipt));
 v=await cli(['assemble','--verify',rPath]);assert.equal(v.code,3);assert.match(v.err.error.message,/EDL entry 1 \(s2\) differs from the receipt/);
});

// AC11 (2026-11-08 clarification): without a key assemble may only cut takes the server passed and whose file sha256
// equals the sha256 the server reported. The ledger's semantics (checked on read) are what refuse a hand-edited ledger
// that marks a failed or unverdicted take as adopted; assemble itself only has to find the adopted take.
test('AC11: a ledger that adopts a take the server did not pass is refused (SCHEMA_INVALID) and nothing is written',async()=>{
 const forged=[
  ['adopted points at the failed take',l=>{l.shots[0].adopted={take:1,job_id:'job_s1_1',run_id:'job_s1_1'};}],
  ['the adopted take has no verdict',l=>{Object.assign(l.shots[1].takes[0],{verdict:null});}],
  ['adopted on a shot whose status is not adopted',l=>{l.shots[1].status='exhausted';}],
 ];
 for(const [why,edit] of forged){const x=serve(project());const l=JSON.parse(readFileSync(x.ledgerFile,'utf8'));edit(l);writeFileSync(x.ledgerFile,JSON.stringify(l));
  const r=await assemble(x);assert.equal(r.code,2,`${why}: ${r.stderr}`);assert.equal(r.err.error.code,'SCHEMA_INVALID',why);
  assert.equal(existsSync(join(x.dir,'out')),false,why);}
});

// AC11: assemble needs a valid key and, before cutting, asks the server
// (GET /v1/recipe-runs/{run_id}) about every adopted take: passed, and the server's output sha256 equals the file.
// A self-consistent ledger the server never issued, a take the server did not pass, a sha256 the server does not report,
// or no key → refused with its own code and nothing is written. verify only proves cut integrity: never "accepted".
const NOT_VERIFIED=/not verified by nikuniku/i;
function forgedProject(){
 return project({ledgerEdit:l=>{for(const s of l.shots){for(const t of s.takes){t.job_id=t.run_id=`never_server_${s.shot_id}_${t.take}`;}
  s.adopted.job_id=s.adopted.run_id=`never_server_${s.shot_id}_${s.adopted.take}`;}}});
}
const runChecks=()=>mock.requests.filter(q=>q.method==='GET'&&q.path.startsWith('/v1/recipe-runs/'));
test('AC11: a self-consistent ledger the server never issued → exit 3 SERVER_RUN_NOT_FOUND, nothing written',async()=>{
 const x=forgedProject();const r=await assemble(x);
 assert.equal(r.code,3,r.stderr);assert.equal(r.err.error.code,'SERVER_RUN_NOT_FOUND');assert.match(r.err.error.message,/never_server_s1_2/);
 assert.equal(existsSync(join(x.dir,'out')),false);
 assert.ok(runChecks().length>=1,'the server was asked');
});
test('AC11: assemble without a key, or with a malformed one → exit 2 API_KEY_REQUIRED, 0 requests, nothing written',async()=>{
 for(const key of ['','short']){const x=serve(project());const r=await assemble(x,{...env(),NIKUNIKU_API_KEY:key});
  assert.equal(r.code,2,key);assert.equal(r.err.error.code,'API_KEY_REQUIRED',key);assert.equal(existsSync(join(x.dir,'out')),false,key);}
 assert.equal(mock.requests.length,0);
});
test('AC11: a key the server rejects → non-zero, the server error, nothing written',async()=>{
 const x=serve(project());const r=await assemble(x,{...env(),NIKUNIKU_API_KEY:'nk_wrong_but_well_formed'});
 assert.equal(r.code,1);assert.equal(r.err.error.code,'KEY_INVALID');assert.equal(existsSync(join(x.dir,'out')),false);
});
test('AC11: the server did not pass the adopted take (failed, still pending, no acceptance) → exit 3 SERVER_NOT_PASSED, nothing written',async()=>{
 for(const outcome of [{verdict:'failed',failure_class:'framing'},{verdict:'pending'},{verdict:'passed',acceptance:'absent'}]){
  mock.reset();const x=serve(project(),outcome);const r=await assemble(x);
  assert.equal(r.code,3,JSON.stringify(outcome));assert.equal(r.err.error.code,'SERVER_NOT_PASSED',JSON.stringify(outcome));
  assert.equal(existsSync(join(x.dir,'out')),false);}
});
test('AC11: the server passed it but reports another sha256 than the file → exit 3 SERVER_SHA_MISMATCH, nothing written',async()=>{
 const x=serve(project());mock.director.files.s2=join(x.takes,'s1.mp4');
 const r=await assemble(x);assert.equal(r.code,3);assert.equal(r.err.error.code,'SERVER_SHA_MISMATCH');assert.match(r.err.error.message,/\bs2\b/);
 assert.equal(existsSync(join(x.dir,'out')),false);
});
test('AC11: a ledger the server confirms is cut; every adopted run was checked in the ledger workspace',async()=>{
 const x=serve(project());const r=await assemble(x);assert.equal(r.code,0,r.stderr);
 assert.deepEqual(runChecks().map(q=>q.url),['/v1/recipe-runs/job_s1_2?workspace_id=ws_000000000000000000000001','/v1/recipe-runs/job_s2_1?workspace_id=ws_000000000000000000000001']);
 assert.ok(runChecks().every(q=>q.authorization===`Bearer ${KEY}`));
 assert.equal(r.json.data.server_accepted,true);assert.equal(r.json.data.server_acceptance,'checked_at_assemble');
 assert.doesNotMatch(r.stderr,NOT_VERIFIED);
});

// AC11: the bytes the server confirmed must be the bytes that are cut, and the run the
// server confirmed must be this shot's run of this shot's recipe.
const framemd5=f=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i',f,'-map','0:v','-f','framemd5','-'],{encoding:'utf8'}).split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').pop().trim());
test('AC11: a take swapped while the server is being asked is not what gets cut (the hashed bytes are the cut bytes)',async()=>{
 const x=project(),pristine=join(x.dir,'pristine-s2.mp4');copyFileSync(join(x.takes,'s2.mp4'),pristine);serve(x,undefined,{files:{s2:pristine}});
 const swap=req=>{if(req.url.startsWith('/v1/recipe-runs/job_s2_1'))copyFileSync(join(fixtures,'s1.mp4'),join(x.takes,'s2.mp4'));};
 mock.server.prependListener('request',swap);
 try{const r=await assemble(x);assert.equal(r.code,0,r.stderr);}finally{mock.server.removeListener('request',swap);}
 const film=framemd5(x.out),honest=framemd5(pristine);
 assert.ok(honest.every(m=>film.includes(m)),'the film holds the bytes the server confirmed');
 assert.equal(film.length,framemd5(join(fixtures,'s1.mp4')).length+honest.length);
});
test('AC11: a --takes path with a newline cannot inject another file into the cut',async()=>{
 let D;const x=project({takesDir:dir=>{D=dir;return join(dir,`x\nfile ${dir}/evil.mp4\n#`);}});
 copyFileSync(join(fixtures,'s1.mp4'),join(D,'evil.mp4'));copyFileSync(join(fixtures,'s1.mp4'),join(D,'x'));serve(x);
 const r=await assemble(x);
 if(r.code===0){const film=framemd5(x.out),want=[...framemd5(join(x.takes,'s1.mp4')),...framemd5(join(x.takes,'s2.mp4'))];
  assert.deepEqual(film,want,'only the two checked takes, in order');}
 else{assert.equal(r.code,2);assert.equal(r.err.error.code,'USAGE');assert.equal(existsSync(join(x.dir,'out')),false);}
});
test('AC11: the server run must be this take: another run id/job id, another recipe, or one run adopted twice → exit 3 SERVER_RUN_MISMATCH',async()=>{
 const cases=[
  ['run of another recipe',()=>serve(project(),undefined,{recipe:'some_cheap_recipe'})],
  ['server answers with another job_id',()=>{const x=serve(project());mock.runs.get('job_s2_1').public.job_id='job_other';return x;}],
  ['s2 adopts the s1 run',()=>{const x=project({ledgerEdit:l=>{const t=l.shots[1].takes[0];t.run_id=t.job_id='job_s1_2';l.shots[1].adopted.run_id=l.shots[1].adopted.job_id='job_s1_2';}});
   copyFileSync(join(x.takes,'s1.mp4'),join(x.takes,'s2.mp4'));
   const l=JSON.parse(readFileSync(x.ledgerFile,'utf8'));l.shots[1].takes[0].output_sha256=sha(readFileSync(join(x.takes,'s2.mp4')));writeFileSync(x.ledgerFile,JSON.stringify(l));
   serve(x);return x;}],
 ];
 for(const [why,make] of cases){mock.reset();const x=make();const r=await assemble(x);
  assert.equal(r.code,3,`${why}: ${r.stderr}`);assert.equal(r.err.error.code,'SERVER_RUN_MISMATCH',why);assert.equal(existsSync(join(x.dir,'out')),false,why);}
});
// AC11: the server's run must have been made for THIS shot of THIS plan in THIS
// workspace. Real runs of another shot or another plan are refused, and so is a snapshot that does not say (fail closed).
function swapRuns(x){const l=JSON.parse(readFileSync(x.ledgerFile,'utf8')),[a,b]=l.shots,ta=a.takes.find(t=>t.take===a.adopted.take),tb=b.takes.find(t=>t.take===b.adopted.take);
 for(const k of ['run_id','job_id','output_sha256'])[ta[k],tb[k]]=[tb[k],ta[k]];
 a.adopted={...a.adopted,run_id:ta.run_id,job_id:ta.job_id};b.adopted={...b.adopted,run_id:tb.run_id,job_id:tb.job_id};
 const f1=readFileSync(join(x.takes,'s1.mp4')),f2=readFileSync(join(x.takes,'s2.mp4'));writeFileSync(join(x.takes,'s1.mp4'),f2);writeFileSync(join(x.takes,'s2.mp4'),f1);
 writeFileSync(x.ledgerFile,JSON.stringify(l));}
test('AC11: real runs swapped between shots, or real runs of another plan, or another workspace → refused, nothing written',async()=>{
 const cases=[
  ['runs swapped between s1 and s2','SERVER_RUN_MISMATCH',()=>{const x=serve(project());swapRuns(x);return x;}],
  ['the runs were made for another plan','SERVER_RUN_MISMATCH',()=>{const x=project({edit:p=>{p.shots[0].action='a shot the server never generated';}});
   const other=join(x.dir,'plan-a.json'),p=JSON.parse(readFileSync(x.planFile,'utf8'));p.shots[0].action=JSON.parse(readFileSync('schemas/examples/plan.ab-merge.json','utf8')).shots[0].action;
   writeFileSync(other,JSON.stringify(p));return serve(x,undefined,{plan:other});}],
  ['same shots, but the runs were made for another revision of the plan','SERVER_RUN_MISMATCH',()=>{const x=project(),other=join(x.dir,'plan-r2.json');
   writeFileSync(other,readFileSync(x.planFile,'utf8').replace('"revision":1','"revision":2'));return serve(x,undefined,{plan:other});}],
  ['the snapshot does not echo its inputs','SERVER_RUN_MISMATCH',()=>{const x=serve(project());for(const r of mock.runs.values())delete r.inputs;return x;}],
  ['the ledger names another workspace','SERVER_RUN_NOT_FOUND',()=>{const x=serve(project());for(const r of mock.runs.values())r.workspace='ws_999999999999999999999999';return x;}],
  ['the server describes another run_id','SERVER_RUN_MISMATCH',()=>{const x=serve(project());mock.runs.get('job_s2_1').public.run_id='job_s2_9';return x;}],
 ];
 for(const [why,code,make] of cases){mock.reset();const x=make();const r=await assemble(x);
  assert.equal(r.code,3,`${why}: ${r.stderr}`);assert.equal(r.err.error.code,code,why);assert.equal(existsSync(join(x.dir,'out')),false,why);}
});
test('AC11: every refused take is named, not only the first kind of problem',async()=>{
 const x=serve(project());mock.runs.get('job_s1_2').outcome={state:'cancelled'};mock.runs.delete('job_s2_1');
 const r=await assemble(x);assert.equal(r.code,3);assert.match(r.err.error.message,/\bs1\b/);assert.match(r.err.error.message,/\bs2\b/);
});
test('AC11: the output names the server that confirmed the cut',async()=>{
 const x=serve(project());const r=await assemble(x);assert.equal(r.code,0,r.stderr);assert.equal(r.json.data.checked_by,mock.base);
});
test('AC11: verify checks integrity but never reports the cut as server-accepted',async()=>{
 const x=serve(project());assert.equal((await assemble(x)).code,0);const rPath=join(x.dir,'out','qa-receipt.json');
 mock.reset();
 const v=await cli(['assemble','--verify',rPath,'--takes',x.takes]);assert.equal(v.code,0,v.stderr);
 assert.equal(v.json.data.server_accepted,false);assert.equal(v.json.data.server_acceptance,'unverified');
 assert.match(v.stderr,NOT_VERIFIED);assert.doesNotMatch(v.stderr,/Film assembled/,'verify does not claim it assembled anything');
 const zh=await cli(['assemble','--verify',rPath,'--lang','zh-Hant']);assert.equal(zh.code,0);assert.match(zh.stderr,/未經 nikuniku 驗收/);
 assert.equal(mock.requests.length,0,'verify is offline');
});
test('verify without --takes does not claim the takes were checked',async()=>{
 const x=serve(project());assert.equal((await assemble(x)).code,0);const rPath=join(x.dir,'out','qa-receipt.json');
 const v=await cli(['assemble','--verify',rPath]);assert.equal(v.code,0);assert.equal(v.json.data.checked_takes,false);
 assert.doesNotMatch(v.stderr.split('\n')[0],/takes match/i);assert.match(v.stderr.split('\n')[0],/not re-read/);
 const t=await cli(['assemble','--verify',rPath,'--takes',x.takes]);assert.match(t.stderr.split('\n')[0],/takes match/i);
});
test('AC11: a receipt edited to claim server acceptance is refused by verify, not reported as accepted',async()=>{
 const x=serve(project());assert.equal((await assemble(x)).code,0);const rPath=join(x.dir,'out','qa-receipt.json');
 for(const claim of ['verified','signed',true]){
  const receipt=JSON.parse(readFileSync(rPath,'utf8'));writeFileSync(rPath+'.claim.json',JSON.stringify({...receipt,server_acceptance:claim}));
  const v=await cli(['assemble','--verify',rPath+'.claim.json']);assert.notEqual(v.code,0,String(claim));assert.equal(v.json?.data?.server_accepted,undefined,String(claim));}
 const receipt=JSON.parse(readFileSync(rPath,'utf8'));delete receipt.server_acceptance;writeFileSync(rPath+'.none.json',JSON.stringify(receipt));
 assert.notEqual((await cli(['assemble','--verify',rPath+'.none.json'])).code,0,'a receipt without the label is not trusted either');
});
