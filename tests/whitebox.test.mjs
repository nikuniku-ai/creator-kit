// S6 (P2.3, SPEC §3 S6): scene layout boxes + shot camera → SVG whitebox. Face count after back-face culling, camera
// forward direction and painter order (far → near) are asserted so reversing the camera or dropping culling turns red.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {render,project,basis} from '../director/whitebox.mjs';
import {cli,tmp} from './helpers.mjs';
const plan=()=>JSON.parse(readFileSync('schemas/examples/plan.ab-merge.json','utf8'));
const attr=(svg,name)=>svg.match(new RegExp(`<svg[^>]* ${name}="([^"]*)"`))?.[1];
const faces=svg=>[...svg.matchAll(/<polygon data-box="([^"]+)" data-face="([^"]+)"/g)].map(m=>`${m[1]}${m[2]}`);
const scene=p=>p.scenes[0];

test('front camera: only the two faces turned toward it are drawn, far box first',()=>{
 const p=plan(),svg=render(scene(p),p.shots[0]);
 assert.equal(attr(svg,'data-faces'),'2');
 assert.deepEqual(faces(svg),['wall+z','mei+z'],'painter order: the wall (farther) is drawn before mei');
 assert.equal(attr(svg,'data-forward'),'0.000,-0.100,-0.995');
});
test('reverse camera (behind the wall): the back faces are drawn and forward points +z',()=>{
 const p=plan(),shot={...p.shots[0],camera:{position:[0,1.6,-6],look_at:[0,1.2,0],fov_deg:40}};
 const svg=render(scene(p),shot);
 assert.deepEqual(faces(svg),['mei-z','wall-z']);
 assert.equal(attr(svg,'data-forward'),'0.000,-0.067,0.998');
});
test('corner camera above: three faces of each box (+x, +y, +z), never more (back-face culling)',()=>{
 const p=plan(),shot={...p.shots[0],camera:{position:[5,5,5],look_at:[0,1,0],fov_deg:60}};
 const f=faces(render(scene(p),shot));
 assert.equal(f.length,6);assert.deepEqual([...f].sort(),['mei+x','mei+y','mei+z','wall+x','wall+y','wall+z']);
});
test('projection: a point straight ahead lands in the image centre; a point above lands above it',()=>{
 const cam={position:[0,0,5],look_at:[0,0,0],fov_deg:90},b=basis(cam);
 assert.deepEqual(project([0,0,0],cam,b).map(v=>Math.round(v)),[640,360]);
 const up=project([0,1,0],cam,b);assert.ok(up[1]<360,'screen y grows downward');
 assert.equal(Math.round(up[1]),360-Math.round(360*1/5));
 assert.equal(project([0,0,6],cam,b),null,'behind the camera is not projected');
});
test('looking straight down still has a valid basis (no NaN in the SVG)',()=>{
 const p=plan(),svg=render(scene(p),{...p.shots[0],camera:{position:[0,10,0],look_at:[0,0,0],fov_deg:60}});
 assert.ok(!svg.includes('NaN'));assert.equal(attr(svg,'data-forward'),'0.000,-1.000,0.000');
 assert.deepEqual(faces(svg).sort(),['mei+y','wall+y','wall+z'],'the wall front is still turned toward a camera above and in front of it');
});
test('CLI: --shot writes one SVG; --dir writes every shot that has a camera and a scene layout',async()=>{
 const dir=tmp(),out=join(dir,'s1.svg');
 const r=await cli(['whitebox','schemas/examples/plan.ab-merge.json','--shot','s1','--out',out],{NIKUNIKU_API_KEY:''});
 assert.equal(r.code,0,r.stderr);assert.equal(attr(readFileSync(out,'utf8'),'data-faces'),'2');
 const all=await cli(['whitebox','schemas/examples/plan.ab-merge.json','--dir',join(dir,'all')]);
 assert.equal(all.code,0,all.stderr);assert.deepEqual(readdirSync(join(dir,'all')),['s1.svg']);
 assert.deepEqual(all.json.data.skipped,[{shot_id:'s2',reason:'no_camera'}]);
});
test('CLI: a shot without a camera, or an unknown shot, is a USAGE error and writes nothing',async()=>{
 const dir=tmp();
 for(const id of ['s2','nope']){const r=await cli(['whitebox','schemas/examples/plan.ab-merge.json','--shot',id,'--out',join(dir,id+'.svg')]);
  assert.equal(r.code,2,id);assert.equal(r.err.error.code,'USAGE');}
 assert.deepEqual(readdirSync(dir),[]);
});
