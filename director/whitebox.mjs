// S6 (docs/director/SPEC.md §3 S6): whitebox SVG. A scene's layout boxes (axis-aligned) seen through a shot's pinhole
// camera: back-face culling, painter's order (far → near), flat grey shading. No Blender, no third-party geometry
// package: a box has six quads, so the maths is a dot product per face. Limitation (stated, not hidden): a face with any
// corner behind the near plane is skipped instead of clipped, and boxes are not split when they interpenetrate.
import {mkdirSync,existsSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {Refusal} from '../client/nikuniku-api.mjs';
import {parse,need} from './cli.mjs';
import {readJson} from './breakdown.mjs';

export const W=1280,H=720,NEAR=0.01;
const sub=(a,b)=>a.map((v,i)=>v-b[i]),dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>{const l=Math.hypot(...a);return a.map(v=>v/l);};
const fmt=v=>(Math.abs(v)<5e-4?0:v).toFixed(3);

// Camera basis: forward f, right r, up u. World up is +y; looking straight up or down falls back to -z as "up".
export function basis(cam){
 const f=norm(sub(cam.look_at,cam.position));
 let r=cross(f,[0,1,0]);if(Math.hypot(...r)<1e-6)r=cross(f,[0,0,-1]);r=norm(r);
 return {f,r,u:cross(r,f)};
}
// World point → [x,y] in SVG pixels (y down), or null when it is not in front of the camera.
export function project(p,cam,{f,r,u}){
 const d=sub(p,cam.position),z=dot(d,f);if(z<NEAR)return null;
 const focal=(H/2)/Math.tan(cam.fov_deg*Math.PI/360);
 return [W/2+focal*dot(d,r)/z,H/2-focal*dot(d,u)/z];
}
// Six faces of an axis-aligned box: outward normal + four corners in cyclic order.
export function boxFaces(box){
 const [cx,cy,cz]=box.center,[hx,hy,hz]=box.size.map(v=>v/2),out=[];
 for(const [axis,name] of [[0,'x'],[1,'y'],[2,'z']])for(const sign of [1,-1]){
  const n=[0,0,0];n[axis]=sign;
  const [a,b]=[0,1,2].filter(k=>k!==axis),h=[hx,hy,hz],c=[cx,cy,cz];
  const corners=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([sa,sb])=>{const p=[...c];p[axis]+=sign*h[axis];p[a]+=sa*h[a];p[b]+=sb*h[b];return p;});
  const centre=[...c];centre[axis]+=sign*h[axis];
  out.push({box:box.id,face:(sign>0?'+':'-')+name,normal:n,centre,corners});
 }
 return out;
}
const LIGHT=norm([0.4,1,0.6]);
export function render(scene,shot){
 const cam=shot.camera,b=basis(cam);
 const visible=scene.layout.boxes.flatMap(boxFaces)
  .filter(face=>dot(face.normal,sub(cam.position,face.centre))>0)           // back-face culling
  .map(face=>({...face,points:face.corners.map(p=>project(p,cam,b)),dist:Math.hypot(...sub(face.centre,cam.position))}))
  .filter(face=>face.points.every(Boolean))
  .sort((x,y)=>y.dist-x.dist||(x.box+x.face<y.box+y.face?-1:1));            // painter: far first, stable tie-break
 const polys=visible.map(face=>{
  const g=Math.round(110+120*Math.max(0,dot(face.normal,LIGHT)));
  return `<polygon data-box="${face.box}" data-face="${face.face}" points="${face.points.map(([x,y])=>`${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}" fill="rgb(${g},${g},${g})" stroke="#222" stroke-width="2"/>`;
 });
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" data-shot="${shot.id}" data-scene="${scene.id}" data-faces="${visible.length}" data-forward="${b.f.map(fmt).join(',')}" data-fov="${cam.fov_deg}">\n`+
  `<rect width="${W}" height="${H}" fill="#f4f4f4"/>\n`+polys.join('\n')+'\n</svg>\n';
}
function write(path,text){const tmp=path+'.tmp-'+process.pid;writeFileSync(tmp,text);renameSync(tmp,path);}
function why(plan,shot){
 const scene=plan.scenes.find(s=>s.id===shot.scene_id);
 if(!shot.camera)return ['no_camera',null];if(!scene)return ['no_scene',null];if(!scene.layout)return ['no_layout',null];return [null,scene];
}
export async function command(args){
 const o=parse(args);const file=o.positional[0];if(!file)throw new Refusal('USAGE','whitebox needs a plan path');
 const plan=readJson(file,'plan');
 if(o.shot!==undefined){
  const out=need(o,'out'),shot=plan.shots.find(s=>s.id===o.shot);
  if(!shot)throw new Refusal('USAGE',`shot ${o.shot} is not in the plan`);
  const [reason,scene]=why(plan,shot);if(reason)throw new Refusal('USAGE',`shot ${shot.id} cannot be drawn: ${reason}`);
  const svg=render(scene,shot);write(out,svg);
  return {result:{ok:true,data:{files:[out],skipped:[]}}};
 }
 const dir=need(o,'dir');if(!existsSync(dir))mkdirSync(dir,{recursive:true});
 const files=[],skipped=[];
 for(const shot of [...plan.shots].sort((a,b)=>a.order-b.order)){
  const [reason,scene]=why(plan,shot);if(reason){skipped.push({shot_id:shot.id,reason});continue;}
  const f=join(dir,shot.id+'.svg');write(f,render(scene,shot));files.push(f);
 }
 return {result:{ok:true,data:{files,skipped}}};
}
