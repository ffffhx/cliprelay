'use strict';
const {jsonRequest,endpoint,fault}=require('./paired-transport.cjs');
const video=require('./bitrate-protocol.cjs');
const errors=new Set(['LOCK_BUSY','LOCK_EXPIRED','LOCK_UNSUPPORTED','LOCK_DESKTOP_UNAVAILABLE','LOCK_NO_EXCLUSIVE_STREAM','LOCK_UNAVAILABLE','LOCK_CANCEL_PENDING','LOCK_ALREADY_REQUESTED']);
const id=value=>typeof value==='string'&&/^[0-9a-f]{32}$/.test(value);
const guid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
function invalid(){return fault('LOCK_INVALID_RESPONSE');}
function state(value){
  if(value?.ok===false&&errors.has(value.code))throw fault(value.code);
  if(!value||value.ok!==true||typeof value.supported!=='boolean'||
    (value.cancelProtected!==undefined&&typeof value.cancelProtected!=='boolean')||
    !['off','armed','requested','locked','failed','cancelled'].includes(value.state)||!video.integer(value.expiresMs,0,15000))throw invalid();
  const lease=value.lease===undefined?'':value.lease,instance=value.instance===undefined?'':value.instance,stream=value.stream===undefined?0:value.stream;
  if(typeof lease!=='string'||typeof instance!=='string'||!video.integer(stream))throw invalid();
  if(value.state==='off'){
    if(lease!==''||instance!==''||stream!==0||value.expiresMs!==0)throw invalid();
  }else if(!value.supported||!id(lease)||!guid(instance)||stream===0||(['armed','requested'].includes(value.state)!==(value.expiresMs>0)))throw invalid();
  return {supported:value.supported,cancelProtected:value.cancelProtected===true,state:value.state,lease,instance,stream,expiresMs:value.expiresMs};
}
function body(op,binding){
  if(op==='status'&&binding==null)return {op};
  if(!['arm','disarm'].includes(op)||!binding||!guid(binding.instance)||!video.integer(binding.stream,1)||!id(binding.lease))throw fault('LOCK_BAD_REQUEST');
  return {op,instance:binding.instance,stream:binding.stream,lease:binding.lease};
}
function same(state,binding){return !!state&&!!binding&&state.lease===binding.lease&&state.instance===binding.instance&&state.stream===binding.stream;}
async function request(host,identity,op,binding,signal){
  if(op==='displays'){
    try{return await video.request(host,identity,'displays',null,signal);}catch(error){if(error.code==='BITRATE_INVALID_RESPONSE')throw invalid();throw error;}
  }
  const target=endpoint(host.address,host.port);
  const value=await jsonRequest({...target,port:target.port+2,path:'/v1/session-lock',method:'POST',body:body(op,binding),
    identity,trust:{cert:host.certificate},signal,timeout:5000,limit:4096,acceptStatuses:[200,409,429,503]});
  return state(value);
}
module.exports={state,body,same,request,presented:video.presented};
