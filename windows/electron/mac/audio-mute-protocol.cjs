'use strict';
const {jsonRequest,endpoint,fault}=require('./paired-transport.cjs');
const privacy=require('./privacy-protocol.cjs');
const video=require('./bitrate-protocol.cjs');
const errors=new Set(['AUDIO_BUSY','AUDIO_EXPIRED','AUDIO_UNSUPPORTED','AUDIO_UNAVAILABLE','AUDIO_RECOVERY_PENDING','AUDIO_NO_SAFE_STREAM']);
function invalid(){return fault('AUDIO_INVALID_RESPONSE');}
function state(value){
  if(value?.ok===false&&errors.has(value.code))throw fault(value.code);
  let result;try{result=privacy.state(value);}catch{throw invalid();}
  if(typeof value.recovering!=='boolean'||!video.integer(value.outputs,0,32)||
    (value.recovering&&(result.active||result.supported))||(result.supported&&value.outputs===0))throw invalid();
  return {...result,recovering:value.recovering,outputs:value.outputs};
}
function display(value){
  let result;try{result=video.display(value);}catch{throw invalid();}
  if(!result.supported)return result;
  const streams=value.streams.map(stream=>{
    const audio=stream.audio;
    if(audio===undefined)return null;
    if(!audio||typeof audio!=='object'||Array.isArray(audio)||!['','endpoint','process'].includes(audio.capture)||
      typeof audio.ready!=='boolean'||!video.integer(audio.generation)||
      (audio.capture===''&&(audio.generation!==0||audio.ready))||(audio.capture!==''&&audio.generation===0)||
      (audio.capture==='endpoint'&&audio.ready))throw invalid();
    return {capture:audio.capture,generation:audio.generation,ready:audio.ready};
  });
  if(result.stream)result.stream.audio=streams[0];
  return result;
}
function safeAudio(d){const audio=d?.stream?.audio;return audio?.capture==='process'&&audio.ready&&audio.generation>0;}
function body(op,binding){
  try{
    const result=privacy.body(op,binding);
    if(op==='status')return result;
    if(!video.integer(binding.audioGeneration,1))throw invalid();
    return {...result,audioGeneration:binding.audioGeneration};
  }catch{throw fault('AUDIO_BAD_REQUEST');}
}
async function request(host,identity,kind,binding,signal){
  const target=endpoint(host.address,host.port),reading=kind==='displays';
  const result=await jsonRequest({...target,port:target.port+2,path:reading?'/v1/displays':'/v1/audio-mute',method:reading?'GET':'POST',
    body:reading?null:body(kind,binding),identity,trust:{cert:host.certificate},signal,timeout:4000,limit:reading?65536:4096,acceptStatuses:reading?[200]:[200,409,503]});
  return reading?display(result):state(result);
}
module.exports={state,display,body,request,safeAudio,presented:video.presented};
