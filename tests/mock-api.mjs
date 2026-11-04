// A loopback stand-in for https://api.nikuniku.ai: enough of /v1 to exercise the clients without a key or credits.
import {createServer} from 'node:http';
export const KEY='nk_test_mock_key';
const ok=data=>({status:200,body:{ok:true,data}});
const err=(status,code,message)=>({status,body:{ok:false,error:{code,message}}});
const routes={
 'GET /v1/pricing':()=>ok({price_version:'mock-1',unit:'credit_v1',video_credits_per_second:8}),
 'GET /v1/capabilities':()=>ok({schema_version:1,releases:[{alias:'h3',release_id:'h3-mock',state:'qualified',modes:[{mode:'image_to_video',duration_ms:5083,references_min:1,references_max:1,audio:'native'}]}]}),
 'GET /v1/me':()=>ok({workspace_id:'ws_000000000000000000000001',scopes:['generation:quote','billing:read']}),
 'GET /v1/wallet':()=>ok({unit_version:'credit_v1',available_units:300,reserved_units:0,consumed_units:0}),
};
export function start(){
 return new Promise(resolve=>{
  const server=createServer((req,res)=>{
   const route=routes[`${req.method} ${req.url.split('?')[0]}`];
   const authed=req.headers.authorization===`Bearer ${KEY}`;
   const r=!route?err(404,'NOT_FOUND','Route not found'):(req.url.startsWith('/v1/pricing')||req.url.startsWith('/v1/capabilities')||authed)?route():err(401,'KEY_INVALID','API key is missing or invalid');
   res.writeHead(r.status,{'content-type':'application/json'});res.end(JSON.stringify(r.body));
  });
  server.listen(0,'127.0.0.1',()=>resolve({server,base:`http://127.0.0.1:${server.address().port}`}));
 });
}
if(import.meta.url===`file://${process.argv[1]}`){const {base}=await start();console.log(base);}
