// Director kit network boundary (docs/director/SPEC.md §1, AC1). API calls go through client/nikuniku-api.mjs#call, which
// only ever talks to NIKUNIKU_API_BASE and never follows redirects. The one other fetch is a take's signed output link:
// it must be https on the API's own host and port, or on *.nikuniku.ai (default port) when the API itself is on nikuniku.ai (a loopback API may
// hand out a loopback http link on its own host). Anything else is HOST_REFUSED and nothing is written. The link is
// fetched WITHOUT the API key, with redirects refused, and its bytes must match both the link's sha256 and the sha256 the
// recipe run reported for the take.
import {createHash} from 'node:crypto';
import {writeFileSync,renameSync,readFileSync,existsSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {Refusal,call,paths} from '../client/nikuniku-api.mjs';

const onNikuniku=host=>host==='nikuniku.ai'||host.endsWith('.nikuniku.ai');
export function linkAllowed(api,link){
 let url,base;try{url=new URL(link);base=new URL(api.origin);}catch{return false;}
 if(url.username||url.password)return false;
 // Same host means same host AND port (another port is another service).
 const sameHost=url.hostname===base.hostname&&url.port===base.port;
 if(url.protocol==='https:'&&(sameHost||onNikuniku(base.hostname)&&onNikuniku(url.hostname)&&url.port===''))return true;
 return api.loopback&&url.protocol==='http:'&&sameHost;
}
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function downloadTake(api,key,ws,job,expected,out){
 if(existsSync(out)&&sha(readFileSync(out))===expected)return {file:out,sha256:expected,reused:true};
 const link=(await call(api,'GET',paths.output(job,ws),{key})).data;
 if(typeof link?.url!=='string'||!linkAllowed(api,link.url))throw new Refusal('HOST_REFUSED','the output link points outside the nikuniku hosts; nothing was written',1);
 if(link.sha256!==expected)throw new Refusal('SHA256_MISMATCH','the output link sha256 differs from the recipe run; nothing was written',1);
 let response;try{response=await fetch(link.url,{redirect:'manual',signal:AbortSignal.timeout(300000)});}catch{throw new Refusal('NETWORK_ERROR','the output could not be fetched',1);}
 if(response.status!==200)throw new Refusal('DOWNLOAD_FAILED',`output fetch answered HTTP ${response.status}`,1);
 const bytes=Buffer.from(await response.arrayBuffer());
 if(sha(bytes)!==expected)throw new Refusal('SHA256_MISMATCH','downloaded bytes do not match the output sha256; nothing was written',1);
 mkdirSync(dirname(out),{recursive:true});const tmp=out+'.tmp-'+process.pid;writeFileSync(tmp,bytes);renameSync(tmp,out);
 return {file:out,sha256:expected,reused:false};
}
