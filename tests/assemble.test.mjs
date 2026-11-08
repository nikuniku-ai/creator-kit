// AC8 (P2.6, SPEC §3 S10): only adopted takes whose file matches the server sha256 are cut together (hard cuts, stream
// copy); the QaReceipt binds the output sha256, the EDL sha256 and every take; --verify fails on a single changed byte.
import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,copyFileSync,existsSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {makeFixtures} from '../scripts/make-fixtures.mjs';
import {validate} from '../director/jsonschema.mjs';
import {semantics} from '../director/semantics.mjs';
import {cli,tmp} from './helpers.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const schema=n=>JSON.parse(readFileSync(`schemas/${n}.schema.json`,'utf8'));
const valid=(n,v)=>assert.deepEqual([...validate(schema(n),v),...semantics(n,v)],[],n);
let fixtures;
before(()=>{fixtures=makeFixtures().takes;});

// A plan, its takes and a ledger in which the server adopted s1 take 2 and s2 take 1.
function project({edit,ledgerEdit}={}){
 const dir=tmp(),takes=join(dir,'takes');mkdirSync(takes);
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
const assemble=x=>cli(['assemble',x.planFile,'--ledger',x.ledgerFile,'--takes',x.takes,'--out',x.out],{NIKUNIKU_API_KEY:''});

test('AC8: assemble writes the film, an EDL and a receipt whose hash is the film sha256; --verify passes',async()=>{
 const x=project();const r=await assemble(x);assert.equal(r.code,0,r.stderr);
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
 const x=project();assert.equal((await assemble(x)).code,0);
 const film=readFileSync(x.out);film[film.length-1]^=1;writeFileSync(x.out,film);
 const v=await cli(['assemble','--verify',join(x.dir,'out','qa-receipt.json')]);
 assert.equal(v.code,3);assert.equal(v.err.error.code,'RECEIPT_MISMATCH');
});
test('--verify also catches an edited EDL and, with --takes, an edited take',async()=>{
 const x=project();assert.equal((await assemble(x)).code,0);const dir=join(x.dir,'out');
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
 const x=project();const f=join(x.takes,'s1.mp4'),b=readFileSync(f);b[50]^=1;writeFileSync(f,b);
 const r=await assemble(x);assert.equal(r.code,3);assert.equal(r.err.error.code,'TAKE_FILE_MISMATCH');assert.equal(existsSync(x.out),false);
});
test('a ledger for another plan → exit 2 LEDGER_MISMATCH',async()=>{
 const x=project();writeFileSync(x.planFile,readFileSync(x.planFile,'utf8').replace('"revision":1','"revision":2'));
 const r=await assemble(x);assert.equal(r.code,2);assert.equal(r.err.error.code,'LEDGER_MISMATCH');
});
test('--verify: each EDL check stands alone — re-formatted bytes (sha) and a re-hashed edit (entry ↔ receipt)',async()=>{
 const x=project();assert.equal((await assemble(x)).code,0);const dir=join(x.dir,'out'),edlPath=join(dir,'edl.json'),rPath=join(dir,'qa-receipt.json');
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
 for(const [why,edit] of forged){const x=project();const l=JSON.parse(readFileSync(x.ledgerFile,'utf8'));edit(l);writeFileSync(x.ledgerFile,JSON.stringify(l));
  const r=await assemble(x);assert.equal(r.code,2,`${why}: ${r.stderr}`);assert.equal(r.err.error.code,'SCHEMA_INVALID',why);
  assert.equal(existsSync(join(x.dir,'out')),false,why);}
});
