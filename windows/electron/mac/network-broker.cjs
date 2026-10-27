'use strict';
const https=require('node:https'),crypto=require('node:crypto'),net=require('node:net');
const {fault}=require('./paired-transport.cjs');
const ENDPOINT='https://124-221-36-36.anyip.dev:8443/cliprelay-network';
const id=value=>typeof value==='string' && /^[a-f0-9]{24}$/.test(value);
const name=value=>typeof value==='string' && value.length>0 && Buffer.byteLength(value)<=128 && !/[\r\n\0]/.test(value);
function credentialId(value){
  if(typeof value!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(value))throw fault('INVALID_NETWORK_CREDENTIAL');
  const bytes=Buffer.from(value,'base64url');
  if(bytes.length!==32 || bytes.toString('base64url')!==value)throw fault('INVALID_NETWORK_CREDENTIAL');
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0,24);
}
function overlayIP(value){if(net.isIP(value)!==4)return false;const parts=value.split('.').map(Number);return parts[0]===100 && parts[1]>=64 && parts[1]<=127;}
function addresses(value){
  if(!Array.isArray(value) || value.length>8 || value.some(ip=>typeof ip!=='string' || !net.isIP(ip) || (net.isIP(ip)===4 && !overlayIP(ip))))throw fault('BROKER_BAD_REPLY');
  return [...value];
}
function validate(action,value,deviceId){
  if(!value || typeof value!=='object' || Array.isArray(value))throw fault('BROKER_BAD_REPLY');
  if(action==='directory'){
    if(!Array.isArray(value.devices)||value.devices.length>1000)throw fault('BROKER_BAD_REPLY');
    const seen=new Set();
    return {devices:value.devices.map(peer=>{
      if(!peer||!id(peer.id)||seen.has(peer.id)||!name(peer.name)||typeof peer.deviceId!=='string'||!peer.deviceId||peer.deviceId.length>64||/[\r\n\0]/.test(peer.deviceId)||!['windows','macos'].includes(peer.platform)||typeof peer.connectable!=='boolean')throw fault('BROKER_BAD_REPLY');
      seen.add(peer.id);return {id:peer.id,deviceId:peer.deviceId,name:peer.name,platform:peer.platform,connectable:peer.connectable};
    })};
  }
  if(action==='connect-device'){
    if(value.id!==deviceId||value.state!=='approved'||!id(value.hostId)||!name(value.computer))throw fault('BROKER_BAD_REPLY');
    return {id:value.id,state:value.state,hostId:value.hostId,computer:value.computer};
  }
  if(action==='claim'){
    if(value.id!==deviceId || value.state!=='pending' || !name(value.computer))throw fault('BROKER_BAD_REPLY');
    return {id:value.id,state:value.state,computer:value.computer};
  }
  if(action==='status'){
    if(value.id!==deviceId || !name(value.name) || !['pending','approved'].includes(value.state) || typeof value.reauthorize!=='boolean' || !Array.isArray(value.peers) || value.peers.length>1)throw fault('BROKER_BAD_REPLY');
    const peers=value.peers.map(peer=>{
      if(!peer || !id(peer.id) || peer.id===deviceId || !name(peer.name) || typeof peer.online!=='boolean')throw fault('BROKER_BAD_REPLY');
      return {id:peer.id,name:peer.name,online:peer.online,addresses:addresses(peer.addresses)};
    });
    return {id:deviceId,state:value.state,reauthorize:value.reauthorize,peers};
  }
  let origin;try{origin=new URL(value.controlUrl);}catch{throw fault('BROKER_BAD_REPLY');}
  if(origin.protocol!=='https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname!=='/' ||
      ![origin.origin,origin.origin+'/'].includes(value.controlUrl) || value.controlUrl.length>2048 || value.hostname!=='cr-'+deviceId || typeof value.registered!=='boolean')throw fault('BROKER_BAD_REPLY');
  if(!value.registered && (typeof value.authKey!=='string' || !value.authKey || Buffer.byteLength(value.authKey)>4096))throw fault('BROKER_BAD_REPLY');
  return {controlUrl:value.controlUrl,hostname:value.hostname,authKey:value.registered?'':value.authKey};
}
class BrokerClient{
  constructor(credential,{endpoint=ENDPOINT,ca,timeout=12000}={}){
    this.id=credentialId(credential);this.credential=credential;this.timeout=timeout;this.ca=ca;
    let url;try{url=new URL(endpoint);}catch{throw fault('INVALID_BROKER');}
    if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || !/^(?:\/[a-zA-Z0-9_-]+)*\/?$/.test(url.pathname) || endpoint.length>2048)throw fault('INVALID_BROKER');
    this.endpoint=url.href.replace(/\/$/,'');
  }
  async request(action,data={},signal){
    if(!['claim','status','enroll','directory','connect-device'].includes(action))throw fault('INVALID_BROKER_ACTION');
    if(action==='claim' && (!data || Object.keys(data).length!==2 || !/^[0-9]{8}$/.test(data.code) || !name(data.name)))throw fault('INVALID_PAIRING_CODE');
    if(action==='connect-device'&&(!data||Object.keys(data).length!==2||!id(data.id)||!name(data.name)))throw fault('INVALID_BROKER_ACTION');
    if(!['claim','connect-device'].includes(action) && (!data || typeof data!=='object' || Array.isArray(data) || Object.keys(data).length))throw fault('INVALID_BROKER_ACTION');
    if(signal?.aborted)throw fault('CANCELLED');
    const body=Buffer.from(JSON.stringify(data));if(body.length>4096)throw fault('INVALID_BROKER_ACTION');
    const value=await new Promise((resolve,reject)=>{
      let request,timer,done=false;
      const agent=new https.Agent({keepAlive:false,maxSockets:1,maxCachedSessions:0,proxyEnv:{}});
      const finish=(code,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);request?.destroy();agent.destroy();code?reject(fault(code)):resolve(value);};
      const abort=()=>finish('CANCELLED');
      try{
        const url=new URL(this.endpoint+'/v1/'+({claim:'claims','connect-device':'directory/claim'}[action]||action));
        request=https.request(url,{method:['status','directory'].includes(action)?'GET':'POST',agent,minVersion:'TLSv1.2',ca:this.ca,
          maxHeaderSize:16384,headers:{Authorization:'Bearer '+this.credential,'Content-Type':'application/json','Content-Length':body.length}},response=>{
          if(!(action==='connect-device'?[200,201].includes(response.statusCode):response.statusCode===(action==='claim'?201:200))){
            const status=response.statusCode;
            if(action==='connect-device'&&status===404){finish('DEVICE_NOT_AVAILABLE');return;}
            finish(status>=300 && status<400?'BROKER_REDIRECT':({400:'BROKER_BAD_REQUEST',401:'NETWORK_REVOKED',403:'NETWORK_NOT_APPROVED',404:'PAIRING_CODE_EXPIRED',409:'BROKER_CONFLICT',410:'PAIRING_CODE_EXPIRED',429:'BROKER_RATE_LIMIT'})[status] || 'BROKER_UNAVAILABLE');return;
          }
          const chunks=[];let length=0;
          response.on('error',()=>finish('BROKER_UNAVAILABLE'));
          response.on('data',chunk=>{length+=chunk.length;if(length>(action==='directory'?512:128)*1024){finish('BROKER_BAD_REPLY');return;}chunks.push(chunk);});
          response.on('end',()=>{try{finish(null,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{finish('BROKER_BAD_REPLY');}});
        });
        request.on('error',()=>finish('BROKER_UNAVAILABLE'));
        timer=setTimeout(()=>finish('BROKER_UNAVAILABLE'),this.timeout);signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted){abort();return;}request.end(body);
      }catch{finish('BROKER_UNAVAILABLE');}
    });
    return validate(action,value,this.id);
  }
}
module.exports={BrokerClient,credentialId,overlayIP,ENDPOINT};
