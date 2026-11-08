// Shared test helpers: run the CLI as a child process and collect stdout, stderr and exit code without throwing.
import {execFile} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export function cli(args,env={},{input}={}){
 return new Promise(resolve=>{
  const child=execFile(process.execPath,['cli/nikuniku.mjs',...args],{env:{...process.env,NIKUNIKU_LANG:'en',...env},maxBuffer:8<<20},(error,stdout,stderr)=>{
   resolve({code:error?(typeof error.code==='number'?error.code:1):0,stdout,stderr,json:(()=>{try{return JSON.parse(stdout);}catch{return null;}})(),
    err:(()=>{try{return JSON.parse(stderr.split('\n')[0]);}catch{return null;}})()});});
  if(input!==undefined){child.stdin.end(input);}
 });
}
export const tmp=()=>mkdtempSync(join(tmpdir(),'dk-'));
