// S2 (docs/director/SPEC.md §3): cut a local video into shots with ffmpeg's scene score, optionally extract one keyframe
// per shot for the IDE agent to describe, and place SRT lines into the shots they start in. Runs locally, needs no key and
// sends nothing anywhere. The detector does not describe pictures: framing, camera move, people, light and props stay
// "unknown"/empty with filled_by "detector" until an agent or a human fills them.
import {execFile} from 'node:child_process';
import {createReadStream,existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {Refusal} from '../client/nikuniku-api.mjs';
import {parse,need,number} from './cli.mjs';
import {validate} from './jsonschema.mjs';
import {LOCALES} from './i18n.mjs';
const run=promisify(execFile);
export const VERSION='0.1.0';

async function ff(bin,args){
 try{return await run(bin,args,{maxBuffer:64<<20});}
 catch(e){if(e.code==='ENOENT')throw new Refusal('FFMPEG_UNAVAILABLE',`${bin} was not found; install ffmpeg`,2);throw new Refusal('FFMPEG_FAILED',`${bin} exited ${e.code}`,1);}
}
export async function sha256File(path){
 const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');
}
const round=n=>Math.round(n*1000)/1000;

// Cut times from ffmpeg (scene score above threshold), then drop cuts closer than minShot to the previous kept boundary.
export function cutsToShots(cutTimes,duration,minShot){
 const kept=[];let last=0;
 for(const t of [...cutTimes].sort((a,b)=>a-b)){if(t-last>=minShot&&duration-t>=minShot){kept.push(t);last=t;}}
 const bounds=[0,...kept,duration];
 return bounds.slice(0,-1).map((start,i)=>({start_s:round(start),end_s:round(bounds[i+1])}));
}
export async function detectCuts(video,threshold){
 const {stderr}=await ff('ffmpeg',['-hide_banner','-nostats','-i',video,'-an','-vf',`select='gt(scene,${threshold})',showinfo`,'-f','null','-']);
 return [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map(m=>Number(m[1]));
}
async function duration(video){
 const {stdout}=await ff('ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',video]);
 const d=Number(stdout.trim());if(!Number.isFinite(d)||d<=0)throw new Refusal('FFMPEG_FAILED','ffprobe found no duration',1);return d;
}
// SRT: "HH:MM:SS,mmm --> HH:MM:SS,mmm" then text lines; a cue belongs to the shot its start time falls in.
export function parseSrt(text){
 const t=s=>{const [h,m,rest]=s.split(':');const [sec,ms]=rest.split(/[,.]/);return +h*3600+ +m*60+ +sec+ +ms/1000;};
 return text.replace(/\r/g,'').split(/\n\s*\n/).map(block=>{
  const lines=block.trim().split('\n');const i=lines.findIndex(l=>l.includes('-->'));if(i<0)return null;
  const [a]=lines[i].split('-->').map(s=>s.trim());const body=lines.slice(i+1).join(' ').trim();
  return body?{start_s:round(t(a)),text:body}:null;
 }).filter(Boolean);
}

export async function breakdown(video,{threshold=0.3,minShot=0.4,framesDir=null,srt=null,lang='en',sourceId=null}={}){
 if(!existsSync(video))throw new Refusal('USAGE',`video not found: ${video}`);
 const [d,cuts,digest]=await Promise.all([duration(video),detectCuts(video,threshold),sha256File(video)]);
 const shots=cutsToShots(cuts,d,minShot).map((s,i)=>({shot_index:i,...s,keyframe:null,framing:'unknown',camera_move:'unknown',characters:[],dialogue:[],lighting:null,props:[],hook:null,description:null,filled_by:'detector'}));
 if(framesDir){
  mkdirSync(framesDir,{recursive:true});
  for(const s of shots){const f=join(framesDir,String(s.shot_index).padStart(3,'0')+'.png');
   await ff('ffmpeg',['-hide_banner','-loglevel','error','-y','-ss',String((s.start_s+s.end_s)/2),'-i',video,'-frames:v','1',f]);s.keyframe=f;}
 }
 if(srt)for(const cue of parseSrt(srt)){
  const s=shots.find(x=>cue.start_s>=x.start_s&&cue.start_s<x.end_s)??shots.at(-1);
  s.dialogue.push({speaker:null,text:cue.text,lang,start_s:cue.start_s});
 }
 return {schema_version:1,source_id:sourceId??'src-'+digest.slice(0,12),source_sha256:digest,
  tool:{name:'nikuniku-director',version:VERSION,scene_threshold:threshold,min_shot_s:minShot},
  duration_s:round(d),transcript_source:srt?'srt':'none',shots};
}

export function writeJson(path,value){const tmp=path+'.tmp-'+process.pid;writeFileSync(tmp,JSON.stringify(value,null,1)+'\n');renameSync(tmp,path);}
export function readJson(path,schemaName){
 let value;try{value=JSON.parse(readFileSync(path,'utf8'));}catch(e){throw new Refusal(e.code==='ENOENT'?'USAGE':'SCHEMA_INVALID',e.code==='ENOENT'?`file not found: ${path}`:`${path} is not JSON`);}
 if(schemaName){const schema=JSON.parse(readFileSync(new URL(`../schemas/${schemaName}.schema.json`,import.meta.url),'utf8'));
  const errors=validate(schema,value);if(errors.length)throw new Refusal('SCHEMA_INVALID',`${path}: `+errors.slice(0,5).map(e=>`${e.path} ${e.message}`).join('; '));}
 return value;
}

export async function command(args){
 const o=parse(args);
 const video=o.positional[0];if(!video)throw new Refusal('USAGE','breakdown needs a video path');
 const out=need(o,'out');
 const threshold=number(o,'threshold',{min:0.01,max:1,fallback:0.3}),minShot=number(o,'min-shot',{min:0,max:10,fallback:0.4});
 let srt=null;if(o.srt!==undefined){try{srt=readFileSync(o.srt,'utf8');}catch{throw new Refusal('USAGE',`subtitle file not found: ${o.srt}`);}}
 const source=o.source?readJson(o.source,'source'):null;
 const lang=source?.lang??o['srt-lang'];
 if(srt!==null&&!LOCALES.includes(lang))throw new Refusal('USAGE',`--srt needs --srt-lang (one of ${LOCALES.join(' ')}) or --source with a lang`);
 const b=await breakdown(video,{threshold,minShot,framesDir:o.frames??null,srt,lang,sourceId:source?.source_id});
 if(source?.sha256&&source.sha256!==b.source_sha256)throw new Refusal('USAGE','the video does not match source.json sha256');
 writeJson(out,b);
 return {result:{ok:true,data:{file:out,shots:b.shots.length,source_sha256:b.source_sha256}}};
}
