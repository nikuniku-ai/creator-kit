// AC9 (SPEC §3 MV): the existing MV flow (1–4 images + a song) is reachable from the same CLI and MCP server.
// `mv` checks "a song and at least one image" before anything is sent; the draft names the song as reference_audio_id;
// the MCP tool saves the draft and quotes but never submits.
import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {start,KEY,WS} from './mock-api.mjs';
import {cli,tmp} from './helpers.mjs';
let mock;before(async()=>{mock=await start();});after(()=>mock.server.close());beforeEach(()=>mock.reset());
const env=()=>({NIKUNIKU_API_BASE:mock.base,NIKUNIKU_API_KEY:KEY,NIKUNIKU_POLL_MS:'5'});
// A real 2x2 RGBA PNG and a short WAV, built here so the repo carries no media.
function png(seed){
 const crc=b=>{let c=~0;for(const x of b){c^=x;for(let k=0;k<8;k++)c=c&1?(c>>>1)^0xedb88320:c>>>1;}return ~c>>>0;};
 const chunk=(type,data)=>{const t=Buffer.from(type),len=Buffer.alloc(4),c=Buffer.alloc(4);len.writeUInt32BE(data.length);c.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([len,t,data,c]);};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(2,0);ihdr.writeUInt32BE(2,4);ihdr[8]=8;ihdr[9]=6;
 const raw=Buffer.from([0,seed,0,0,255,0,255,0,255,0,0,0,255,255,0,seed,255,0,255]);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
function wav(){const data=Buffer.alloc(800),h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(36+data.length,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);
 h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(8000,24);h.writeUInt32LE(16000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(data.length,40);return Buffer.concat([h,data]);}
function files(){const dir=tmp(),f={dir,a:join(dir,'a.png'),b:join(dir,'b.png'),song:join(dir,'song.wav'),prompt:join(dir,'p.txt')};
 writeFileSync(f.a,png(1));writeFileSync(f.b,png(2));writeFileSync(f.song,wav());writeFileSync(f.prompt,'A singer on a rooftop at dusk.');return f;}

test('AC9: nikuniku mv --help prints the MV usage',async()=>{
 const r=await cli(['mv','--help']);assert.equal(r.code,0);for(const flag of ['--image','--audio','--prompt','--max-credits'])assert.ok(r.stdout.includes(flag),flag);
});
test('AC9: mv sends the song as reference_audio_id with the images, in the sold external-audio mode',async()=>{
 const f=files();const r=await cli(['mv','--image',f.a,'--image',f.b,'--audio',f.song,'--prompt',f.prompt,'--max-credits','100'],env());
 assert.equal(r.code,0,r.stderr);assert.equal(mock.drafts.length,1);
 const d=mock.drafts[0];assert.match(d.reference_audio_id,/^audio_/);assert.equal(d.project.asset_ids.length,2);assert.equal(d.project.mode,'multi_image_song');
 assert.ok(mock.requests.some(q=>q.path==='/v1/jobs'));
});
test('AC9: no song, no image, five images or no prompt → exit 2 USAGE and nothing is sent',async()=>{
 const f=files();
 for(const args of [['--image',f.a,'--prompt',f.prompt],['--audio',f.song,'--prompt',f.prompt],[...Array(5).fill(['--image',f.a]).flat(),'--audio',f.song,'--prompt',f.prompt],['--image',f.a,'--audio',f.song]]){
  const r=await cli(['mv',...args],env());assert.equal(r.code,2,args.join(' '));assert.equal(r.err.error.code,'USAGE');}
 assert.equal(mock.requests.length,0);
});
test('AC9 + AC11: mv without a key → API_KEY_REQUIRED, 0 requests; above --max-credits → exit 4, nothing submitted',async()=>{
 const f=files();const r=await cli(['mv','--image',f.a,'--audio',f.song,'--prompt',f.prompt],{...env(),NIKUNIKU_API_KEY:''});
 assert.equal(r.code,2);assert.equal(r.err.error.code,'API_KEY_REQUIRED');assert.equal(mock.requests.length,0);
 const over=await cli(['mv','--image',f.a,'--audio',f.song,'--prompt',f.prompt,'--max-credits','50'],env());
 assert.equal(over.code,4);assert.ok(!mock.requests.some(q=>q.path==='/v1/jobs'));
});
test('AC9: MCP nikuniku_mv_draft uploads, saves the draft and quotes, and never submits',async()=>{
 const {DIRECTOR_TOOLS}=await import('../director/mcp-tools.mjs');const {apiBase}=await import('../client/nikuniku-api.mjs');
 const f=files();const t=DIRECTOR_TOOLS.nikuniku_mv_draft;assert.ok(t,'tool exists');
 const r=await t.run(apiBase(mock.base),{workspace_id:WS,image_paths:[f.a,f.b],audio_path:f.song,prompt:'A singer on a rooftop at dusk.',rights_ref:'creator-owned'},KEY);
 assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.quote.max_units,80);assert.match(r.data.project_id,/^mv-/);
 assert.equal(mock.drafts[0].reference_audio_id,r.data.audio_id);assert.ok(!mock.requests.some(q=>q.path==='/v1/jobs'));
 const bad=await t.run(apiBase(mock.base),{workspace_id:WS,image_paths:[],audio_path:f.song,prompt:'x',rights_ref:'creator-owned'},KEY);
 assert.equal(bad.ok,false);assert.equal(bad.error.code,'USAGE');
 mock.requests.length=0;
 const five=await t.run(apiBase(mock.base),{workspace_id:WS,image_paths:Array(5).fill(f.a),audio_path:f.song,prompt:'x',rights_ref:'creator-owned'},KEY);
 assert.equal(five.ok,false);assert.equal(five.error.code,'USAGE');assert.equal(mock.requests.length,0,'refused before any upload');
});
