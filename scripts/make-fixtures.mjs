#!/usr/bin/env node
// Builds the synthetic test video fixtures/x.mp4 (3.5 s, three visually distinct shots; labels in fixtures/x.truth.json)
// and fixtures/takes/{s1,s2}.mp4 (two 1 s clips for assemble). Generated, not committed (.gitignore *.mp4), so the repo
// carries no third-party footage. Idempotent: existing files are kept. Needs ffmpeg.
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..','fixtures');
const ff=args=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{stdio:['ignore','ignore','inherit']});
const SIZE='64x36',RATE=10;
export function makeFixtures(){
 mkdirSync(join(root,'takes'),{recursive:true});
 const x=join(root,'x.mp4');
 if(!existsSync(x))ff(['-f','lavfi','-i',`testsrc2=s=${SIZE}:r=${RATE}:d=1`,'-f','lavfi','-i',`smptebars=s=${SIZE}:r=${RATE}:d=1.5`,'-f','lavfi','-i',`mandelbrot=s=${SIZE}:r=${RATE}`,
  '-filter_complex','[2:v]trim=duration=1,setpts=PTS-STARTPTS[m];[0:v][1:v][m]concat=n=3:v=1:a=0,format=yuv420p[v]','-map','[v]','-c:v','libx264','-g',String(RATE),x]);
 for(const [name,src] of [['s1','testsrc2'],['s2','smptebars']]){
  const f=join(root,'takes',name+'.mp4');
  if(!existsSync(f))ff(['-f','lavfi','-i',`${src}=s=${SIZE}:r=${RATE}:d=1`,'-c:v','libx264','-pix_fmt','yuv420p','-g',String(RATE),f]);
 }
 return {video:x,takes:join(root,'takes')};
}
if(import.meta.url===`file://${process.argv[1]}`)process.stdout.write(JSON.stringify(makeFixtures())+'\n');
