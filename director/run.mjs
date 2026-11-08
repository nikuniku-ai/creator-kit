// `nikuniku run` (docs/director/SPEC.md §3 run): S7→S10 in one go — API key first (AC11), then shoot (which lints and
// checks accept/sources before any request) with downloads, then assemble. Stops at the first step that does not succeed.
import {join,dirname,resolve} from 'node:path';
import {parse,need} from './cli.mjs';
import {shoot} from './shoot.mjs';
import {assemble} from './assemble.mjs';
import {apiKey} from '../client/nikuniku-api.mjs';
export async function command(args){
 const o=parse(args,{multi:['source','shot']});
 apiKey(process.env.NIKUNIKU_API_KEY);
 const out=resolve(need(o,'out')),dir=dirname(out);
 const ledger=o.ledger??join(dir,'gacha-ledger.json'),takes=o.takes??join(dir,'takes');
 const shot=await shoot({...o,ledger,takes});
 if(shot.exit)return shot;
 const cut=await assemble({positional:o.positional,ledger,takes,out,recipe:o.recipe});
 if(cut.exit)return cut;
 return {result:{ok:true,data:{shoot:shot.result.data,assemble:cut.result.data}},notice:cut.notice};
}
