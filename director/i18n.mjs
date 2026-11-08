// Director kit messages (SPEC §7). Machine output never goes through here: stdout JSON and the first stderr JSON line
// are identical in every language; this only renders the second, human stderr line.
import {readFileSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export const LOCALES=['en','zh-Hant','zh-Hans','ja','ko','vi','id','th','es','pt-BR','fr','de','ar','hi'];
const dir=join(dirname(fileURLToPath(import.meta.url)),'..','locales','director');
const ALIASES={zh_TW:'zh-Hant',zh_HK:'zh-Hant',zh_CN:'zh-Hans',zh_SG:'zh-Hans',pt_BR:'pt-BR',pt:'pt-BR'};
export function pickLang(flag,env=process.env){
 for(const raw of [flag,env.NIKUNIKU_LANG,env.LC_ALL,env.LANG]){
  if(!raw)continue;
  if(LOCALES.includes(raw))return raw;
  const base=raw.split('.')[0];
  if(ALIASES[base])return ALIASES[base];
  const lang=base.split(/[_-]/)[0];
  if(LOCALES.includes(lang))return lang;
 }
 return 'en';
}
const cache=new Map();
export function messages(lang){
 if(!cache.has(lang)){const f=join(dir,lang+'.json');cache.set(lang,existsSync(f)?JSON.parse(readFileSync(f,'utf8')):{});}
 return cache.get(lang);
}
// Unicode isolates keep an Arabic line readable when it embeds ids, paths and numbers (left-to-right runs).
export function render(lang,key,vars={}){
 const table=messages(lang),fallback=messages('en');
 let text=table[key]??fallback[key]??key;
 text=text.replace(/\{(\w+)\}/g,(_,k)=>String(vars[k]??''));
 return (table.dir??'ltr')==='rtl'?`⁧${text}⁩`:text;
}
