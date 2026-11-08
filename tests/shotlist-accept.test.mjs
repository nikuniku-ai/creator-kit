// AC5 (P2.4, SPEC §3 S7): every shot declares `accept` before generation. A missing key is SCHEMA_INVALID, a null block
// is ACCEPT_REQUIRED; both exit 2 and the mock /v1 receives zero requests.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {start,KEY} from './mock-api.mjs';
import {cli,tmp} from './helpers.mjs';
let mock;
before(async()=>{mock=await start();});
after(()=>mock.server.close());
const env=()=>({NIKUNIKU_API_BASE:mock.base,NIKUNIKU_API_KEY:KEY,NIKUNIKU_POLL_MS:'5'});
function planFile(edit){const p=JSON.parse(readFileSync('schemas/examples/plan.ab-merge.json','utf8'));p.sources=[];edit?.(p);
 const dir=tmp(),f=join(dir,'plan.json');writeFileSync(f,JSON.stringify(p));return {dir,f};}

test('AC5: a shot whose accept is null is refused before any request, naming the shot',async()=>{
 const {dir,f}=planFile(p=>{p.shots[1].accept=null;});mock.reset();
 const r=await cli(['shoot',f,'--ledger',join(dir,'l.json')],env());
 assert.equal(r.code,2,r.stderr);assert.equal(r.err.error.code,'ACCEPT_REQUIRED');assert.match(r.err.error.message,/\bs2\b/);
 assert.equal(mock.requests.length,0);
});
test('AC5: a shot without the accept key is SCHEMA_INVALID, also before any request',async()=>{
 const {dir,f}=planFile(p=>{delete p.shots[0].accept;});mock.reset();
 const r=await cli(['shoot',f,'--ledger',join(dir,'l.json')],env());
 assert.equal(r.code,2);assert.equal(r.err.error.code,'SCHEMA_INVALID');assert.equal(mock.requests.length,0);
});
test('AC5: with every shot accepted the plan is sent; --shot only checks the shots it shoots',async()=>{
 const ok=planFile();mock.reset();
 const r=await cli(['shoot',ok.f,'--ledger',join(ok.dir,'l.json')],env());
 assert.equal(r.code,0,r.stderr);assert.ok(mock.requests.some(q=>q.path.endsWith('/runs')));
 const one=planFile(p=>{p.shots[1].accept=null;});
 const r1=await cli(['shoot',one.f,'--ledger',join(one.dir,'l.json'),'--shot','s1'],env());
 assert.equal(r1.code,0,r1.stderr);
});
