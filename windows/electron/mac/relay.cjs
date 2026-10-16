'use strict';
const http=require('node:http');
const net=require('node:net');
const {timingSafeEqual,createHash}=require('node:crypto');
const {isLocalAddress,resolveLocal}=require('./legacy.cjs');
const {clipboardAccess,captureSelection}=require('./clipboard-access.cjs');
const MAX_BODY=1024*1024;

// Behavioral contract is init.lua: one peer, Ctrl+Alt+G, restore previous
// plain text, suppress empty/unchanged selections, POST /push and probes.
async function sendSelection({clipboard,copySelection,config,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),post=postText}){
  if(config.legacyEnabled!==true)return false;
  const payload=await captureSelection(clipboardAccess({clipboard}),copySelection,{active:()=>config.legacyEnabled===true,delay});
  if(!payload)return false;
  await post(config,payload.text).catch(()=>{}); // Sender remains silent on failures.
  return true;
}
async function postText(config,text){
  if(config.legacyEnabled!==true)throw new Error('旧版未加密发送尚未开启');
  const body=Buffer.from(JSON.stringify({text}));
  if(body.length>MAX_BODY)throw new Error('文本超过 1 MiB');
  const destination={peer:config.peer,port:config.peerPort,token:config.peerToken};
  const address=await resolveLocal(destination.peer);
  if(config.legacyEnabled!==true)throw new Error('旧版未加密发送已关闭');
  if(config.peer!==destination.peer || config.peerPort!==destination.port || config.peerToken!==destination.token)throw new Error('目标设备已改变，请重新发送');
  return new Promise((resolve,reject)=>{
    const host=net.isIP(destination.peer)===6?'['+destination.peer+']':destination.peer;
    const headers={'Content-Type':'application/json','Content-Length':body.length,Host:host+':'+destination.port};
    if(destination.token)headers['X-ClipRelay-Token']=destination.token;
    // node:http makes a direct LAN connection, ignoring system proxy settings.
    const request=http.request({hostname:address,port:destination.port,path:'/push',method:'POST',headers,agent:false},response=>{
      response.on('error',reject);
      response.resume();if(response.statusCode===200)resolve();else reject(new Error('Peer returned HTTP '+response.statusCode));
    });
    const deadline=setTimeout(()=>request.destroy(new Error('timeout')),5000);
    request.on('error',reject);request.on('close',()=>clearTimeout(deadline));request.end(body);
  });
}
function authorize(config,remoteAddress,headers={}){
  if(config?.legacyEnabled!==true || !isLocalAddress(remoteAddress))return {status:403,body:'legacy compatibility disabled or non-local peer'};
  const expected=config.accessToken || '';
  const supplied=headers['x-cliprelay-token'] || (typeof headers.authorization==='string' && headers.authorization.startsWith('Bearer ')?headers.authorization.slice(7):'');
  const hash=value=>createHash('sha256').update(value).digest();
  if(expected && (typeof supplied!=='string' || !timingSafeEqual(hash(expected),hash(supplied))))return {status:401,body:'unauthorized'};
  return null;
}
async function receive(method,path,body,{clipboard,notify,getConfig=()=>({}),withClipboard=operation=>operation()},context={}){
  const denied=authorize(getConfig(),context.remoteAddress,context.headers);if(denied)return denied;
  if(Buffer.byteLength(body,'utf8')>MAX_BODY)return {status:413,body:'too large'};
  if(method==='POST' && path==='/push'){
    let data;try{data=JSON.parse(body);}catch{return {status:400,body:'bad request'};}
    try{
      if(data && typeof data.text==='string' && data.text!==''){
        if(data.probe!==true){
          const result=await withClipboard(async()=>{
            const denied=authorize(getConfig(),context.remoteAddress,context.headers);if(denied)return denied;
            await clipboard.writeText(data.text);
            try{notify('ClipRelay 收到文本',Buffer.from(data.text,'utf8').subarray(0,80).toString('utf8'));}catch{}
            return {status:200,body:'ok'};
          });
          return result;
        }
        return {status:200,body:'ok'};
      }
    }catch{return {status:503,body:'clipboard unavailable'};}
  }
  return {status:400,body:'bad request'};
}
function createReceiver(adapters){
  const server=http.createServer({maxHeaderSize:16384,requestTimeout:5000,headersTimeout:5000,connectionsCheckingInterval:1000},(request,response)=>{
    let finished=false;
    const deadline=setTimeout(()=>request.destroy(),5000);
    const finish=result=>{if(finished)return;finished=true;clearTimeout(deadline);response.writeHead(result.status,{'Connection':'close','Cache-Control':'no-store'});response.end(result.body);};
    response.on('close',()=>{clearTimeout(deadline);request.destroy();});
    request.on('error',()=>{clearTimeout(deadline);response.destroy();});
    const context={remoteAddress:request.socket.remoteAddress,headers:request.headers};
    const denied=authorize(adapters.getConfig?.(),context.remoteAddress,context.headers);
    if(denied){finish(denied);return;}
    if(request.method!=='POST' || request.url!=='/push'){finish({status:400,body:'bad request'});return;}
    if(Number(request.headers['content-length'])>MAX_BODY){finish({status:413,body:'too large'});return;}
    let size=0;const chunks=[];
    request.on('data',chunk=>{if(finished)return;size+=chunk.length;if(size>MAX_BODY){chunks.length=0;finish({status:413,body:'too large'});}else chunks.push(chunk);});
    request.on('end',async()=>{
      if(finished)return;
      try{finish(await receive(request.method,request.url,new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),adapters,context));}
      catch{finish({status:400,body:'bad request'});}
    });
  });
  server.maxConnections=16;
  return server;
}
function preferredIPv4(addresses){
  const ipv4=(addresses || []).filter(address=>net.isIP(address)===4);
  return ipv4.find(address=>/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(address)) || ipv4[0];
}
function discoveredPeer(service,deviceId){
  const txt=service.txt || {};const id=txt.id || `${service.name}:${service.port}`;const address=preferredIPv4(service.addresses);
  if(id===deviceId || !address || !Number.isInteger(service.port) || service.port<1)return null;
  return {id,text:service.name,address,port:service.port,requiresAuth:txt.auth==='required',subText:`${address}:${service.port}${txt.auth==='required'?' · 需要访问密钥':''}`};
}
module.exports={sendSelection,postText,receive,createReceiver,preferredIPv4,discoveredPeer};
