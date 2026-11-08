// A loopback stand-in for https://api.nikuniku.ai: enough of /v1 to exercise the clients without a key or credits.
// Director kit extension (docs/director/SPEC.md §8): recipe quotes/runs/recipe-runs with a scripted server-side acceptance
// verdict per (shot, take), job outputs served from loopback, and a log of every request so tests can assert "0 requests"
// and "no provider/route/model key was sent". Request bodies for the recipe routes are checked with the same exact key sets
// as the core (apps/api/src/http/v1.ts: quotes {workspace_id, inputs}; runs {workspace_id, inputs, max_credits, dry_run,
// idempotency_key}); every inputs value must be a string, as the core's recipe input validator requires.
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
export const KEY='nk_test_mock_key';
export const WS='ws_000000000000000000000001';
const ok=data=>({status:200,body:{ok:true,data}});
const err=(status,code,message)=>({status,body:{ok:false,error:{code,message}}});
const routes={
 'GET /v1/pricing':()=>ok({price_version:'mock-1',unit:'credit_v1',video_credits_per_second:8}),
 // h3mv / multi_image_song is a MOCK-ONLY release and mode name: core mode names come from release manifests
 // (apps/api/src/modules/catalog/capabilities.ts); a sold mode with audio 'external' takes a song (E1).
 'GET /v1/capabilities':()=>ok({schema_version:1,releases:[{alias:'h3',release_id:'h3-mock',state:'qualified',modes:[{mode:'image_to_video',duration_ms:5083,references_min:1,references_max:1,audio:'native'}]},
  {alias:'h3mv',release_id:'h3mv-mock',state:'qualified',modes:[{mode:'multi_image_song',duration_ms:10000,references_min:1,references_max:4,audio:'external'}]}]}),
 'GET /v1/me':()=>ok({workspace_id:WS,scopes:['generation:quote','billing:read']}),
 'GET /v1/wallet':()=>ok({unit_version:'credit_v1',available_units:300,reserved_units:0,consumed_units:0}),
};
// MV / generate path (E1): assets, audio, prompt check, drafts, quotes, jobs. Drafts are kept for assertions.
function media(method,path,body,state){
 let m;
 if(method==='POST'&&path==='/v1/assets')return ok({asset_id:'asset_'+body.declaration.idempotency_key.slice(-12),state:'pending'});
 if(method==='PUT'&&(m=path.match(/^\/v1\/assets\/([^/]+)\/content$/)))return ok({asset_id:m[1],state:'available'});
 if(method==='POST'&&path==='/v1/audio')return ok({audio_id:'audio_'+body.declaration.idempotency_key.slice(-12),state:'pending'});
 if(method==='PUT'&&(m=path.match(/^\/v1\/audio\/([^/]+)\/content$/)))return ok({audio_id:m[1],state:'available',duration_ms:2000});
 if(method==='POST'&&path==='/v1/prompts/check')return ok({passed:!String(body.prompt).includes('BAD'),findings:[]});
 if(method==='POST'&&path==='/v1/drafts'){const d=JSON.parse(body.draft_json);state.drafts.push(d);return ok({project_id:d.project.project_id,revision:1});}
 if(method==='POST'&&path==='/v1/quotes')return ok({quote_id:'q_mv',max_units:state.director.mvUnits??80,unit_version:'credit_v1',input_hash:'f'.repeat(64)});
 if(method==='POST'&&path==='/v1/jobs')return ok({job_id:'job_mv',state:'queued'});
 return null;
}
const exact=(body,keys)=>body&&typeof body==='object'&&Object.keys(body).sort().join(',')===[...keys].sort().join(',');
const strings=inputs=>inputs&&typeof inputs==='object'&&!Array.isArray(inputs)&&Object.values(inputs).every(v=>typeof v==='string');

