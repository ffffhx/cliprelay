'use strict';
const {jsonRequest,endpoint,fault}=require('./paired-transport.cjs');
const displayProtocol=require('./bitrate-protocol.cjs');
const leaseId=value=>typeof value==='string'&&/^[0-9a-f]{32}$/.test(value);
const instanceId=value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const errors=new Set(['PRIVACY_BUSY','PRIVACY_EXPIRED','PRIVACY_UNSUPPORTED','PRIVACY_DESKTOP_UNAVAILABLE','PRIVACY_NO_EXCLUSIVE_STREAM','PRIVACY_UNAVAILABLE']);
function state(value){
  if(value?.ok===false&&errors.has(value.code))throw fault(value.code);
  if(!value||value.ok!==true||typeof value.supported!=='boolean'||typeof value.active!=='boolean'||
    !Number.isSafeInteger(value.expiresMs)||value.expiresMs<0||value.expiresMs>15000||
    (value.lease!==undefined&&typeof value.lease!=='string'))throw fault('PRIVACY_INVALID_RESPONSE');
  const lease=value.lease||'';
  if(value.active?(!value.supported||!leaseId(lease)||value.expiresMs===0):(lease!==''||value.expiresMs!==0))throw fault('PRIVACY_INVALID_RESPONSE');
  return {supported:value.supported,active:value.active,lease,expiresMs:value.expiresMs};
}
function body(op,binding){
  if(op==='status'&&binding==null)return {op};
  if(!['start','renew','stop'].includes(op)||!binding||!instanceId(binding.instance)||
    !displayProtocol.integer(binding.stream,1)||!leaseId(binding.lease))throw fault('PRIVACY_BAD_REQUEST');
  return {op,instance:binding.instance,stream:binding.stream,lease:binding.lease};
}
async function request(host,identity,kind,binding,signal){
  if(kind==='displays'){
    try{return await displayProtocol.request(host,identity,'displays',null,signal);}
    catch(error){if(error.code==='BITRATE_INVALID_RESPONSE')throw fault('PRIVACY_INVALID_RESPONSE');throw error;}
  }
  const target=endpoint(host.address,host.port);
  // Mac activation waits for a newly filtered encoded generation. The host
  // still owns the independent 15-second grant while this request is pending.
  const timeout=kind==='start'||kind==='renew'?15000:kind==='stop'?6000:4000;
  const result=await jsonRequest({...target,port:target.port+2,path:'/v1/privacy',method:'POST',body:body(kind,binding),
    identity,trust:{cert:host.certificate},signal,timeout,limit:4096,acceptStatuses:[200,409,503]});
  return state(result);
}
module.exports={state,body,request,presented:displayProtocol.presented};
