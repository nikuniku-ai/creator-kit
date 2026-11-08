// AC1 (P2.7, SPEC §1): the director commands talk only to NIKUNIKU_API_BASE. A take's signed link must be on the API's
// host (or *.nikuniku.ai when the API is there); anything else is HOST_REFUSED with nothing written; links are fetched
// without the key and redirects are never followed.
import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {start,KEY} from './mock-api.mjs';
import {cli,tmp} from './helpers.mjs';
import {linkAllowed} from '../director/net.mjs';
import {apiBase} from '../client/nikuniku-api.mjs';
let mock;before(async()=>{mock=await start();});after(()=>mock.server.close());beforeEach(()=>mock.reset());
const env=()=>({NIKUNIKU_API_BASE:mock.base,NIKUNIKU_API_KEY:KEY,NIKUNIKU_POLL_MS:'5'});
function planFile(){const p=JSON.parse(readFileSync('schemas/examples/plan.ab-merge.json','utf8'));p.sources=[];
 const dir=tmp(),f=join(dir,'plan.json');writeFileSync(f,JSON.stringify(p));return {dir,f,ledger:join(dir,'l.json'),takes:join(dir,'takes')};}

test('AC1: a whole shoot (quotes, runs, polls, downloads) only reaches the mock API host',async()=>{
 const {shoot}=await import('../director/shoot.mjs');const seen=[],real=globalThis.fetch;
 globalThis.fetch=(url,init)=>{seen.push(String(url));return real(url,init);};
 try{const x=planFile();
  const r=await shoot({positional:[x.f],ledger:x.ledger,takes:x.takes,apiKey:KEY,apiBase:apiBase(mock.base)});
  assert.equal(r.result.ok,true,JSON.stringify(r.result));}
 finally{globalThis.fetch=real;}
 assert.ok(seen.length>=8,`${seen.length} requests`);
 for(const u of seen)assert.equal(new URL(u).origin,mock.base,u);
});
test('AC1: an output link on another host → exit 1 HOST_REFUSED, the take is not written, that host is never contacted',async()=>{
 mock.director.outputHost='https://cdn.example.com';
 const x=planFile();const r=await cli(['shoot',x.f,'--ledger',x.ledger,'--shot','s1','--takes',x.takes],env());
 assert.equal(r.code,1);assert.equal(r.err.error.code,'HOST_REFUSED');
 assert.ok(!existsSync(x.takes)||readdirSync(x.takes).length===0);
});
test('AC1: a redirecting output link is not followed (DOWNLOAD_FAILED) and the key never goes to the link',async()=>{
 mock.director.redirectFiles=mock.base+'/v1/me';
 const x=planFile();const r=await cli(['shoot',x.f,'--ledger',x.ledger,'--shot','s1','--takes',x.takes],env());
 assert.equal(r.code,1);assert.equal(r.err.error.code,'DOWNLOAD_FAILED');
 const files=mock.requests.filter(q=>q.path.startsWith('/files/'));assert.equal(files.length,1);assert.equal(files[0].authorization,null);
 assert.equal(mock.requests.filter(q=>q.path==='/v1/me').length,1,'only the workspace lookup, not the redirect target');
});
test('AC1: which output links are allowed',()=>{
 const prod=apiBase('https://api.nikuniku.ai'),local=apiBase('http://127.0.0.1:8787');
 assert.equal(linkAllowed(prod,'https://api.nikuniku.ai/x'),true);
 assert.equal(linkAllowed(prod,'https://media.nikuniku.ai/x'),true);
 assert.equal(linkAllowed(prod,'https://nikuniku.ai.evil.com/x'),false);
 assert.equal(linkAllowed(prod,'https://evilnikuniku.ai/x'),false);
 assert.equal(linkAllowed(prod,'http://media.nikuniku.ai/x'),false,'plain http');
 assert.equal(linkAllowed(prod,'https://user:pw@media.nikuniku.ai/x'),false,'credentials in the link');
 assert.equal(linkAllowed(apiBase('https://staging.example.com'),'https://media.nikuniku.ai/x'),false,'the *.nikuniku.ai rule only applies when the API is on nikuniku.ai');
 assert.equal(linkAllowed(local,'http://127.0.0.1:8787/f'),true);assert.equal(linkAllowed(local,'http://127.0.0.1:9999/f'),false,'another local service');
 assert.equal(linkAllowed(local,'http://localhost:8787/f'),false);
 assert.equal(linkAllowed(prod,'https://api.nikuniku.ai:8443/x'),false,'another port on the API host');assert.equal(linkAllowed(prod,'https://media.nikuniku.ai:8443/x'),false);
});
test('AC1: inside director/ only net.mjs calls fetch (everything else goes through the shared /v1 client)',()=>{
 const users=readdirSync('director').filter(f=>/\bfetch\(/.test(readFileSync(join('director',f),'utf8')));
 assert.deepEqual(users,['net.mjs']);
});

test('AC1: a link whose sha256 differs from the run, or bytes that differ from both, are refused and nothing is written',async()=>{
 for(const flag of ['badLinkSha','tamperFiles']){mock.reset();mock.director[flag]=true;
  const x=planFile();const r=await cli(['shoot',x.f,'--ledger',x.ledger,'--shot','s1','--takes',x.takes],env());
  assert.equal(r.code,1,flag);assert.equal(r.err.error.code,'SHA256_MISMATCH',flag);
  assert.ok(!existsSync(x.takes)||readdirSync(x.takes).length===0,flag);}
});
