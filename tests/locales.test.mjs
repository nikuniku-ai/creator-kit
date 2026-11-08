// AC12 (P2.7, SPEC §7): fourteen locale files with the same keys; every error code the kit can emit has a message in every
// language; ar is right-to-left and isolated; machine output (stdout JSON, first stderr line) is byte-identical in every
// language.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {LOCALES,pickLang,render} from '../director/i18n.mjs';
import {COMMANDS} from '../director/cli.mjs';
import {cli,tmp} from './helpers.mjs';
const load=l=>JSON.parse(readFileSync(`locales/director/${l}.json`,'utf8'));
const REGISTRY=['en','zh-Hant','zh-Hans','ja','ko','vi','id','th','es','pt-BR','fr','de','ar','hi'];

// Every code the kit can put in an error envelope: thrown Refusals, returned {code:'X'} results, and SPEC §5's table.
function emittedCodes(){
 const codes=new Set(['API_ERROR']);
 for(const f of [...readdirSync('director').map(f=>join('director',f)),'client/nikuniku-api.mjs'])
  for(const m of readFileSync(f,'utf8').matchAll(/(?:Refusal\(|code:|fail\(\d,)'([A-Z][A-Z0-9_]{2,})'/g))codes.add(m[1]);
 for(const m of readFileSync('docs/director/SPEC.md','utf8').matchAll(/^\| `([A-Z][A-Z0-9_]+)` \| \d \|/gm))codes.add(m[1]);
 return codes;
}

test('AC12: the fourteen languages of the site registry, no more and no fewer, one file each',()=>{
 assert.deepEqual([...LOCALES].sort(),[...REGISTRY].sort());
 assert.deepEqual(readdirSync('locales/director').filter(f=>f.endsWith('.json')).map(f=>f.slice(0,-5)).sort(),[...REGISTRY].sort());
});
test('AC12: every language has exactly the English keys, non-empty, with the same placeholders',()=>{
 const en=load('en');
 for(const l of REGISTRY){const t=load(l);
  assert.deepEqual(Object.keys(t).sort(),Object.keys(en).sort(),`${l} keys`);
  for(const [k,v] of Object.entries(t)){assert.ok(typeof v==='string'&&v.trim(),`${l} ${k}`);
   assert.deepEqual(v.match(/\{\w+\}/g)??[],en[k].match(/\{\w+\}/g)??[],`${l} ${k} placeholders`);}}
});
test('AC12: every error code the kit can emit and every director command has a message',()=>{
 const en=load('en');
 for(const c of emittedCodes())assert.ok(Object.hasOwn(en,'error.'+c),`missing error.${c}`);
 for(const c of COMMANDS)assert.ok(Object.hasOwn(en,'done.'+c),`missing done.${c}`);
});
test('AC12: ar is rtl and wrapped in isolates; the others are ltr and unwrapped',()=>{
 for(const l of REGISTRY)assert.equal(load(l).dir,l==='ar'?'rtl':'ltr',l);
 const ar=render('ar','error.USAGE',{message:'--out'});assert.ok(ar.startsWith('⁧')&&ar.endsWith('⁩'));assert.ok(ar.includes('--out'));
 assert.ok(!render('ja','error.USAGE',{message:'x'}).includes('⁧'));
});
test('AC12: language choice: --lang > NIKUNIKU_LANG > LC_ALL > LANG > en; unknown falls back to en',()=>{
 assert.equal(pickLang('ja',{NIKUNIKU_LANG:'ko'}),'ja');assert.equal(pickLang(undefined,{NIKUNIKU_LANG:'ko',LANG:'fr_FR.UTF-8'}),'ko');
 assert.equal(pickLang(undefined,{LC_ALL:'de_DE.UTF-8',LANG:'fr_FR.UTF-8'}),'de');assert.equal(pickLang(undefined,{LANG:'zh_TW.UTF-8'}),'zh-Hant');
 assert.equal(pickLang(undefined,{LANG:'pt_BR.UTF-8'}),'pt-BR');assert.equal(pickLang('xx',{}),'en');assert.equal(pickLang(undefined,{}),'en');
});
test('AC12: stdout and the first stderr line are byte-identical in all fourteen languages; the second line is translated',async()=>{
 const dir=tmp(),bad=JSON.parse(readFileSync('schemas/examples/plan.ab-merge.json','utf8'));bad.scenes[0].story_time_min=60;
 const f=join(dir,'bad.json');writeFileSync(f,JSON.stringify(bad));
 const runs=await Promise.all(REGISTRY.map(l=>cli(['lint',f,'--lang',l])));
 for(const [i,r] of runs.entries()){assert.equal(r.code,3,REGISTRY[i]);
  assert.equal(r.stdout,runs[0].stdout,`${REGISTRY[i]} stdout`);assert.equal(r.stderr.split('\n')[0],runs[0].stderr.split('\n')[0],`${REGISTRY[i]} stderr[0]`);}
 const second=runs.map(r=>r.stderr.split('\n')[1]);
 assert.equal(new Set(second).size,REGISTRY.length,'each language says it in its own words');
 assert.ok(second[REGISTRY.indexOf('ar')].startsWith('⁧'));
 const viaEnv=await cli(['lint',f],{NIKUNIKU_LANG:'ja'});assert.equal(viaEnv.stderr.split('\n')[1],second[REGISTRY.indexOf('ja')]);
});
test('AC12: a successful command writes the localized done line on stderr, stdout unchanged',async()=>{
 const en=await cli(['lint','schemas/examples/plan.ab-merge.json','--lang','en']),ja=await cli(['lint','schemas/examples/plan.ab-merge.json','--lang','ja']);
 assert.equal(en.code,0);assert.equal(en.stdout,ja.stdout);
 assert.equal(en.stderr.trim(),load('en')['done.lint']);assert.equal(ja.stderr.trim(),load('ja')['done.lint']);
});
