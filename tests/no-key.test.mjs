// AC11 (P2.7, SPEC §9): without an API key everything that only PREPARES runs locally (source, breakdown, plan, lint,
// whitebox); every command that would produce media or ask for a verdict (shoot, run, mv) exits 2 API_KEY_REQUIRED and
// sends nothing. A key the server rejects produces no film either. Precise assertions instead of REQUIREMENTS' "test $? -ne 0".
import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {start} from './mock-api.mjs';
import {makeFixtures} from '../scripts/make-fixtures.mjs';
import {cli,tmp} from './helpers.mjs';
let mock,video;
before(async()=>{mock=await start();video=makeFixtures().video;});after(()=>mock.server.close());beforeEach(()=>mock.reset());
const noKey=()=>({NIKUNIKU_API_BASE:mock.base,NIKUNIKU_API_KEY:'',NIKUNIKU_POLL_MS:'5'});
function planFile(){const p=JSON.parse(readFileSync('schemas/examples/plan.ab-merge.json','utf8'));p.sources=[];
 const dir=tmp(),f=join(dir,'plan.json');writeFileSync(f,JSON.stringify(p));return {dir,f};}

test('AC11: source, breakdown, plan, lint and whitebox complete without a key and send nothing',async()=>{
 const dir=tmp(),b=join(dir,'b.json'),brief=join(dir,'brief.txt');writeFileSync(brief,'x');
 const steps=[['source','--file',video,'--rights','owned','--source-lang','ja','--out',join(dir,'s.json')],['breakdown',video,'--out',b],
  ['plan','--a',b,'--brief',brief,'--plan-lang','ja','--project','p','--out',join(dir,'plan.json')],['lint','schemas/examples/plan.ab-merge.json'],
  ['whitebox','schemas/examples/plan.ab-merge.json','--shot','s1','--out',join(dir,'s1.svg')]];
 for(const s of steps){const r=await cli(s,noKey());assert.equal(r.code,0,`${s[0]}: ${r.stderr}`);}
 assert.equal(mock.requests.length,0);
});
test('AC11: shoot and run without a key → exit 2 API_KEY_REQUIRED, 0 requests, no film',async()=>{
 for(const cmd of ['shoot','run']){const x=planFile(),out=join(x.dir,'final.mp4');
  const r=await cli([cmd,x.f,'--ledger',join(x.dir,'l.json'),'--out',out],noKey());
  assert.equal(r.code,2,cmd);assert.equal(r.err.error.code,'API_KEY_REQUIRED',cmd);assert.equal(existsSync(out),false);}
 const short=planFile();const r=await cli(['run',short.f,'--out',join(short.dir,'f.mp4')],{...noKey(),NIKUNIKU_API_KEY:'short'});
 assert.equal(r.err.error.code,'API_KEY_REQUIRED','a malformed key is no key');
 assert.equal(mock.requests.length,0);
});
test('AC11: a key the server rejects → exit 1 with the server error, no film, no ledger take',async()=>{
 const x=planFile(),out=join(x.dir,'final.mp4');
 const r=await cli(['run',x.f,'--out',out],{...noKey(),NIKUNIKU_API_KEY:'nk_wrong_but_well_formed'});
 assert.equal(r.code,1);assert.equal(r.err.error.code,'KEY_INVALID');assert.equal(existsSync(out),false);
 assert.ok(!mock.requests.some(q=>q.path.endsWith('/runs')));
});
