// S1 (docs/director/SPEC.md §3 S1): write source.json for a reference the creator supplies (a URL or a local file).
// Nothing is downloaded or fetched: a URL is only recorded. Rights are the creator's statement; unlicensed_reference and
// unknown are analysis-only (REQUIREMENTS D4 — whether a use is lawful is for a lawyer / Yves, not this tool).
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {Refusal} from '../client/nikuniku-api.mjs';
import {parse,need} from './cli.mjs';
import {writeJson,sha256File,duration} from './breakdown.mjs';
import {validate} from './jsonschema.mjs';
import {semantics} from './semantics.mjs';
import {LOCALES} from './i18n.mjs';


const RIGHTS=['owned','licensed','public_domain','unlicensed_reference','unknown'];
export async function command(args){
 const o=parse(args);const out=need(o,'out');
 if((o.url===undefined)===(o.file===undefined))throw new Refusal('USAGE','give exactly one of --url and --file');
 if(!RIGHTS.includes(o.rights))throw new Refusal('USAGE',`--rights must be one of ${RIGHTS.join(' ')}`);
 const lang=need(o,'source-lang');if(!LOCALES.includes(lang))throw new Refusal('USAGE',`--source-lang must be one of ${LOCALES.join(' ')}`);
 let sha=null,ms=null;
 if(o.file!==undefined){if(!existsSync(o.file))throw new Refusal('USAGE',`file not found: ${o.file}`);sha=await sha256File(o.file);ms=Math.round(await duration(o.file)*1000);}
 const id=o.id??'src-'+(sha??createHash('sha256').update(o.url).digest('hex')).slice(0,12);
 const source={schema_version:1,source_id:id,url:o.url??null,local_file:o.file??null,sha256:sha,duration_ms:ms,lang,
  found_by:o['found-by']??(o.file!==undefined?'creator_file':'creator_url'),rights:{status:o.rights,ref:o['rights-ref']??null,note:o.note??null},
  usable_for:['unlicensed_reference','unknown'].includes(o.rights)?'analysis_only':'generation',created_at:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')};
 const schema=JSON.parse(readFileSync(new URL('../schemas/source.schema.json',import.meta.url),'utf8'));
 const bad=[...validate(schema,source),...semantics('source',source)];
 if(bad.length)throw new Refusal('USAGE',`source.json would be invalid: ${bad[0].path} ${bad[0].message}`);
 writeJson(out,source);
 return {result:{ok:true,data:{file:out,source_id:id,usable_for:source.usable_for}}};
}
