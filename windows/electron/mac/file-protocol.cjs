'use strict';
const crypto=require('node:crypto');
const {jsonRequest,endpoint,fault}=require('./paired-transport.cjs');
const CHUNK=256*1024,LIMIT=2**40;
const errors=new Set(['FILES_BAD_REQUEST','FILES_BAD_PATH','FILES_LINK_NOT_ALLOWED','FILES_NOT_FOUND','FILES_INVALID_STATE','FILES_ACCESS_DENIED','FILES_DISK_FULL','FILES_IO','FILES_NOT_READY','FILES_OFFSET','FILES_HASH_MISMATCH','FILES_ID_CONFLICT','FILES_QUEUE_FULL','FILES_TOO_LARGE','FILES_EXISTS','FILES_CHUNK_CONFLICT','FILES_SOURCE_CHANGED','FILES_UNAVAILABLE','FILES_BUSY']);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const hash=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const id=value=>typeof value==='string' && /^[a-f0-9]{32}$/.test(value);
const integer=(value,max=LIMIT)=>Number.isSafeInteger(value) && value>=0 && value<=max;
function requireValue(value,code='FILES_INVALID_RESPONSE'){if(!value)throw fault(code);}
function safeName(value){
  requireValue(typeof value==='string' && value.length>0 && value.length<=200 && value.trim()===value && !/[\\/:*?"<>|\x00-\x1f]/.test(value) &&
    !value.endsWith('.') && !/^\.cliprelay-/i.test(value) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value),'FILES_BAD_PATH');
  return value;
}
function location(root,path){
  requireValue(typeof root==='string' && /^[a-z][a-z0-9-]{0,31}$/.test(root) && typeof path==='string' && path.length<=1000,'FILES_BAD_PATH');
  if(path)path.split('/').forEach(safeName);return {root,path};
}
function validateReply(command,value){
  requireValue(value && typeof value==='object' && !Array.isArray(value) && typeof value.ok==='boolean');
  if(!value.ok)throw fault(errors.has(value.code)?value.code:'FILES_UNAVAILABLE');
  if(command.op==='mkdir')return {ok:true};
  if(command.op==='roots'){
    requireValue(Array.isArray(value.roots) && value.roots.length<=16 && value.chunkSize===CHUNK);
    const seen=new Set();return {roots:value.roots.map(root=>{
      location(root.id,'');requireValue(!seen.has(root.id) && typeof root.name==='string' && root.name.length<=128 && !/[\x00-\x1f]/.test(root.name) && typeof root.writable==='boolean');seen.add(root.id);
      return {id:root.id,name:root.name,writable:root.writable};
    })};
  }
  if(command.op==='list'){
    requireValue(value.root===command.root && (value.path || '')===command.path && (!value.next || typeof value.next==='string' && value.next.length<=1024) && (!value.entries || Array.isArray(value.entries) && value.entries.length<=256));
    const seen=new Set();return {root:value.root,path:value.path || '',next:value.next || '',entries:(value.entries || []).map(entry=>{
      requireValue(typeof entry.name==='string' && entry.name.length<=32768 && !seen.has(entry.name) && typeof entry.directory==='boolean' && typeof entry.blocked==='boolean' && typeof entry.hidden==='boolean' && integer(entry.size) && Number.isSafeInteger(entry.modified));seen.add(entry.name);
      let blocked=entry.blocked;try{safeName(entry.name);}catch{blocked=true;}
      return {name:entry.name,directory:entry.directory,blocked,hidden:entry.hidden,size:entry.size,modified:entry.modified};
    })};
  }
  requireValue(value.id===command.id && id(value.id) && integer(value.size) && integer(value.offset,value.size));
  if(command.op==='download-chunk'){
    const data=value.data || '';requireValue(value.offset===command.offset && typeof data==='string' && data.length<=Math.ceil(CHUNK/3)*4 && hash(value.sha256));
    const bytes=Buffer.from(data,'base64');
    requireValue(bytes.toString('base64')===data && bytes.length===Math.min(CHUNK,value.size-value.offset));
    requireValue(sha(bytes)===value.sha256,'FILES_HASH_MISMATCH');return {offset:value.offset,size:value.size,bytes};
  }
  requireValue(['upload','download'].includes(value.direction) && ['uploading','preparing','queued','verifying','committing','ready','complete','cancelled','error'].includes(value.state) && value.chunkSize===CHUNK && integer(value.verified,value.size));
  location(value.root,value.directory || '');safeName(value.name);if(value.finalName)safeName(value.finalName);
  requireValue(!value.sha256 || hash(value.sha256));
  return {id:value.id,root:value.root,path:value.directory || '',name:value.name,direction:value.direction,size:value.size,offset:value.offset,verified:value.verified,sha256:value.sha256 || '',state:value.state,finalName:value.finalName || '',code:errors.has(value.code)?value.code:''};
}
async function request(host,identity,command,signal){
  const target=endpoint(host.address,host.port);
  const reply=await jsonRequest({address:target.address,port:target.port+2,path:'/v1/files',identity,trust:{cert:host.certificate},signal,body:command,
    timeout:45000,limit:400*1024,acceptStatuses:[200,409,429,503]});
  return validateReply(command,reply);
}
module.exports={CHUNK,LIMIT,errors,sha,hash,id,integer,requireValue,safeName,location,validateReply,request};
