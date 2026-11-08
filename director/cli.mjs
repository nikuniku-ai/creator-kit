// Director kit command entry (docs/director/SPEC.md §4). cli/nikuniku.mjs hands these commands here so the exported CLI
// file changes by one line. Output contract: one JSON line on stdout; on failure the first stderr line is the untranslated
// {ok:false,error:{code,message}} envelope and the second is the localized message. Exit codes per SPEC §5.
import {Refusal,ApiError} from '../client/nikuniku-api.mjs';
import {pickLang,render} from './i18n.mjs';
export const COMMANDS=new Set(['source','breakdown','plan','lint','whitebox','shoot']);
export function parse(rest,{multi=[],flags=[]}={}){
 const out={positional:[]};
 for(let i=0;i<rest.length;i++){const a=rest[i];
  if(flags.includes(a)){out[a.slice(2)]=true;continue;}
  if(a.startsWith('--')){const v=rest[i+1];if(v===undefined||v.startsWith('--'))throw new Refusal('USAGE',`${a} needs a value`);
   const k=a.slice(2);if(multi.includes(k))(out[k]??=[]).push(v);else out[k]=v;i++;}
  else out.positional.push(a);}
 return out;
}
export const need=(o,name)=>{const v=o[name];if(typeof v!=='string'||!v)throw new Refusal('USAGE',`--${name} is required`);return v;};
export function number(o,name,{min,max,fallback}){
 if(o[name]===undefined)return fallback;
 const n=Number(o[name]);if(o[name].trim()===''||!Number.isFinite(n)||n<min||n>max)throw new Refusal('USAGE',`--${name} must be a number from ${min} to ${max}`);return n;
}
const handlers={
 source:async o=>(await import('./source.mjs')).command(o),
 breakdown:async o=>(await import('./breakdown.mjs')).command(o),
 plan:async o=>(await import('./plan.mjs')).command(o),
 lint:async o=>(await import('./lint.mjs')).command(o),
 whitebox:async o=>(await import('./whitebox.mjs')).command(o),
 shoot:async o=>(await import('./shoot.mjs')).command(o),
};
export async function runDirector(command,rest){
 let lang='en';
 try{
  const i=rest.indexOf('--lang');if(i>=0)lang=pickLang(rest[i+1]);else lang=pickLang(undefined);
  const args=i>=0?[...rest.slice(0,i),...rest.slice(i+2)]:rest;
  const {exit=0,result}=await handlers[command](args);
  process.stdout.write(JSON.stringify(result)+'\n');
  if(exit!==0&&result?.error)process.stderr.write(JSON.stringify({ok:false,error:result.error})+'\n'+render(lang,'error.'+result.error.code,{message:result.error.message})+'\n');
  return exit;
 }catch(error){
  if(error instanceof ApiError){process.stderr.write(JSON.stringify(error.body)+'\n'+render(lang,'error.API_ERROR',{message:error.body?.error?.code??''})+'\n');return 1;}
  const r=error instanceof Refusal?error:new Refusal('INTERNAL',error instanceof Error&&error.code==='ENOENT'?'input file not found':'unexpected error',2);
  process.stderr.write(JSON.stringify({ok:false,error:{code:r.code,message:r.message}})+'\n'+render(lang,'error.'+r.code,{message:r.message})+'\n');
  return r.exit;
 }
}
