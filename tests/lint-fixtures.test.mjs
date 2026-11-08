// AC3 + AC4 (SPEC §3 S3–S4): A+B plan scaffold passes the schema; lint reports each planted error exactly once; dialogue copied
// from the source is refused by the 3-gram similarity cap. Each rule has its own case so deleting a rule turns one red.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {lint} from '../director/lint.mjs';
import {validate} from '../director/jsonschema.mjs';
import {cli,tmp} from './helpers.mjs';
const base=()=>JSON.parse(readFileSync('schemas/examples/plan.ab-merge.json','utf8'));
const planSchema=JSON.parse(readFileSync('schemas/plan.schema.json','utf8'));
const reportSchema=JSON.parse(readFileSync('schemas/lint-report.schema.json','utf8'));
const source=JSON.parse(readFileSync('schemas/examples/breakdown.fixture.json','utf8'));
const errors=(r,code)=>r.findings.filter(f=>f.severity==='error'&&(!code||f.code===code));
const codes=r=>r.findings.map(f=>f.code).sort();

test('the clean A+B example has no errors',()=>{
 const r=lint(base(),{sources:[source]});
 assert.deepEqual(errors(r),[]);assert.equal(r.passed,true);
});
test('L001: a character that is not in the bible',()=>{
 const p=base();p.shots[0].characters.push('ghost');
 assert.deepEqual(codes(lint(p)).filter(c=>c.startsWith('L001')),['L001_CHARACTER_UNDEFINED']);
});
test('L002: a character appears before the scene that introduces them (appears from nowhere)',()=>{
 const p=base();p.shots[0].characters.push('jun');
 const r=lint(p);assert.equal(errors(r,'L002_CHARACTER_BEFORE_INTRO').length,1);assert.equal(errors(r,'L002_CHARACTER_BEFORE_INTRO')[0].shot_id,'s1');
});
test('L003: a prop used before it entered',()=>{
 const p=base();p.props.push({id:'ring',name:'戒指',description:null});p.shots[1].props_used.push('ring');
 const r=lint(p);assert.equal(errors(r,'L003_PROP_NOT_ENTERED').length,1);assert.equal(errors(r,'L003_PROP_NOT_ENTERED')[0].shot_id,'s2');
});
test('L005: story time runs backwards without a flashback',()=>{
 const p=base();p.scenes[0].story_time_min=60;
 const r=lint(p);assert.equal(errors(r,'L005_TIMELINE_REGRESSION').length,1);
 p.scenes[1].flashback=true;assert.equal(errors(lint(p),'L005_TIMELINE_REGRESSION').length,0,'a declared flashback is allowed');
});
test('AC3: the three planted errors in one plan are each reported exactly once',()=>{
 const p=base();p.shots[0].characters.push('jun');p.props.push({id:'ring',name:'戒指',description:null});p.shots[1].props_used.push('ring');p.scenes[0].story_time_min=60;
 const r=lint(p);
 for(const c of ['L002_CHARACTER_BEFORE_INTRO','L003_PROP_NOT_ENTERED','L005_TIMELINE_REGRESSION'])assert.equal(errors(r,c).length,1,c);
 assert.equal(errors(r).length,3,JSON.stringify(codes(r)));assert.equal(r.passed,false);
});
test('AC4: dialogue copied from the source is refused by the 3-gram cap; a rewrite passes',()=>{
 const p=base();p.shots[0].dialogue[0].text='你終於來了。';p.shots[0].dialogue[0].start_s=null;
 const copied=lint(p,{sources:[source]});
 assert.equal(errors(copied,'L004_SIMILARITY_TOO_HIGH').length,1);assert.ok(copied.similarity.max>copied.similarity.threshold);
 p.shots[0].dialogue[0].text='等你好久了。';
 assert.equal(errors(lint(p,{sources:[source]}),'L004_SIMILARITY_TOO_HIGH').length,0);
});
test('AC4: word 3-grams for spaced languages',()=>{
 const src={...source,shots:[{...source.shots[1],dialogue:[{speaker:null,text:'I finally found you at the station tonight',lang:'en'}]}]};
 const p=base();p.lang='en';p.shots[0].dialogue[0]={speaker:'mei',text:'I finally found you at the station tonight',lang:'en'};
 assert.equal(errors(lint(p,{sources:[src]}),'L004_SIMILARITY_TOO_HIGH').length,1);
 p.shots[0].dialogue[0].text='So this is where you were hiding';
 assert.equal(errors(lint(p,{sources:[src]}),'L004_SIMILARITY_TOO_HIGH').length,0);
});
test('L006 and L007 are warnings and do not fail the plan',()=>{
 const p=base();p.shots[1].accept=null;p.gaps[0].filled=false;
 const r=lint(p,{sources:[source,{...source,source_id:'src-b'}],sourceSha256s:['a'.repeat(64),'b'.repeat(64)]});assert.deepEqual(codes(r),['L006_ACCEPT_MISSING','L007_GAP_UNFILLED']);assert.equal(r.passed,true);
});
test('L008: a line in Japanese names a character by their Chinese name',()=>{
 const p=base();p.lang='ja';p.shots[0].dialogue[0]={speaker:'jun',text:'小梅、待って。',lang:'ja'};
 assert.ok(codes(lint(p)).includes('L008_NAME_INCONSISTENT'));
 p.shots[0].dialogue[0].text='メイ、待って。';assert.ok(!codes(lint(p)).includes('L008_NAME_INCONSISTENT'));
});
test('L009: a shot pointing at a scene or prop that does not exist',()=>{
 const p=base();p.shots[0].scene_id='nowhere';p.dependencies.push({shot_id:'s2',depends_on:'s9',kind:'tail_frame'});
 assert.equal(errors(lint(p),'L009_REFERENCE_UNDEFINED').length,2);
});
test('CLI: lint exits 3 on errors with a schema-valid report, 0 when clean',async()=>{
 const dir=tmp(),bad=base();bad.scenes[0].story_time_min=60;writeFileSync(join(dir,'bad.json'),JSON.stringify(bad));
 const r=await cli(['lint',join(dir,'bad.json'),'--out',join(dir,'r.json')],{NIKUNIKU_API_KEY:''});
 assert.equal(r.code,3);assert.equal(r.err.error.code,'LINT_FAILED');
 const report=JSON.parse(readFileSync(join(dir,'r.json'),'utf8'));assert.deepEqual(validate(reportSchema,report),[]);
 const ok=await cli(['lint','schemas/examples/plan.ab-merge.json','--source','schemas/examples/breakdown.fixture.json']);
 assert.equal(ok.code,0,ok.stderr);assert.equal(ok.json.data.passed,true);
});
test('CLI: a plan that breaks the schema is refused before linting',async()=>{
 const r=await cli(['lint','schemas/examples/invalid/plan.provider-passthrough.json']);
 assert.equal(r.code,2);assert.equal(r.err.error.code,'SCHEMA_INVALID');
});
test('AC3: plan --a --b builds a schema-valid A+B scaffold whose lint has no errors',async()=>{
 const dir=tmp(),a=join(dir,'a.json'),b=join(dir,'b.json'),brief=join(dir,'brief.txt'),out=join(dir,'plan.json');
 writeFileSync(a,JSON.stringify(source));writeFileSync(b,JSON.stringify({...source,source_id:'src-b'}));writeFileSync(brief,'把 A 的開場接 B 的重逢。\n改成台北雨夜。');
 const r=await cli(['plan','--a',a,'--b',b,'--brief',brief,'--plan-lang','zh-Hant','--project','demo-ab','--out',out,'--merge','interleave']);
 assert.equal(r.code,0,r.stderr);
 const p=JSON.parse(readFileSync(out,'utf8'));
 assert.deepEqual(validate(planSchema,p),[]);
 assert.deepEqual(p.sources.map(s=>s.role),['A','B']);
 assert.deepEqual(p.shots.map(s=>s.source_shot),['A:0','B:0','A:1','B:1','A:2','B:2']);
 assert.deepEqual(p.shots.map(s=>s.order),[0,1,2,3,4,5]);
 assert.ok(p.shots.every(s=>s.accept===null));
 assert.deepEqual(errors(lint(p)),[]);
});
test('L010: a plan with sources linted without its breakdowns is reported as NOT checked (M5)',()=>{
 const r=lint(base());
 assert.equal(r.similarity.checked,false);assert.deepEqual(codes(r).filter(c=>c.startsWith('L010')),['L010_SIMILARITY_NOT_CHECKED']);
 assert.equal(r.passed,true,'L010 is a warning');
 const both=lint(base(),{sources:[source,{...source,source_id:'src-b'}],sourceSha256s:['a'.repeat(64),'b'.repeat(64)]});
 assert.equal(both.similarity.checked,true);assert.ok(!codes(both).includes('L010_SIMILARITY_NOT_CHECKED'));
 const one=lint(base(),{sources:[source]});assert.equal(one.similarity.checked,false,'only A given');
});
test('L010: a breakdown whose sha256 differs from plan.sources does not count as checked',()=>{
 const r=lint(base(),{sources:[source,{...source,source_id:'src-b'}],sourceSha256s:['a'.repeat(64),'c'.repeat(64)]});
 assert.equal(r.similarity.checked,false);
 assert.equal(lint(base(),{sources:[source,{...source,source_id:'src-b'}],sourceSha256s:['a'.repeat(64),'b'.repeat(64)]}).similarity.checked,true);
});
test('AC4: a short line identical to the source (after NFKC and punctuation) is refused; one token is not',()=>{
 const src={...source,shots:[{...source.shots[1],dialogue:[{speaker:null,text:'Wait, Jun!',lang:'en'},{speaker:null,text:'No.',lang:'en'}]}]};
 const p=base();p.lang='en';p.shots[0].dialogue[0]={speaker:'mei',text:'ｗａｉｔ  JUN',lang:'en'};
 assert.equal(errors(lint(p,{sources:[src]}),'L004_SIMILARITY_TOO_HIGH').length,1);
 p.shots[0].dialogue[0].text='No!';
 assert.equal(errors(lint(p,{sources:[src]}),'L004_SIMILARITY_TOO_HIGH').length,0,'a one-token line is too short to call copied');
});
test('CLI: lint --source computes the breakdown sha256 for the checked flag',async()=>{
 const r=await cli(['lint','schemas/examples/plan.ab-merge.json','--source','schemas/examples/breakdown.fixture.json']);
 assert.equal(r.code,0,r.stderr);assert.equal(r.json.data.similarity.checked,false,'fixture sha256 is not the plan\'s placeholder');
});
test('plan: the scaffold never copies source dialogue, characters or props (structure only)',async()=>{
 const dir=tmp(),a=join(dir,'a.json'),brief=join(dir,'brief.txt'),out=join(dir,'plan.json');
 writeFileSync(a,JSON.stringify(source));writeFileSync(brief,'改成台北雨夜。');
 const r=await cli(['plan','--a',a,'--brief',brief,'--plan-lang','ja','--project','demo-a','--out',out]);
 assert.equal(r.code,0,r.stderr);
 const p=JSON.parse(readFileSync(out,'utf8'));
 assert.ok(p.shots.every(s=>s.dialogue.length===0&&s.characters.length===0&&s.props_used.length===0));
 assert.ok(!readFileSync(out,'utf8').includes('你終於來了'),'source line must not appear anywhere in the plan');
 assert.deepEqual(p.shots.map(s=>s.source_shot),['A:0','A:1','A:2']);assert.deepEqual(p.shots.map(s=>s.duration_ms),[1000,1500,1000]);
 assert.deepEqual(p.bible.hooks.map(h=>h.at_s),[1],'hook positions carry over on the merged timeline');assert.ok(!p.bible.hooks[0].text.includes('揭露信件'));
 const {createHash}=await import('node:crypto');
 assert.equal(lint(p,{sources:[source],sourceSha256s:[createHash('sha256').update(readFileSync(a)).digest('hex')]}).similarity.checked,true);
});
test('plan: refuses A and B with the same source_id, an unknown plan language and an unknown merge',async()=>{
 const dir=tmp(),a=join(dir,'a.json'),brief=join(dir,'brief.txt'),out=join(dir,'plan.json');
 writeFileSync(a,JSON.stringify(source));writeFileSync(brief,'x');
 const base=['plan','--a',a,'--brief',brief,'--project','p','--out',out];
 for(const extra of [['--b',a,'--plan-lang','en'],['--plan-lang','xx'],['--plan-lang','en','--merge','shuffle']]){
  const r=await cli([...base,...extra]);assert.equal(r.code,2,extra.join(' '));assert.equal(r.err.error.code,'USAGE');}
});
// Counter-examples from an independent review (each case is the reviewer's own)
const SHAS=['a'.repeat(64),'b'.repeat(64)],BOTH=()=>[source,{...source,source_id:'src-b'}];
test('R-p2.2 #1 blocker: an English line copied verbatim with one CJK character appended is still L004',()=>{
 const src={...source,shots:[{...source.shots[1],dialogue:[{speaker:null,text:'I finally found you at the station tonight',lang:'en'}]}]};
 const p=base();p.lang='en';p.shots[0].dialogue[0]={speaker:'mei',text:'I finally found you at the station tonight 中',lang:'en'};
 assert.equal(errors(lint(p,{sources:[src]}),'L004_SIMILARITY_TOO_HIGH').length,1);
});
test('R-p2.2 #2: a speaker who talks before their first scene is L002 (once per shot)',()=>{
 const p=base();p.shots[0].dialogue[0].speaker='jun';
 assert.equal(errors(lint(p),'L002_CHARACTER_BEFORE_INTRO').length,1);
 p.shots[0].characters.push('jun');assert.equal(errors(lint(p),'L002_CHARACTER_BEFORE_INTRO').length,1,'listed and speaking: still one finding');
});
test('R-p2.2 #3: returning to an earlier scene (sc1 → sc2 → sc1) without flashback is L005',()=>{
 const p=base();p.shots.push({...structuredClone(p.shots[0]),id:'s3',order:2,props_enter:[],dialogue:[]});
 assert.equal(errors(lint(p),'L005_TIMELINE_REGRESSION').length,1);
 const q=base();q.shots.push({...structuredClone(q.shots[1]),id:'s3',order:2,props_enter:[],dialogue:[]});
 assert.equal(errors(lint(q),'L005_TIMELINE_REGRESSION').length,0,'consecutive shots in one scene are not a regression');
});
test('R-p2.2 #5: lint() without file hashes never reports similarity as checked',()=>{
 assert.equal(lint(base(),{sources:BOTH()}).similarity.checked,false);
 assert.equal(lint(base(),{sources:BOTH(),sourceSha256s:SHAS}).similarity.checked,true);
});
test('R-p2.2 #6: a huge plan still yields a schema-valid report (findings capped, errors kept, omission counted)',()=>{
 const p=base(),shot=p.shots[1];p.shots=[];
 for(let i=0;i<313;i++)p.shots.push({...structuredClone(shot),id:'x'+i,order:i,props_used:[],props_enter:[],dialogue:Array.from({length:32},()=>({speaker:'ghost',text:'hi',lang:'zh-Hant'}))});
 const r=lint(p,{sources:BOTH(),sourceSha256s:SHAS});
 assert.deepEqual(validate(reportSchema,r),[]);assert.equal(r.passed,false);
 const t=r.findings.find(f=>f.code==='L011_FINDINGS_TRUNCATED');assert.ok(t,'truncation is reported');assert.match(t.message,/omitted \d+/);
});
test('R-p2.2 #4 #7: the scaffold copies no description or hook text; hook time follows the clamped durations',async()=>{
 const dir=tmp(),a=join(dir,'a.json'),brief=join(dir,'brief.txt'),out=join(dir,'plan.json');
 const b=structuredClone(source);b.shots[0].end_s=0.1;b.shots[1].start_s=0.1;b.shots[1].description='原角阿明拿原道具銀鑰匙說「你終於來了。」';b.shots[1].hook='你終於來了。';
 writeFileSync(a,JSON.stringify(b));writeFileSync(brief,'x');
 const r=await cli(['plan','--a',a,'--brief',brief,'--plan-lang','zh-Hant','--project','p','--out',out]);assert.equal(r.code,0,r.stderr);
 const text=readFileSync(out,'utf8'),p=JSON.parse(text);
 for(const s of ['阿明','銀鑰匙','你終於來了'])assert.ok(!text.includes(s),s);
 assert.equal(p.bible.hooks[0].at_s,0.5);
});
