#!/usr/bin/env node
// P1.1 (docs/director/SPEC.md §2): validate every schemas/examples/<name>.<case>.json against schemas/<name>.schema.json,
// and require every schemas/examples/invalid/<name>.<case>.json to be refused. Prints one JSON report; exit 0 only when
// all valid examples pass, all invalid ones fail, and every schema has at least one valid example.
import {readdirSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validate} from '../director/jsonschema.mjs';
import {semantics} from '../director/semantics.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..','schemas');
const load=p=>JSON.parse(readFileSync(p,'utf8'));
const schemas=Object.fromEntries(readdirSync(root).filter(f=>f.endsWith('.schema.json')).map(f=>[f.slice(0,-'.schema.json'.length),load(join(root,f))]));
const report={ok:true,valid:[],invalid:[],problems:[]};
for(const [n,sch] of Object.entries(schemas)){try{validate(sch,null);}catch(e){report.problems.push({schema:n,problem:e.message});}}
const nameOf=f=>Object.keys(schemas).sort((a,b)=>b.length-a.length).find(n=>f.startsWith(n+'.'));
// Every JSON file under examples/ (recursively, REVIEW-codex-1 M3); anything under examples/invalid/ must be refused.
const files=readdirSync(join(root,'examples'),{recursive:true}).filter(f=>f.endsWith('.json')).sort();
for(const rel of files){
 const expectValid=!rel.split(/[\\/]/).includes('invalid'),f=rel.split(/[\\/]/).pop();
 {
  const name=nameOf(f);
  if(!name){report.problems.push({file:f,problem:'no schema for this example'});continue;}
  let errors;try{const v=load(join(root,'examples',rel));errors=validate(schemas[name],v);if(!errors.length)errors=semantics(name,v);}catch(e){report.problems.push({file:f,problem:e.message});continue;}
  if(expectValid&&errors.length)report.problems.push({file:rel,problem:'expected valid',errors:errors.slice(0,5)});
  else if(!expectValid&&!errors.length)report.problems.push({file:rel,problem:'expected refusal but it validated'});
  else (expectValid?report.valid:report.invalid).push(rel);
 }
}
for(const name of Object.keys(schemas))if(!report.valid.some(f=>f.startsWith(name+'.')))report.problems.push({schema:name,problem:'no valid example'});
report.ok=report.problems.length===0;
process.stdout.write(JSON.stringify(report)+'\n');
process.exitCode=report.ok?0:1;