// director: {outcomes:{[shot_id]:[outcome per take]}, maxUnits, files:{[shot_id]:path}, outputHost}
//   outcome: {verdict:'passed'|'failed'|'pending', failure_class?, route?, charged_units?}
//          | {state:'failed'|'cancelled'} | {acceptance:'absent'} | {verdict:'weird'} | {polls:n, ...} (n running polls first)
//   failRunOnce: the next runs call answers 503 (a crash between quote and run)
//   outputHost: base URL put in output links; redirectFiles: /files/* answers 302 to this URL
//   badRunId: runs answer an invalid job_id; nullSnapshot: recipe-runs answer data:null;
//   badLinkSha: output links carry a wrong sha256; tamperFiles: /files/* flips the first byte
// recipe-runs (★ CORE-ASKS C4 proposal): a run is visible only in the workspace that made it, and its snapshot echoes the
// inputs it was run with (shot_json, plan_sha256, take) so a client can bind the verdict to one shot of one plan.
export function start(options={}){
 const director={outcomes:{},maxUnits:40,files:{},outputHost:null,...options.director};
 const requests=[],runs=new Map(),byKey=new Map(),quotes=new Map(),drafts=[];let seq=0;
 const recipe=(method,path,body,base,query)=>{
  let m;
  if(method==='POST'&&(m=path.match(/^\/v1\/recipes\/([a-z][a-z0-9_]{1,63})\/quotes$/))){
   if(!exact(body,['workspace_id','inputs'])||!strings(body.inputs))return err(400,'INVALID_INPUT','quotes takes exactly {workspace_id, inputs} with string inputs');
   const shot=JSON.parse(body.inputs.shot_json);const q={quote_id:`q_${++seq}`,max_units:director.maxUnits,unit_version:'credit_v1',
    input_hash:createHash('sha256').update(JSON.stringify([m[1],body.inputs])).digest('hex'),recipe_id:m[1],recipe_version:'1',shot_id:shot.id,take:Number(body.inputs.take)};
   quotes.set(q.quote_id,q);return ok(q);
  }
  if(method==='POST'&&(m=path.match(/^\/v1\/recipes\/([a-z][a-z0-9_]{1,63})\/runs$/))){
   if(!exact(body,['workspace_id','inputs','max_credits','dry_run','idempotency_key'])||!strings(body.inputs)||body.dry_run!==false)return err(400,'INVALID_INPUT','runs takes exactly {workspace_id, inputs, max_credits, dry_run:false, idempotency_key}');
   if(director.failRunOnce){director.failRunOnce=false;return err(503,'TEMPORARILY_UNAVAILABLE','try again');}
   if(byKey.has(body.idempotency_key))return ok(runs.get(byKey.get(body.idempotency_key)).public);
   if(body.max_credits<director.maxUnits)return err(402,'ABOVE_MAX_CREDITS','max_credits is below the quote');
   const shot=JSON.parse(body.inputs.shot_json),take=Number(body.inputs.take),job=`job_${shot.id}_${take}`;
   const outcome=(director.outcomes[shot.id]??[])[take-1]??{verdict:'passed'};
   const run={public:{run_id:job,job_id:director.badRunId?'bad id!':job,state:'queued',recipe_id:m[1],recipe_version:'1'},shot:shot.id,take,outcome,polls:0,workspace:body.workspace_id,inputs:body.inputs};
   runs.set(job,run);byKey.set(body.idempotency_key,job);return ok(run.public);
  }
  if(method==='GET'&&(m=path.match(/^\/v1\/recipe-runs\/([^/?]+)$/))){
   const run=runs.get(m[1]);if(!run||(run.workspace??WS)!==query.get('workspace_id'))return err(404,'NOT_FOUND','no such run');
   if(director.nullSnapshot)return ok(null);
   const o=run.outcome;run.polls++;
   if(o.polls&&run.polls<=o.polls)return ok({...run.public,state:'running'});
   if(o.state)return ok({...run.public,state:o.state,acceptance:null,route:null});
   const snap={...run.public,...(run.inputs?{inputs:run.inputs}:{}),state:'succeeded',route:o.route??'general',charged_units:o.charged_units??(o.verdict==='passed'?director.maxUnits:null)};
   if(o.verdict==='passed'){const bytes=output(run);snap.output_sha256=createHash('sha256').update(bytes).digest('hex');}
   if(o.acceptance!=='absent')snap.acceptance={verdict:o.verdict,failure_class:o.failure_class??null,checks:[]};
   return ok(snap);
  }
  if(method==='GET'&&(m=path.match(/^\/v1\/jobs\/([^/?]+)\/output$/))){
   const run=runs.get(m[1]);if(!run||run.outcome.verdict!=='passed')return err(404,'NOT_FOUND','no output');
   const bytes=output(run);
   return ok({output_id:'out_'+m[1],url:(director.outputHost??base)+'/files/'+m[1],sha256:director.badLinkSha?'0'.repeat(64):createHash('sha256').update(bytes).digest('hex')});
  }
  return null;
 };
 const output=run=>director.files[run.shot]?readFileSync(director.files[run.shot]):Buffer.from(`mock take ${run.shot} ${run.take}\n`);
 return new Promise(resolve=>{
  const server=createServer((req,res)=>{
   const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
    const path=req.url.split('?')[0],text=Buffer.concat(chunks).toString('utf8');let body;try{body=text?JSON.parse(text):undefined;}catch{body=text;}
    requests.push({method:req.method,path,url:req.url,body,authorization:req.headers.authorization??null});
    const base=`http://127.0.0.1:${server.address().port}`;
    if(req.method==='GET'&&path.startsWith('/files/')&&director.redirectFiles){res.writeHead(302,{location:director.redirectFiles});res.end();return;}
    if(req.method==='GET'&&path.startsWith('/files/')){const run=runs.get(path.slice(7));
     if(!run){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':'video/mp4'});const b=Buffer.from(output(run));if(director.tamperFiles)b[0]^=1;res.end(b);return;}
    const route=routes[`${req.method} ${path}`];
    const authed=req.headers.authorization===`Bearer ${KEY}`;
    const open=path.startsWith('/v1/pricing')||path.startsWith('/v1/capabilities');
    const r=!authed&&!open?err(401,'KEY_INVALID','API key is missing or invalid'):route?route():recipe(req.method,path,body,base,new URL(req.url,'http://x').searchParams)??media(req.method,path,body,{drafts,director})??err(404,'NOT_FOUND','Route not found');
    res.writeHead(r.status,{'content-type':'application/json'});res.end(JSON.stringify(r.body));
   });
  });
  server.listen(0,'127.0.0.1',()=>resolve({server,base:`http://127.0.0.1:${server.address().port}`,requests,director,runs,drafts,
   reset(){requests.length=0;drafts.length=0;runs.clear();byKey.clear();quotes.clear();Object.assign(director,{outcomes:{},maxUnits:40,files:{},outputHost:null,failRunOnce:false,redirectFiles:null,mvUnits:80,badRunId:false,nullSnapshot:false,badLinkSha:false,tamperFiles:false});}}));
 });
}
if(import.meta.url===`file://${process.argv[1]}`){const {base}=await start();console.log(base);}
