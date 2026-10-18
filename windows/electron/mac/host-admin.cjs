'use strict';
const https=require('node:https'),tls=require('node:tls'),crypto=require('node:crypto');
const fault=code=>Object.assign(new Error(code),{code});
const validClientId=value=>typeof value==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
function statusReply(value){
  if(!value || Object.keys(value).sort().join(',')!=='inputControl,owned,ownerPid,pid,protocol,screenRecording' || value.protocol!==1 ||
      !Number.isSafeInteger(value.pid) || value.pid<=1 || !Number.isSafeInteger(value.ownerPid) || value.ownerPid<=1 ||
      ['owned','screenRecording','inputControl'].some(name=>typeof value[name]!=='boolean'))throw fault('HOST_ADMIN_BAD_REPLY');
  return value;
}
function clientReply(value,list){
  if(!value || Array.isArray(value) || Object.keys(value).sort().join(',')!==(list?'named_certs,status':'status') ||
      typeof value.status!=='boolean')throw fault('HOST_ADMIN_BAD_REPLY');
  if(!list)return value;
  if(value.status!==true || !Array.isArray(value.named_certs) || value.named_certs.length>128)throw fault('HOST_ADMIN_BAD_REPLY');
  const ids=new Set();
  return value.named_certs.map(client=>{
    if(!client || Object.keys(client).sort().join(',')!=='enabled,name,uuid' || !validClientId(client.uuid) ||
        ids.has(client.uuid.toLowerCase()) || typeof client.enabled!=='boolean' || typeof client.name!=='string' ||
        Buffer.byteLength(client.name)>128 || /[\r\n\0]/.test(client.name))throw fault('HOST_ADMIN_BAD_REPLY');
    ids.add(client.uuid.toLowerCase());return {uuid:client.uuid,name:client.name,enabled:client.enabled};
  });
}
// Only fixed main-process operations can use this pinned loopback transport.
// A renderer cannot supply a URL, HTTP method, payload or authorization header.
function hostStatus(options){return request(options,{path:'/api/cliprelay/host',method:'GET',limit:16384,parse:statusReply});}
function hostClientRequest({operation,uuid,...options}){
  if(!['list','disable','unpair'].includes(operation) || (operation==='list'?uuid!==undefined:!validClientId(uuid)))return Promise.reject(fault('HOST_ADMIN_INVALID'));
  const list=operation==='list',body=list?undefined:JSON.stringify(operation==='disable'?{uuid,enabled:false}:{uuid});
  return request(options,{path:'/api/clients/'+({list:'list',disable:'update',unpair:'unpair'})[operation],method:list?'GET':'POST',body,limit:65536,parse:value=>clientReply(value,list)});
}
function request({state,signal,timeout=3000,port=48790},{path,method,body,limit,parse}){
  if(signal?.aborted)return Promise.reject(fault('HOST_ADMIN_CANCELLED'));
  let expected,authorization,certificate;
  try{
    if(!Number.isInteger(port) || port<1 || port>65535)throw fault('HOST_ADMIN_INVALID');
    certificate=state.read('cacert.pem',16384);
    authorization=state.authorization();
    if(typeof authorization!=='string' || !/^Basic [A-Za-z0-9+/=]{1,512}$/.test(authorization))throw fault('HOST_ADMIN_INVALID');
  }catch(error){return Promise.reject(fault(error.code==='ENOENT'?'HOST_CERT_UNAVAILABLE':'HOST_ADMIN_INVALID'));}
  // On first launch the engine can be partway through creating its PEM file.
  // Startup may retry this without sending credentials to any socket.
  try{expected=new crypto.X509Certificate(certificate).raw;}
  catch{return Promise.reject(fault('HOST_CERT_UNAVAILABLE'));}
  return new Promise((resolve,reject)=>{
    let request,socket,agent,timer,done=false;
    const finish=(error,value)=>{
      if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      request?.destroy();socket?.destroy();agent?.destroy();error?reject(error):resolve(value);
    };
    const abort=()=>finish(fault('HOST_ADMIN_CANCELLED'));
    try{
      agent=new https.Agent({keepAlive:false,maxSockets:1,maxCachedSessions:0,proxyEnv:{}});
      // Withhold the TLS socket from HTTP until the exact private certificate
      // matches. No Authorization header reaches a different local listener.
      agent.createConnection=(_options,callback)=>{
        let returned=false;
        const connected=error=>{if(returned)return;returned=true;error?callback(error):callback(null,socket);};
        socket=tls.connect({host:'127.0.0.1',port,servername:'',minVersion:'TLSv1.2',ALPNProtocols:['http/1.1'],rejectUnauthorized:false},()=>{
          if(done || signal?.aborted){connected(fault('HOST_ADMIN_CANCELLED'));socket.destroy();return;}
          const actual=socket.getPeerCertificate().raw;
          if(!actual || actual.length!==expected.length || !crypto.timingSafeEqual(actual,expected)){
            connected(fault('HOST_CERT_CHANGED'));socket.destroy();return;
          }
          connected();
        });
        socket.once('error',()=>connected(fault('HOST_ADMIN_UNAVAILABLE')));
      };
      request=https.request({host:'127.0.0.1',port,path,method,agent,maxHeaderSize:16384,
        headers:{Connection:'close',Authorization:authorization,...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{})}},response=>{
        if(response.statusCode!==200){response.resume();finish(fault(response.statusCode===401?'HOST_ADMIN_UNAUTHORIZED':'HOST_ADMIN_BAD_REPLY'));return;}
        let length=0;const chunks=[];
        response.on('error',()=>finish(fault('HOST_ADMIN_UNAVAILABLE')));
        response.on('data',chunk=>{length+=chunk.length;if(length>limit)finish(fault('HOST_ADMIN_BAD_REPLY'));else chunks.push(chunk);});
        response.on('end',()=>{
          try{
            const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
            finish(null,parse(value));
          }catch{finish(fault('HOST_ADMIN_BAD_REPLY'));}
        });
      });
      request.on('error',error=>finish(fault(['HOST_CERT_CHANGED','HOST_ADMIN_CANCELLED'].includes(error.code)?error.code:'HOST_ADMIN_UNAVAILABLE')));
      timer=setTimeout(()=>finish(fault('HOST_ADMIN_TIMEOUT')),timeout);
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted){abort();return;}
      request.end(body);
    }catch{finish(fault('HOST_ADMIN_UNAVAILABLE'));}
  });
}
module.exports={hostStatus,hostClientRequest,validClientId};
