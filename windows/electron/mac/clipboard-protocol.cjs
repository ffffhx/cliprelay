'use strict';
const {jsonRequest,fault}=require('./paired-transport.cjs');
const {validateText}=require('./paired-relay.cjs');
const {pngSize}=require('./clipboard-access.cjs');
const revision=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const errors=new Set(['CLIPBOARD_EMPTY','CLIPBOARD_LOCKED','CLIPBOARD_TOO_LARGE','CLIPBOARD_ID_CONFLICT','CLIPBOARD_PERMISSION_REQUIRED','CLIPBOARD_CHANGED','CLIPBOARD_SYNC_UNSUPPORTED','CLIPBOARD_BUSY','CLIPBOARD_UNAVAILABLE']);
function payload(value){
  if(value.kind==='text'){if(value.data!==undefined)throw fault('BAD_REPLY');return {kind:'text',text:validateText(value.text)};}
  if(value.kind==='png'){
    if(value.text!==undefined || typeof value.data!=='string' || value.data.length>11184812)throw fault('BAD_REPLY');
    const bytes=Buffer.from(value.data,'base64');if(bytes.toString('base64')!==value.data)throw fault('BAD_REPLY');pngSize(bytes);return {kind:'png',bytes};
  }
  if(value.kind==='empty' && value.text===undefined && value.data===undefined)return {kind:'empty'};
  throw fault('BAD_REPLY');
}
async function request(host,identity,body,signal,transport=jsonRequest){
  if(!body || !['read','observe','write'].includes(body.op))throw fault('INVALID_CLIPBOARD');
  const allowed=body.op==='read'?['op']:body.op==='observe'?['op','revision']:['op','id','kind','text','data','expect'];
  if(Object.keys(body).some(key=>!allowed.includes(key)))throw fault('INVALID_CLIPBOARD');
  if(body.op==='observe' && body.revision!==undefined && !revision(body.revision))throw fault('INVALID_CLIPBOARD');
  if(body.op==='write' && (!/^[a-f0-9]{32}$/.test(body.id) || !revision(body.expect)))throw fault('INVALID_CLIPBOARD');
  if(body.op==='write' && payload(body).kind==='empty')throw fault('INVALID_CLIPBOARD');
  let result;
  try{result=await transport({address:host.address,port:host.port+2,path:'/v1/clipboard',body,identity,trust:{cert:host.certificate},signal,timeout:15000,limit:12*1024*1024,acceptStatuses:[200,400,409,429,503]});}
  catch(error){if(error.code==='UPDATE_HOST' && body.op!=='read')throw fault('CLIPBOARD_SYNC_UNSUPPORTED');throw error;}
  if(result?.ok!==true){
    const code=result?.code;
    if(body.op==='observe' && code==='CLIPBOARD_BAD_REQUEST')throw fault('CLIPBOARD_SYNC_UNSUPPORTED');
    throw fault(errors.has(code)?code:'CLIPBOARD_UNAVAILABLE');
  }
  if(body.op==='write'){
    if(Object.keys(result).some(key=>key!=='ok'))throw fault('BAD_REPLY');return {ok:true};
  }
  const keys=body.op==='read'?['ok','kind','text','data']:['ok','revision','changed','kind','text','data'];
  if(Object.keys(result).some(key=>!keys.includes(key)))throw fault('BAD_REPLY');
  if(body.op==='read')return payload(result);
  if(!revision(result.revision) || typeof result.changed!=='boolean')throw fault('BAD_REPLY');
  if(!result.changed){
    if(result.revision!==body.revision || result.kind!==undefined || result.text!==undefined || result.data!==undefined)throw fault('BAD_REPLY');
    return {revision:result.revision,changed:false};
  }
  if(result.revision===body.revision)throw fault('BAD_REPLY');
  return {revision:result.revision,changed:true,payload:payload(result)};
}
module.exports={request,revision,payload};
