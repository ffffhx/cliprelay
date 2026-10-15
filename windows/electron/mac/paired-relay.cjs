'use strict';
const crypto=require('node:crypto');
const {jsonRequest,fault}=require('./paired-transport.cjs');
const {hash}=require('./paired-crypto.cjs');
function validateText(text){
  if(typeof text!=='string' || !text || text.includes('\0') || Buffer.byteLength(text)>1024*1024)throw fault('INVALID_TEXT');
  for(const char of text){const code=char.codePointAt(0);if(code>=0xd800 && code<=0xdfff)throw fault('INVALID_TEXT');}
  return text;
}
function jpegSize(bytes){
  if(bytes.length<4 || bytes[0]!==255 || bytes[1]!==216)throw fault('INVALID_IMAGE');
  let offset=2,size;
  while(offset<bytes.length){
    if(bytes[offset++]!==255)throw fault('INVALID_IMAGE');while(bytes[offset]===255)offset++;
    const marker=bytes[offset++];if(marker===0xda){if(!size)throw fault('INVALID_IMAGE');return size;}
    if(marker===0xd9 || marker===0 || marker===0xd8 || (marker>=0xd0 && marker<=0xd7))throw fault('INVALID_IMAGE');
    if(offset+2>bytes.length)throw fault('INVALID_IMAGE');const length=bytes.readUInt16BE(offset);
    if(length<2 || offset+length>bytes.length)throw fault('INVALID_IMAGE');
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
      if(size || length<8)throw fault('INVALID_IMAGE');size={width:bytes.readUInt16BE(offset+5),height:bytes.readUInt16BE(offset+3)};
      if(!size.width || !size.height || size.width>32768 || size.height>32768 || size.width*size.height>24000000)throw fault('IMAGE_TOO_LARGE');
    }
    offset+=length;
  }
  throw fault('INVALID_IMAGE');
}
async function receiveDelivery(meta,{request,receipts,apply,active}){
  const check=()=>{if(!active())throw fault('CANCELLED');};
  if(meta?.ok!==true)throw fault('BAD_REPLY');if(meta.state==='idle')return;
  const {id,sha256:digest,kind,size}=meta;
  if(meta.state!=='queued' || !/^[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{64}$/.test(digest) || !['json','jpeg'].includes(kind) || !Number.isInteger(size) || size<1 || size>(kind==='json'?1024*1024:25*1024*1024))throw fault('BAD_REPLY');
  const reject=async()=>{if(active())await request({op:'reject',id}).catch(()=>{});};
  const ack=async()=>{check();const result=await request({op:'ack',id,sha256:digest});if(result?.ok!==true || result.id!==id || result.state!=='delivered')throw fault('BAD_REPLY');};
  check();let previous;
  try{previous=receipts.state(id,digest);}catch(error){await reject();throw error;}
  if(previous==='applied'){await ack();return;}if(previous){await reject();return;}
  const body=Buffer.alloc(size);
  try{
    for(let offset=0;offset<size;){
      check();const chunk=await request({op:'read',id,offset});
      if(chunk?.ok!==true || chunk.id!==id || (chunk.offset ?? 0)!==offset || typeof chunk.data!=='string' || chunk.data.length>349528)throw fault('BAD_REPLY');
      const bytes=Buffer.from(chunk.data,'base64');
      if(bytes.toString('base64')!==chunk.data || !bytes.length || bytes.length>256*1024 || bytes.length>size-offset)throw fault('BAD_REPLY');
      bytes.copy(body,offset);offset+=bytes.length;
    }
    if(hash(body).toString('hex')!==digest)throw fault('RELAY_HASH_MISMATCH');
    let text,probe=false;
    if(kind==='json'){
      const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));
      if(!value || Array.isArray(value) || Object.keys(value).some(key=>!['text','probe'].includes(key)) || (value.probe!==undefined && typeof value.probe!=='boolean'))throw fault('INVALID_TEXT');
      text=validateText(value.text);probe=value.probe===true;
    }else jpegSize(body);
    check();
    if(!probe){receipts.save(id,digest,'pending');check();await apply({kind,body,text});check();receipts.save(id,digest,'applied');}
  }catch(error){await reject();throw error;}
  await ack();
}
function makeRequest(host,identity,signal,path='/v1/relay',timeout=20000){
  return async body=>{
    const result=await jsonRequest({address:host.address,port:host.port+2,path,body,identity,trust:{cert:host.certificate},signal,timeout,limit:path==='/v1/relay'?400*1024:12*1024*1024});
    if(result.ok!==true)throw fault(typeof result.code==='string' && /^[A-Z_]{1,48}$/.test(result.code)?result.code:'BAD_REPLY');return result;
  };
}
async function sendClipboard(host,identity,payload,signal){
  if(payload.kind==='text')validateText(payload.text);
  else if(payload.kind==='png'){
    if(!Buffer.isBuffer(payload.bytes) || payload.bytes.length>8*1024*1024 || payload.bytes.length<33 || !payload.bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || payload.bytes.toString('ascii',12,16)!=='IHDR')throw fault('INVALID_IMAGE');
    const width=payload.bytes.readUInt32BE(16),height=payload.bytes.readUInt32BE(20);if(!width || !height || width>4096 || height>4096 || width*height>6000000)throw fault('IMAGE_TOO_LARGE');
  }else throw fault('INVALID_CLIPBOARD');
  const request=makeRequest(host,identity,signal,'/v1/clipboard',45000);
  await request({op:'write',id:crypto.randomBytes(16).toString('hex'),kind:payload.kind,...(payload.kind==='text'?{text:payload.text}:{data:payload.bytes.toString('base64')})});
}
function wait(ms,signal){return new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});}
class PairedReceiver{
  constructor({store,apply,onStatus=()=>{}}){this.store=store;this.apply=apply;this.onStatus=onStatus;}
  refresh(){
    this.close();const host=this.store.selected();if(!host?.enabled){this.onStatus('paused');return;}
    const controller=new AbortController();this.controller=controller;
    const active=()=>!controller.signal.aborted && this.store.selected()?.id===host.id && this.store.selected()?.enabled===true;
    this.task=(async()=>{
      let backoff=1000,connected=false;
      while(active()){
        try{
          const identity=await this.store.identity();if(!active())break;
          const request=makeRequest(host,identity,controller.signal);
          if(!connected)this.onStatus('connecting');const meta=await request({op:'poll'});if(!active())break;
          connected=true;this.onStatus('connected');
          await receiveDelivery(meta,{request,receipts:this.store.receipts(host.id),active,apply:async value=>{if(!active())throw fault('CANCELLED');await this.apply(value,active);}});
          backoff=1000;
        }catch(error){
          connected=false;
          if(!active())break;
          if(['HOST_CERT_CHANGED','UNPAIRED','RELAY_UNPAIRED','KEYCHAIN_UNAVAILABLE'].includes(error.code)){this.onStatus(error.code);break;}
          this.onStatus('offline');await wait(backoff,controller.signal);backoff=Math.min(60000,backoff*2);
        }
      }
    })();
    this.task.catch(()=>{if(active())this.onStatus('offline');});
  }
  close(){this.controller?.abort();this.controller=null;}
}
module.exports={validateText,jpegSize,receiveDelivery,sendClipboard,PairedReceiver,makeRequest};
