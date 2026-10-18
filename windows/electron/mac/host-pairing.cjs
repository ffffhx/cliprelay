'use strict';
const net=require('node:net');
const fault=code=>Object.assign(new Error(code),{code});
const keys=(value,names)=>value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===names.length && names.every(name=>Object.hasOwn(value,name));
const id=value=>typeof value==='string' && /^[a-f0-9]{32}$/.test(value);
const code=value=>typeof value==='string' && /^[A-F0-9]{4}( [A-F0-9]{4}){2}$/.test(value);
function decision(value){
  if(!keys(value,['id','generation','verification']) || !id(value.id) || !id(value.generation) || !code(value.verification))throw fault('HOST_PAIR_INVALID');
  return {id:value.id,generation:value.generation,verification:value.verification};
}
function reply(value,op,now=Date.now()){
  if(!value || value.protocol!==1 || typeof value.ok!=='boolean')throw fault('HOST_PAIR_BAD_REPLY');
  if(!value.ok){
    if(!keys(value,['protocol','ok','code']) || !['HOST_PAIR_INVALID','HOST_PAIR_STALE','HOST_PAIR_CLOSED'].includes(value.code))throw fault('HOST_PAIR_BAD_REPLY');
    throw fault(value.code);
  }
  if(op!=='host-pair-list'){
    if(!keys(value,['protocol','ok']))throw fault('HOST_PAIR_BAD_REPLY');return {ok:true};
  }
  if(!keys(value,['protocol','ok','requests']) || !Array.isArray(value.requests) || value.requests.length>8)throw fault('HOST_PAIR_BAD_REPLY');
  const seen=new Set(),requests=[];
  for(const request of value.requests){
    if(!keys(request,['id','generation','name','verification','expires','state']) || !id(request.id) || !id(request.generation) || !code(request.verification) ||
        typeof request.name!=='string' || Buffer.byteLength(request.name)<1 || Buffer.byteLength(request.name)>128 || /[\r\n\0]/.test(request.name) ||
        !Number.isSafeInteger(request.expires) || request.expires<1 || request.expires>Math.floor(now/1000)+125 ||
        !['waiting','approving'].includes(request.state) || seen.has(request.id))throw fault('HOST_PAIR_BAD_REPLY');
    seen.add(request.id);if(request.expires>Math.floor(now/1000))requests.push({...request});
  }
  return {requests};
}
function hostPairing({companion,op,data,signal,timeout=3000,connect=options=>net.createConnection(options)}){
  let command;
  try{
    if(!['host-pair-list','host-pair-approve','host-pair-reject'].includes(op))throw fault('HOST_PAIR_INVALID');
    if(op==='host-pair-list'){if(data!==undefined && !keys(data,[]))throw fault('HOST_PAIR_INVALID');command={op};}
    else command={op,...decision(data)};
    if(signal?.aborted)throw fault('HOST_PAIR_CANCELLED');
  }catch(error){return Promise.reject(error);}
  return new Promise((resolve,reject)=>{
    let socket,timer,outcome,buffer=Buffer.alloc(0);
    const finish=(error,value)=>{
      if(outcome)return;outcome={error,value};clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(socket)socket.destroy();else error?reject(fault(error)):resolve(value);
    };
    const abort=()=>finish('HOST_PAIR_CANCELLED');
    try{
      socket=connect({path:companion.ipcPath()});
      socket.once('close',()=>{if(!outcome)outcome={error:'HOST_PAIR_UNAVAILABLE'};clearTimeout(timer);signal?.removeEventListener('abort',abort);outcome.error?reject(fault(outcome.error)):resolve(outcome.value);});
      socket.on('error',()=>finish('HOST_PAIR_UNAVAILABLE'));
      socket.once('connect',()=>{if(!outcome)socket.write(JSON.stringify(command)+'\n');});
      socket.on('data',chunk=>{
        if(outcome)return;
        try{
          if(buffer.length+chunk.length>16384)throw fault('HOST_PAIR_BAD_REPLY');buffer=Buffer.concat([buffer,chunk]);
          const newline=buffer.indexOf(10);if(newline<0)return;if(newline!==buffer.length-1)throw fault('HOST_PAIR_BAD_REPLY');
          const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,newline)));
          finish(null,reply(value,op));
        }catch(error){finish(['HOST_PAIR_INVALID','HOST_PAIR_STALE','HOST_PAIR_CLOSED'].includes(error.code)?error.code:'HOST_PAIR_BAD_REPLY');}
      });
      timer=setTimeout(()=>finish('HOST_PAIR_TIMEOUT'),timeout);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    }catch{finish('HOST_PAIR_UNAVAILABLE');}
  });
}
module.exports={hostPairing,decision,reply};
