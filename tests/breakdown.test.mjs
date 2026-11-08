// AC2 (P2.1): breakdown of a synthetic 3-shot video matches the human labels (count ±1, cuts within 0.5 s).
import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {makeFixtures} from '../scripts/make-fixtures.mjs';
import {compare} from './check-breakdown.mjs';
import {validate} from '../director/jsonschema.mjs';
import {cli,tmp} from './helpers.mjs';
const truth=JSON.parse(readFileSync('fixtures/x.truth.json','utf8'));
const schema=JSON.parse(readFileSync('schemas/breakdown.schema.json','utf8'));
let video;
before(()=>{video=makeFixtures().video;});

test('breakdown detects the labelled shots and writes a schema-valid file without a key',async()=>{
 const dir=tmp(),out=join(dir,'b.json');
 const r=await cli(['breakdown',video,'--out',out,'--frames',join(dir,'frames'),'--srt','fixtures/x.srt','--srt-lang','zh-Hant'],{NIKUNIKU_API_KEY:''});
 assert.equal(r.code,0,r.stderr);
 const b=JSON.parse(readFileSync(out,'utf8'));
 assert.deepEqual(validate(schema,b),[]);
 const c=compare(b,truth);assert.ok(c.ok,JSON.stringify(c));
 assert.equal(b.source_sha256.length,64);
 assert.equal(readdirSync(join(dir,'frames')).filter(f=>f.endsWith('.png')).length,b.shots.length);
 assert.equal(b.transcript_source,'srt');
 assert.deepEqual(b.shots[1].dialogue.map(d=>d.text),['你終於來了。']);
 assert.deepEqual(b.shots[2].dialogue.map(d=>d.text),['嗯。']);
 assert.ok(b.shots.every(s=>s.filled_by==='detector'&&s.framing==='unknown'),'the detector must not pretend to read the picture');
});
test('the AC2 one-line checker passes on the CLI output',async()=>{
 const dir=tmp(),out=join(dir,'b.json');
 assert.equal((await cli(['breakdown',video,'--out',out])).code,0);
 const r=await import('node:child_process').then(m=>m.spawnSync(process.execPath,['tests/check-breakdown.mjs',out,'fixtures/x.truth.json'],{encoding:'utf8'}));
 assert.equal(r.status,0,r.stdout);
});
test('a threshold that misses every cut fails the AC2 comparison (the checker is not a tautology)',async()=>{
 const dir=tmp(),out=join(dir,'b.json');
 assert.equal((await cli(['breakdown',video,'--out',out,'--threshold','0.95'])).code,0);
 assert.equal(compare(JSON.parse(readFileSync(out,'utf8')),truth).ok,false);
});
test('a missing video is a usage error and writes nothing',async()=>{
 const dir=tmp(),out=join(dir,'b.json');
 const r=await cli(['breakdown','fixtures/none.mp4','--out',out]);
 assert.equal(r.code,2);assert.equal(r.err.error.code,'USAGE');assert.equal(existsSync(out),false);
});
test('subtitles without a language are refused',async()=>{
 const r=await cli(['breakdown',video,'--out',join(tmp(),'b.json'),'--srt','fixtures/x.srt']);
 assert.equal(r.code,2);assert.match(r.err.error.message,/srt-lang/);
});
test('an out-of-range threshold is refused',async()=>{
 const r=await cli(['breakdown',video,'--out',join(tmp(),'b.json'),'--threshold','1.5']);
 assert.equal(r.code,2);assert.equal(r.err.error.code,'USAGE');
});
