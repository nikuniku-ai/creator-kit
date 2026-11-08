// Director kit: a small JSON Schema validator (the subset docs/director/SPEC.md §2 uses), standard library only.
// Why not a package: the kit's only dependency is the MCP server SDK and the kit keeps to the node standard library;
// the schemas use type/required/properties/additionalProperties/enum/const/pattern/min*/max*/items/oneOf/$ref only.
// validate() returns [{path, keyword, message}]; an empty list means valid. checkSchema() walks the WHOLE schema before
// any value is checked and throws on an unknown keyword, a bad keyword argument, an invalid regex or
// an unresolved $ref, so a schema can never silently stop checking something it appears to check.
const KNOWN=new Set(['$schema','$id','$defs','title','description','type','required','properties','additionalProperties','enum','const','pattern','minLength','maxLength','minimum','maximum','items','minItems','maxItems','oneOf','$ref','examples']);
const TYPES=new Set(['null','boolean','object','array','number','integer','string']);
const kind=v=>v===null?'null':Array.isArray(v)?'array':Number.isInteger(v)?'integer':typeof v;
const own=(o,k)=>o!==null&&typeof o==='object'&&Object.hasOwn(o,k);
function typeOk(t,v){const k=kind(v);return t===k||t==='number'&&(k==='integer'||k==='number');}
// JSON value equality independent of object key order.
export function equal(a,b){
 if(a===b)return true;const ka=kind(a);if(ka!==kind(b)||ka!=='array'&&ka!=='object')return false;
 if(ka==='array')return a.length===b.length&&a.every((x,i)=>equal(x,b[i]));
 const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>own(b,k)&&equal(a[k],b[k]));
}
function resolve(root,ref){
 if(ref==='#')return root;
 if(!ref.startsWith('#/'))throw new Error(`unsupported $ref ${ref}`);
 let node=root;
 for(const raw of ref.slice(2).split('/')){const part=raw.replace(/~1/g,'/').replace(/~0/g,'~');if(!own(node,part))throw new Error(`unresolved $ref ${ref} (missing ${part})`);node=node[part];}
 return node;
}
const nonNegInt=v=>Number.isInteger(v)&&v>=0;
export function checkSchema(root){
 const walk=(s,path)=>{
  if(typeof s==='boolean')return;
  if(kind(s)!=='object')throw new Error(`schema at ${path} must be an object or boolean`);
  for(const k of Object.keys(s))if(!KNOWN.has(k))throw new Error(`unsupported schema keyword ${k} at ${path}`);
  const bad=k=>{throw new Error(`invalid ${k} at ${path}`);};
  if(own(s,'type')){const ts=Array.isArray(s.type)?s.type:[s.type];if(!ts.length||!ts.every(t=>TYPES.has(t)))bad('type');}
  for(const k of ['minLength','maxLength','minItems','maxItems'])if(own(s,k)&&!nonNegInt(s[k]))bad(k);
  for(const k of ['minimum','maximum'])if(own(s,k)&&typeof s[k]!=='number')bad(k);
  if(own(s,'pattern')){if(typeof s.pattern!=='string')bad('pattern');try{new RegExp(s.pattern,'u');}catch{bad('pattern');}}
  if(own(s,'enum')&&(!Array.isArray(s.enum)||!s.enum.length))bad('enum');
  if(own(s,'required')&&(!Array.isArray(s.required)||!s.required.every(r=>typeof r==='string')))bad('required');
  if(own(s,'$ref')){if(typeof s.$ref!=='string')bad('$ref');resolve(root,s.$ref);}
  if(own(s,'properties')){if(kind(s.properties)!=='object')bad('properties');for(const [k,v] of Object.entries(s.properties))walk(v,`${path}.properties.${k}`);}
  if(own(s,'$defs')){if(kind(s.$defs)!=='object')bad('$defs');for(const [k,v] of Object.entries(s.$defs))walk(v,`${path}.$defs.${k}`);}
  if(own(s,'additionalProperties'))walk(s.additionalProperties,`${path}.additionalProperties`);
  if(own(s,'items'))walk(s.items,`${path}.items`);
  if(own(s,'oneOf')){if(!Array.isArray(s.oneOf)||!s.oneOf.length)bad('oneOf');s.oneOf.forEach((v,i)=>walk(v,`${path}.oneOf[${i}]`));}
 };
 walk(root,'#');return root;
}
function check(root,s,v,path,out){
 if(s===true)return;
 if(s===false)return out.push({path,keyword:'false',message:'no value is allowed here'});
 const fail=(keyword,message)=>out.push({path,keyword,message});
 // A $ref and its siblings both apply.
 if(own(s,'$ref'))check(root,resolve(root,s.$ref),v,path,out);
 if(own(s,'type')){const ts=Array.isArray(s.type)?s.type:[s.type];if(!ts.some(t=>typeOk(t,v)))return fail('type',`expected ${ts.join('|')}, got ${kind(v)}`);}
 if(own(s,'const')&&!equal(s.const,v))fail('const',`expected ${JSON.stringify(s.const)}`);
 if(own(s,'enum')&&!s.enum.some(e=>equal(e,v)))fail('enum',`expected one of ${s.enum.join(', ')}`);
 if(typeof v==='string'){
  const n=[...v].length;
  if(own(s,'minLength')&&n<s.minLength)fail('minLength',`shorter than ${s.minLength}`);
  if(own(s,'maxLength')&&n>s.maxLength)fail('maxLength',`longer than ${s.maxLength}`);
  if(own(s,'pattern')&&!new RegExp(s.pattern,'u').test(v))fail('pattern',`does not match ${s.pattern}`);
 }
 if(typeof v==='number'){
  if(own(s,'minimum')&&v<s.minimum)fail('minimum',`below ${s.minimum}`);
  if(own(s,'maximum')&&v>s.maximum)fail('maximum',`above ${s.maximum}`);
 }
 if(Array.isArray(v)){
  if(own(s,'minItems')&&v.length<s.minItems)fail('minItems',`fewer than ${s.minItems} items`);
  if(own(s,'maxItems')&&v.length>s.maxItems)fail('maxItems',`more than ${s.maxItems} items`);
  if(own(s,'items'))v.forEach((item,i)=>check(root,s.items,item,`${path}[${i}]`,out));
 }
 if(kind(v)==='object'){
  for(const r of s.required??[])if(!Object.hasOwn(v,r))fail('required',`missing ${r}`);
  for(const [k,item] of Object.entries(v)){
   // Own properties only: inherited names such as constructor or __proto__ are not declared fields.
   if(own(s.properties,k))check(root,s.properties[k],item,`${path}.${k}`,out);
   else if(s.additionalProperties===false)out.push({path:`${path}.${k}`,keyword:'additionalProperties',message:'not allowed'});
   else if(own(s,'additionalProperties'))check(root,s.additionalProperties,item,`${path}.${k}`,out);
  }
 }
 if(own(s,'oneOf')){const passing=s.oneOf.filter(sub=>{const o=[];check(root,sub,v,path,o);return o.length===0;}).length;if(passing!==1)fail('oneOf',`matches ${passing} of ${s.oneOf.length} alternatives`);}
}
export function validate(schema,value){
 if(typeof schema!=='boolean')checkSchema(schema);
 const out=[];check(schema,schema,value,'$',out);return out;
}
