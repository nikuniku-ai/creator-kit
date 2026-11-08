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
