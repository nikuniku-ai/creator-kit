// Director kit: a small JSON Schema validator (the subset docs/director/SPEC.md §2 uses), standard library only.
// Why not a package: the kit's only dependency is the MCP server SDK and REQUIREMENTS asks for node standard library;
// the schemas use type/required/properties/additionalProperties/enum/const/pattern/min*/max*/items/oneOf/$ref only.
// Returns [{path, keyword, message}]; an empty list means valid. Unknown keywords are rejected at load time so a schema
// can never silently stop checking something it appears to check.
const KNOWN=new Set(['$schema','$id','$defs','title','description','type','required','properties','additionalProperties','enum','const','pattern','minLength','maxLength','minimum','maximum','items','minItems','maxItems','oneOf','$ref','examples']);
const kind=v=>v===null?'null':Array.isArray(v)?'array':Number.isInteger(v)?'integer':typeof v;
function typeOk(t,v){const k=kind(v);return t===k||t==='number'&&(k==='integer'||k==='number');}
function resolve(root,ref){
 if(!ref.startsWith('#/'))throw new Error(`unsupported $ref ${ref}`);
 let node=root;for(const part of ref.slice(2).split('/')){node=node?.[part];if(node===undefined)throw new Error(`unresolved $ref ${ref}`);}return node;
}
function check(root,s,v,path,out){
 for(const k of Object.keys(s))if(!KNOWN.has(k))throw new Error(`unsupported schema keyword ${k} at ${path}`);
 const fail=(keyword,message)=>out.push({path,keyword,message});
 if(s.$ref)return check(root,resolve(root,s.$ref),v,path,out);
 if(s.type!==undefined){const ts=Array.isArray(s.type)?s.type:[s.type];if(!ts.some(t=>typeOk(t,v)))return fail('type',`expected ${ts.join('|')}, got ${kind(v)}`);}
 if(s.const!==undefined&&JSON.stringify(s.const)!==JSON.stringify(v))fail('const',`expected ${JSON.stringify(s.const)}`);
 if(s.enum&&!s.enum.some(e=>JSON.stringify(e)===JSON.stringify(v)))fail('enum',`expected one of ${s.enum.join(', ')}`);
 if(typeof v==='string'){
  const n=[...v].length;
  if(s.minLength!==undefined&&n<s.minLength)fail('minLength',`shorter than ${s.minLength}`);
  if(s.maxLength!==undefined&&n>s.maxLength)fail('maxLength',`longer than ${s.maxLength}`);
  if(s.pattern!==undefined&&!new RegExp(s.pattern,'u').test(v))fail('pattern',`does not match ${s.pattern}`);
 }
 if(typeof v==='number'){
  if(s.minimum!==undefined&&v<s.minimum)fail('minimum',`below ${s.minimum}`);
  if(s.maximum!==undefined&&v>s.maximum)fail('maximum',`above ${s.maximum}`);
 }
 if(Array.isArray(v)){
  if(s.minItems!==undefined&&v.length<s.minItems)fail('minItems',`fewer than ${s.minItems} items`);
  if(s.maxItems!==undefined&&v.length>s.maxItems)fail('maxItems',`more than ${s.maxItems} items`);
  if(s.items)v.forEach((item,i)=>check(root,s.items,item,`${path}[${i}]`,out));
 }
 if(kind(v)==='object'){
  for(const r of s.required??[])if(!Object.hasOwn(v,r))fail('required',`missing ${r}`);
  for(const [k,item] of Object.entries(v)){
   const sub=s.properties?.[k];
   if(sub)check(root,sub,item,`${path}.${k}`,out);
   else if(s.additionalProperties===false)out.push({path:`${path}.${k}`,keyword:'additionalProperties',message:'not allowed'});
   else if(s.additionalProperties&&typeof s.additionalProperties==='object')check(root,s.additionalProperties,item,`${path}.${k}`,out);
  }
 }
 if(s.oneOf){const passing=s.oneOf.filter(sub=>{const o=[];check(root,sub,v,path,o);return o.length===0;}).length;if(passing!==1)fail('oneOf',`matches ${passing} of ${s.oneOf.length} alternatives`);}
}
export function validate(schema,value){const out=[];check(schema,schema,value,'$',out);return out;}
