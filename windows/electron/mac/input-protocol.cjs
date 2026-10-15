'use strict';
const {jsonRequest,endpoint,fault}=require('./paired-transport.cjs');
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const guid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
function requireValue(value){if(!value)throw fault('INPUT_INVALID_RESPONSE');}

function state(value){
  requireValue(object(value)&&value.protocol===1&&typeof value.supported==='boolean'&&Array.isArray(value.streams)&&value.streams.length<=64);
  if(!value.supported){requireValue(value.streams.length===0);return {supported:false,streams:[]};}
  requireValue(guid(value.instance));
  const ids=new Set(),streams=[];
  for(const stream of value.streams){
    requireValue(object(stream)&&integer(stream.id,1,Number.MAX_SAFE_INTEGER)&&!ids.has(stream.id)&&
      integer(stream.epoch,0,0xffffffff)&&integer(stream.acknowledged,0,0xffffffff));
    ids.add(stream.id);
    for(const key of ['enabled','paused','pending','closed','failed','exclusive'])requireValue(typeof stream[key]==='boolean');
    // The service filters other certificate owners. A single returned stream
    // can therefore still be non-exclusive; never infer exclusivity from count.
    requireValue(!stream.exclusive||value.streams.length===1);
    const {epoch,acknowledged,enabled,paused,pending,closed,failed,exclusive}=stream;
    if(!enabled)requireValue(epoch===0&&acknowledged===0&&!paused&&!pending&&!failed);
    else{
      requireValue(epoch>0&&acknowledged<=epoch&&paused===Boolean(epoch&1)&&!(pending&&(closed||failed)));
      if(pending||failed)requireValue(acknowledged===epoch-1);
      else if(!closed)requireValue(acknowledged===epoch);
    }
    streams.push({id:stream.id,epoch,acknowledged,enabled,paused,pending,closed,failed,exclusive});
  }
  return {supported:true,instance:value.instance,streams};
}

function acknowledged(value,instance,id,epoch){
  if(!value?.supported||value.instance!==instance||value.streams.length!==1)return false;
  const stream=value.streams[0];
  return stream.id===id&&stream.enabled&&stream.exclusive&&!stream.pending&&!stream.closed&&!stream.failed&&
    stream.epoch===epoch&&stream.acknowledged===epoch&&stream.paused===Boolean(epoch&1);
}

function command(epoch,operation){
  const op={pause:1,resume:2,acknowledge:3}[operation];
  if(!integer(epoch,1,0xffffffff)||!Number.isInteger(op)||(op===1&&!(epoch&1))||(op===2&&(epoch&1)))throw fault('INPUT_INVALID_COMMAND');
  const frame=Buffer.alloc(16);frame.write('CRIC');frame[4]=1;frame[5]=op;frame.writeUInt32BE(epoch,8);return frame;
}

function event(value){
  requireValue(object(value)&&Object.keys(value).sort().join(',')==='epoch,event,stage,version'&&value.version===1&&
    value.event==='input'&&integer(value.epoch,1,0xffffffff)&&['submitted','acknowledged'].includes(value.stage));
  return {epoch:value.epoch,stage:value.stage};
}

async function request(host,identity,signal){
  const target=endpoint(host.address,host.port);
  return state(await jsonRequest({...target,port:target.port+2,path:'/v1/input-state',method:'GET',
    identity,trust:{cert:host.certificate},signal,timeout:8000,limit:65536,acceptStatuses:[200]}));
}
module.exports={state,acknowledged,command,event,request};
