// P1.1: every schema example validates, every invalid example is refused, and the validator itself enforces each keyword.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validate} from '../director/jsonschema.mjs';
const run=promisify(execFile);

test('validate-schemas.mjs passes on the shipped schemas and examples',async()=>{
 const {stdout}=await run(process.execPath,['scripts/validate-schemas.mjs']);
 assert.match(stdout,/"ok":true/);
 const report=JSON.parse(stdout);
 for(const name of ['source','breakdown','plan','lint-report','gacha-ledger','edl','qa-receipt'])assert.ok(report.valid.some(f=>f.startsWith(name+'.')),`no valid example for ${name}`);
 assert.ok(report.invalid.length>=5,'needs invalid examples that must be refused');
});

const S={type:'object',required:['a'],additionalProperties:false,properties:{
 a:{type:'string',minLength:2,maxLength:4,pattern:'^[a-z]+$'},
 n:{type:'integer',minimum:1,maximum:3},
 e:{enum:['x','y']},c:{const:1},
 l:{type:'array',minItems:1,maxItems:2,items:{$ref:'#/$defs/t'}},
 o:{oneOf:[{type:'string'},{type:'number'}]},
 nul:{type:['string','null']}},$defs:{t:{type:'boolean'}}};
const errors=v=>validate(S,v).map(e=>e.keyword);

test('validator: happy value has no errors',()=>{assert.deepEqual(validate(S,{a:'ab',n:2,e:'x',c:1,l:[true],o:'s',nul:null}),[]);});
for(const [name,value,kw] of [
 ['required',{},'required'],['additionalProperties',{a:'ab',z:1},'additionalProperties'],
 ['type',{a:3},'type'],['minLength',{a:'a'},'minLength'],['maxLength',{a:'abcde'},'maxLength'],['pattern',{a:'AB'},'pattern'],
 ['integer',{a:'ab',n:1.5},'type'],['minimum',{a:'ab',n:0},'minimum'],['maximum',{a:'ab',n:4},'maximum'],
 ['enum',{a:'ab',e:'z'},'enum'],['const',{a:'ab',c:2},'const'],
 ['minItems',{a:'ab',l:[]},'minItems'],['maxItems',{a:'ab',l:[true,true,true]},'maxItems'],['$ref items',{a:'ab',l:[1]},'type'],
 ['oneOf',{a:'ab',o:true},'oneOf'],['type array',{a:'ab',nul:3},'type'],
])test(`validator refuses ${name}`,()=>{assert.ok(errors(value).includes(kw),JSON.stringify(errors(value)));});
test('validator reports the JSON path of the failure',()=>{assert.equal(validate(S,{a:'ab',l:[true,1]})[0].path,'$.l[1]');});

// REVIEW-codex-1 B2, M1, M2, m1, m2
import {checkSchema} from '../director/jsonschema.mjs';
test('B2: inherited names (constructor, __proto__, toString) are not declared properties',()=>{
 const s={type:'object',additionalProperties:false,properties:{a:{type:'string'}}};
 for(const k of ['constructor','toString','hasOwnProperty'])assert.ok(validate(s,JSON.parse(`{"${k}":{"provider":"x"}}`)).some(e=>e.keyword==='additionalProperties'),k);
 assert.ok(validate(s,JSON.parse('{"__proto__":{"provider":"x"}}')).some(e=>e.keyword==='additionalProperties'),'__proto__');
});
test('B2: the real plan schema refuses shots[0].constructor',async()=>{
 const {readFileSync}=await import('node:fs');
 const plan=JSON.parse(readFileSync('schemas/examples/plan.ab-merge.json','utf8'));plan.shots[0].constructor={provider:'external'};
 assert.ok(validate(JSON.parse(readFileSync('schemas/plan.schema.json','utf8')),plan).length>0);
});
test('M1: unknown keywords anywhere in a schema are refused at load, even where no example reaches',()=>{
 assert.throws(()=>checkSchema({type:'object',properties:{a:{type:'array',items:{type:'string',format:'email'}}}}),/format/);
 assert.throws(()=>checkSchema({$defs:{unused:{minimum:'x'}}}),/minimum/);
 assert.throws(()=>checkSchema({pattern:'('}),/pattern/);
 assert.throws(()=>checkSchema({$ref:'#/$defs/missing'}),/missing/);
 assert.doesNotThrow(()=>checkSchema(S));
});
test('M2: constraints next to $ref are applied too',()=>{
 const s={$defs:{t:{type:'string'}},properties:{a:{$ref:'#/$defs/t',maxLength:1}},type:'object'};
 assert.ok(validate(s,{a:'long'}).some(e=>e.keyword==='maxLength'));
});
test('m1: const/enum compare JSON values regardless of key order; JSON pointer escapes resolve',()=>{
 assert.deepEqual(validate({const:{a:1,b:2}},{b:2,a:1}),[]);
 assert.deepEqual(validate({$defs:{'a/b':{type:'string'}},$ref:'#/$defs/a~1b'},'x'),[]);
});
test('m2: boolean schema false refuses everything',()=>{
 assert.equal(validate(false,'anything').length,1);assert.deepEqual(validate(true,'anything'),[]);
});

// REVIEW-codex-1 M4/M10/M11/m4/m5/B1: each *.sem-* example is schema-valid and refused only by its semantic rule.
import {semantics} from '../director/semantics.mjs';
test('semantic refusals: schema passes, the cross-field rule refuses',async()=>{
 const {readdirSync,readFileSync}=await import('node:fs');
 const files=readdirSync('schemas/examples/invalid').filter(f=>f.includes('.sem-'));
 assert.ok(files.length>=14,String(files.length));
 for(const f of files){
  const name=f.split('.sem-')[0],v=JSON.parse(readFileSync('schemas/examples/invalid/'+f,'utf8'));
  assert.deepEqual(validate(JSON.parse(readFileSync(`schemas/${name}.schema.json`,'utf8')),v),[],f+' should pass the schema');
  assert.ok(semantics(name,v).length>0,f+' should be refused by semantics');
 }
});
