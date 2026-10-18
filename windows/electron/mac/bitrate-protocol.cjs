'use strict';
const {jsonRequest,endpoint,fault}=require('./paired-transport.cjs');
const integer=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const guid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
function requireValue(value){if(!value)throw fault('BITRATE_INVALID_RESPONSE');}
function base(value){
  requireValue(object(value)&&value.protocol===1&&typeof value.supported==='boolean'&&Array.isArray(value.streams)&&value.streams.length<=64);
  requireValue(!value.supported||guid(value.instance));
  const ids=new Set();for(const stream of value.streams){requireValue(object(stream)&&integer(stream.id,1)&&!ids.has(stream.id));ids.add(stream.id);}
}
function display(value){
  base(value);
  if(!value.supported)return {supported:false};
  requireValue(integer(value.generation)&&['idle','starting','switching','active'].includes(value.phase));
  if(value.capture!==null&&value.capture!==undefined)requireValue(object(value.capture)&&typeof value.capture.id==='string'&&value.capture.id.length>0&&value.capture.id.length<=256);
  for(const s of value.streams)requireValue(integer(s.generation)&&integer(s.firstFrame,0,0xffffffff)&&integer(s.width,1,65536)&&integer(s.height,1,65536));
  const s=value.streams.length===1?value.streams[0]:null;
  return {supported:true,instance:value.instance,generation:value.generation,phase:value.phase,capture:value.capture?.id||'',
    stream:s?{id:s.id,generation:s.generation,firstFrame:s.firstFrame,width:s.width,height:s.height}:null};
}
function bitrate(value){
  base(value);
  if(!value.supported)return {supported:false,accepted:false};
  requireValue(typeof value.accepted==='boolean');
  for(const s of value.streams){
    requireValue(integer(s.revision,1)&&typeof s.supported==='boolean'&&integer(s.requestId)&&integer(s.appliedFrame,0,0xffffffff)&&
      integer(s.budgetKbps,0,1000000)&&integer(s.videoKbps,1,1000000)&&integer(s.requestedKbps,0,1000000)&&integer(s.targetVideoKbps,0,1000000)&&
      ['','pending','applied','failed'].includes(s.result)&&typeof s.error==='string'&&s.error.length<=64);
    if(s.result==='applied')requireValue(s.appliedFrame>0&&s.requestId>0&&s.budgetKbps===s.requestedKbps&&s.videoKbps===s.targetVideoKbps);
  }
  const s=value.streams.length===1?value.streams[0]:null;
  return {supported:true,instance:value.instance,accepted:value.accepted,stream:s?{
    id:s.id,revision:s.revision,supported:s.supported,budgetKbps:s.budgetKbps,videoKbps:s.videoKbps,requestId:s.requestId,
    requestedKbps:s.requestedKbps,targetVideoKbps:s.targetVideoKbps,appliedFrame:s.appliedFrame,result:s.result}:null};
}
function matching(d,b){return d?.supported&&b?.supported&&d.instance===b.instance&&d.stream&&b.stream&&d.stream.id===b.stream.id;}
function presented(d,progress){return d?.phase==='active'&&!!d.capture&&d.generation>0&&d.stream?.generation===d.generation&&d.stream.firstFrame>0&&
  progress?.rendered>=d.stream.firstFrame&&progress.renderedAgeMs<2000&&progress.receivedAgeMs<2000&&progress.width===d.stream.width&&progress.height===d.stream.height;}
async function request(host,identity,kind,body,signal){
  if(!['displays','bitrate'].includes(kind)||body&&kind!=='bitrate')throw fault('INVALID_STREAM_OPTIONS');
  const target=endpoint(host.address,host.port);
  const result=await jsonRequest({...target,port:target.port+2,path:'/v1/'+kind,method:body?'POST':'GET',body:body||null,
    identity,trust:{cert:host.certificate},signal,timeout:8000,limit:65536,acceptStatuses:body?[200,409]:[200]});
  return kind==='displays'?display(result):bitrate(result);
}
module.exports={integer,display,bitrate,matching,presented,request};
