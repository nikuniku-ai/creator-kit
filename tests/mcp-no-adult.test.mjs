// AC13 (SPEC §6): the general MCP package lists no adult tool or adult host. The guard runs when the server is
// created and refuses to start if any tool name, description or input schema carries an adult marker — so a later edit
// that adds one fails here, and deleting the guard turns these tests red. Also: the director tools are registered and the
// local ones work without a key.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createNikunikuMcpServer,toolList} from '../mcp/nikuniku-mcp.mjs';
import {DIRECTOR_TOOLS,ADULT_MARKERS} from '../director/mcp-tools.mjs';
import {start,KEY} from './mock-api.mjs';
import {tmp} from './helpers.mjs';
let mock;before(async()=>{mock=await start();});after(()=>mock.server.close());
const fake=(over={})=>({description:'harmless',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},annotations:{},run:async()=>({ok:true}),...over});

test('AC13: the default tool list has no adult marker anywhere and includes the director tools',()=>{
 const tools=toolList(),text=JSON.stringify(tools).toLowerCase();
 for(const m of ADULT_MARKERS)assert.ok(!text.includes(m),m);
 const names=tools.map(t=>t.name);
 for(const n of ['nikuniku_director_validate','nikuniku_director_lint','nikuniku_director_whitebox','nikuniku_director_take_submit','nikuniku_director_take_status'])assert.ok(names.includes(n),n);
 assert.doesNotThrow(()=>createNikunikuMcpServer({base:mock.base,key:KEY}));
});
test('AC13: a server with an adult tool name, description or schema refuses to start',()=>{
 for(const m of ADULT_MARKERS){
  if(/^\w+$/.test(m))assert.throws(()=>createNikunikuMcpServer({base:mock.base,key:KEY,extraTools:{[`nikuniku_${m}_x`]:fake()}}),/ADULT_TOOL_REFUSED/,`name ${m}`); // tool names are \w only
  assert.throws(()=>createNikunikuMcpServer({base:mock.base,key:KEY,extraTools:{nikuniku_x:fake({description:`Generate ${m.toUpperCase()} video`})}}),/ADULT_TOOL_REFUSED/,`description ${m}`);
  assert.throws(()=>createNikunikuMcpServer({base:mock.base,key:KEY,extraTools:{nikuniku_x:fake({inputSchema:{type:'object',properties:{host:{const:`https://${m}.example`}},required:[],additionalProperties:false}})}}),/ADULT_TOOL_REFUSED/,`schema ${m}`);
 }
});
test('AC13: the marker list covers what SPEC §6 names',()=>{
 for(const m of ['adult','nsfw','porn','18+','r18','hentai'])assert.ok(ADULT_MARKERS.includes(m),m);
});
test('director MCP tools: validate, lint and whitebox run locally without a key',async()=>{
 const v=await DIRECTOR_TOOLS.nikuniku_director_validate.run(null,{schema:'plan',path:'schemas/examples/plan.ab-merge.json'});
 assert.equal(v.ok,true);
 const bad=await DIRECTOR_TOOLS.nikuniku_director_validate.run(null,{schema:'plan',path:'schemas/examples/invalid/plan.provider-passthrough.json'});
 assert.equal(bad.ok,false);assert.equal(bad.error.code,'SCHEMA_INVALID');
 const l=await DIRECTOR_TOOLS.nikuniku_director_lint.run(null,{path:'schemas/examples/plan.ab-merge.json'});assert.equal(l.ok,true);assert.equal(l.data.passed,true);
 const out=join(tmp(),'s1.svg');
 const w=await DIRECTOR_TOOLS.nikuniku_director_whitebox.run(null,{plan_path:'schemas/examples/plan.ab-merge.json',shot_id:'s1',out_path:out});
 assert.equal(w.ok,true);assert.ok(readFileSync(out,'utf8').includes('data-faces="2"'));
 for(const n of ['nikuniku_director_validate','nikuniku_director_lint','nikuniku_director_whitebox'])assert.equal(DIRECTOR_TOOLS[n].local,true,n);
});
test('director MCP take_submit sends one take and returns at once; take_status reads it and says what is next',async()=>{
 mock.reset();mock.director.outcomes={s1:[{verdict:'failed',failure_class:'framing',polls:1},{verdict:'passed'}]};
 const {writeFileSync}=await import('node:fs');const {apiBase}=await import('../client/nikuniku-api.mjs');
 const dir=tmp(),plan=JSON.parse(readFileSync('schemas/examples/plan.ab-merge.json','utf8'));plan.sources=[];
 const planPath=join(dir,'plan.json'),ledger=join(dir,'l.json');writeFileSync(planPath,JSON.stringify(plan));
 const api=apiBase(mock.base),args={plan_path:planPath,ledger_path:ledger,shot_id:'s1'};
 const s=await DIRECTOR_TOOLS.nikuniku_director_take_submit.run(api,{...args,max_credits:300},KEY);
 assert.equal(s.ok,true,JSON.stringify(s));assert.equal(s.data.shots[0].next,'wait');assert.equal(mock.requests.filter(r=>r.path.endsWith('/runs')).length,1);
 const st=await DIRECTOR_TOOLS.nikuniku_director_take_status.run(api,args,KEY);
 assert.equal(st.data.shots[0].next,'retry');assert.equal(mock.requests.filter(r=>r.path.endsWith('/runs')).length,1,'status never submits');
 const s2=await DIRECTOR_TOOLS.nikuniku_director_take_submit.run(api,{...args,max_credits:300},KEY);
 assert.equal(s2.data.shots[0].status,'adopted');assert.equal(s2.data.shots[0].next,'stop');assert.equal(mock.requests.filter(r=>r.path.endsWith('/runs')).length,2);
 assert.equal(existsSync(ledger+'.lock'),false);
});
test('director MCP take_status never submits, not even to resend a take whose run call failed',async()=>{
 mock.reset();mock.director.failRunOnce=true;
 const {writeFileSync}=await import('node:fs');const {apiBase}=await import('../client/nikuniku-api.mjs');
 const dir=tmp(),plan=JSON.parse(readFileSync('schemas/examples/plan.ab-merge.json','utf8'));plan.sources=[];
 const planPath=join(dir,'plan.json'),ledger=join(dir,'l.json');writeFileSync(planPath,JSON.stringify(plan));
 const api=apiBase(mock.base),args={plan_path:planPath,ledger_path:ledger,shot_id:'s1'};
 const s=await DIRECTOR_TOOLS.nikuniku_director_take_submit.run(api,{...args,max_credits:300},KEY);assert.equal(s.ok,false,'the run call failed');
 const runs=()=>mock.requests.filter(r=>r.path.endsWith('/runs')).length;assert.equal(runs(),1);
 const st=await DIRECTOR_TOOLS.nikuniku_director_take_status.run(api,args,KEY);
 assert.equal(runs(),1,'status did not resend');assert.equal(st.data.shots[0].next,'resend');
 const again=await DIRECTOR_TOOLS.nikuniku_director_take_submit.run(api,{...args,max_credits:300},KEY);
 assert.equal(runs(),2,'submit resends with the same key');assert.equal(again.data.shots[0].status,'adopted');
});
