// S1 (SPEC §3 S1): source.json records where a reference came from and what it may be used for. The tool never downloads
// anything; unlicensed or unknown rights can only ever be used for analysis.
import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {makeFixtures} from '../scripts/make-fixtures.mjs';
import {validate} from '../director/jsonschema.mjs';
import {semantics} from '../director/semantics.mjs';
import {cli,tmp} from './helpers.mjs';
const schema=JSON.parse(readFileSync('schemas/source.schema.json','utf8'));
let video;before(()=>{video=makeFixtures().video;});
const read=f=>{const v=JSON.parse(readFileSync(f,'utf8'));assert.deepEqual([...validate(schema,v),...semantics('source',v)],[]);return v;};

test('a URL with unknown rights is analysis-only and is not fetched',async()=>{
 const out=join(tmp(),'s.json');
 const r=await cli(['source','--url','https://example.com/watch/abc','--rights','unknown','--source-lang','zh-Hant','--out',out],{NIKUNIKU_API_KEY:'',NIKUNIKU_API_BASE:'http://127.0.0.1:9'});
 assert.equal(r.code,0,r.stderr);const s=read(out);
 assert.equal(s.usable_for,'analysis_only');assert.equal(s.local_file,null);assert.equal(s.sha256,null);assert.equal(s.found_by,'creator_url');
});
test('an owned local file records sha256 and duration and may be used for generation',async()=>{
 const out=join(tmp(),'s.json');
 const r=await cli(['source','--file',video,'--rights','owned','--rights-ref','creator-owned','--source-lang','ja','--out',out]);
 assert.equal(r.code,0,r.stderr);const s=read(out);
 assert.equal(s.sha256,createHash('sha256').update(readFileSync(video)).digest('hex'));assert.equal(s.duration_ms,3500);
 assert.equal(s.usable_for,'generation');assert.equal(s.source_id,'src-'+s.sha256.slice(0,12));
});
test('unlicensed_reference is analysis-only even for a local file; url+file, bad rights and bad lang are USAGE',async()=>{
 const out=join(tmp(),'s.json');
 assert.equal((await cli(['source','--file',video,'--rights','unlicensed_reference','--source-lang','en','--out',out])).code,0);
 assert.equal(read(out).usable_for,'analysis_only');
 for(const args of [['--url','https://example.com/a','--file',video,'--rights','owned','--source-lang','en'],['--url','https://example.com/a','--rights','mine','--source-lang','en'],['--url','https://example.com/a','--rights','owned','--source-lang','xx'],['--rights','owned','--source-lang','en']]){
  const r=await cli(['source',...args,'--out',join(tmp(),'x.json')]);assert.equal(r.code,2,args.join(' '));assert.equal(r.err.error.code,'USAGE');}
});
