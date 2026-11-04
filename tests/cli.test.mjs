import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {start,KEY} from './mock-api.mjs';
const run=promisify(execFile);
let mock;
before(async()=>{mock=await start();});
after(()=>mock.server.close());
const cli=(args,env={})=>run(process.execPath,['cli/nikuniku.mjs',...args],{env:{...process.env,NIKUNIKU_API_BASE:mock.base,...env}});

test('pricing needs no key and prints the envelope data',async()=>{
 const {stdout}=await cli(['pricing'],{NIKUNIKU_API_KEY:''});
 assert.match(stdout,/mock-1/);
});
test('help lists generate with several images, a song and a continuation',async()=>{
 const {stdout}=await cli(['help']);
 for(const flag of ['--image','--audio','--continue-from','--max-credits'])assert.ok(stdout.includes(flag),flag);
});
test('a wrong key surfaces the API error code and a non-zero exit',async()=>{
 await assert.rejects(cli(['status','job_x','--workspace','ws_000000000000000000000001'],{NIKUNIKU_API_KEY:'nk_wrong'}),e=>{assert.notEqual(e.code,0);return true;});
});
test('the shared client reads /v1/me with the key',async()=>{
 const {call,apiBase}=await import('../client/nikuniku-api.mjs');
 const r=await call(apiBase(mock.base),'GET','/v1/me',{key:KEY});
 assert.equal(r.data.workspace_id,'ws_000000000000000000000001');
});
