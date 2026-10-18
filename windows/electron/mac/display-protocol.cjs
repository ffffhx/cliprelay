'use strict';
const presentation=require('./bitrate-protocol.cjs');
const {jsonRequest,endpoint,fault}=require('./paired-transport.cjs');
const {integer}=presentation;
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\0\r\n]/.test(value);
function requireValue(value){if(!value)throw fault('DISPLAY_INVALID_RESPONSE');}
function state(value){
  let d;try{d=presentation.display(value);}catch{throw fault('DISPLAY_INVALID_RESPONSE');}
  if(!d.supported)return {supported:false};
  requireValue(integer(value.revision)&&integer(value.requestId)&&typeof value.accepted==='boolean'&&typeof value.shared==='boolean'&&
    Array.isArray(value.displays)&&value.displays.length<=64&&value.displays.every(id)&&new Set(value.displays).size===value.displays.length&&
    ['','pending','applied','failed'].includes(value.result)&&typeof value.error==='string'&&value.error.length<=128&&
    (value.requested===''||id(value.requested)));
  requireValue(value.inputEpochSelection===undefined||typeof value.inputEpochSelection==='boolean');
  const requestStream=value.requestStream??0,inputEpoch=value.inputEpoch??0;
  requireValue(integer(requestStream)&&integer(inputEpoch,0,0xffffffff)&&(requestStream===0)===(inputEpoch===0));
  if(inputEpoch)requireValue(value.inputEpochSelection===true&&Boolean(inputEpoch&1)&&value.requestId>0&&value.result!=='');
  if(value.result!=='')requireValue(value.requestId>0&&id(value.requested));
  return {...d,revision:value.revision,requestId:value.requestId,accepted:value.accepted,shared:value.shared,
    displays:[...value.displays],requested:value.requested,result:value.result,error:value.error,
    inputEpochSelection:value.inputEpochSelection===true,requestStream,inputEpoch};
}
async function request(host,identity,body,signal){
  const target=endpoint(host.address,host.port);
  return state(await jsonRequest({...target,port:target.port+2,path:'/v1/displays',method:body?'POST':'GET',body:body||null,
    identity,trust:{cert:host.certificate},signal,timeout:8000,limit:65536,acceptStatuses:body?[200,409]:[200]}));
}
module.exports={state,request,id};
