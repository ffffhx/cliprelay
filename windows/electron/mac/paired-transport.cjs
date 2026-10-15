'use strict';
const http=require('node:http'),https=require('node:https'),tls=require('node:tls'),net=require('node:net');
const {X509Certificate,timingSafeEqual}=require('node:crypto');
const fault=code=>Object.assign(new Error(code),{code});
function endpoint(address,port=48789){
  if(typeof address!=='string' || address.length>253)throw fault('INVALID_ADDRESS');
  const host=address.trim().replace(/^\[([^\]]+)\]$/,'$1');
  if(!host || (!net.isIP(host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)))throw fault('INVALID_ADDRESS');
  if(!Number.isInteger(port) || port<6 || port>65532)throw fault('INVALID_PORT');
  return {address:host,port};
}
// An asynchronous Agent callback withholds the socket from HTTP until its pin
// is checked. checkServerIdentity alone is NOT called with rejectUnauthorized:false.
// https://nodejs.org/api/http.html#agentcreateconnectionoptions-callback
function exchange({address,port,path,method='POST',body=null,identity,trust,signal,timeout=20000,limit=400*1024,plain=false,acceptStatuses=[200]}){
  if(signal?.aborted)return Promise.reject(fault('CANCELLED'));
  return new Promise((resolve,reject)=>{
    let socket,request,timer,done=false,agent;
    const finish=(error,value)=>{
      if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(error)request?.destroy();socket?.destroy();agent?.destroy();error?reject(error):resolve(value);
    };
    const abort=()=>finish(fault('CANCELLED'));
    try{
      const bytes=body===null?null:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
      if(bytes?.length>12*1024*1024)throw fault('REQUEST_TOO_LARGE');
      if(!plain){
        if(!identity?.key || !identity?.cert || (!trust?.cert && trust?.bootstrap!==true))throw fault('PAIRING_REQUIRED');
        agent=new https.Agent({keepAlive:false,maxSockets:1,maxCachedSessions:0,proxyEnv:{}});
        agent.createConnection=(_options,callback)=>{
          let returned=false;
          const connected=(error)=>{if(returned)return;returned=true;error?callback(error):callback(null,socket);};
          socket=tls.connect({host:address,port,servername:net.isIP(address)?'':address,key:identity.key,cert:identity.cert,minVersion:'TLSv1.2',ALPNProtocols:['http/1.1'],rejectUnauthorized:false},()=>{
            try{
              if(done || signal?.aborted)throw fault('CANCELLED');
              const raw=socket.getPeerCertificate().raw;
              if(!raw || raw.length>16384)throw fault('HOST_CERT_CHANGED');
              if(trust.cert){const expected=new X509Certificate(trust.cert).raw;if(raw.length!==expected.length || !timingSafeEqual(raw,expected))throw fault('HOST_CERT_CHANGED');}
              else if(trust.bootstrap===true)trust.cert=new X509Certificate(raw).toString();
              else throw fault('PAIRING_REQUIRED');
              connected();
            }catch(error){connected(error);socket.destroy();}
          });
          socket.once('error',connected);
          // No socket return: HTTP receives it only via connected() after pinning.
        };
      }else{
        // Only the certificate challenge protocol may use HTTP, never clipboard data.
        if(method!=='GET' || !/^\/pair\?/.test(path) || bytes)throw fault('INVALID_PAIRING_REQUEST');
        agent=new http.Agent({keepAlive:false,maxSockets:1,proxyEnv:{}});
      }
      request=(plain?http:https).request({host:address,port,path,method,agent,maxHeaderSize:16384,headers:{Connection:'close',...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{})}},response=>{
        if(!acceptStatuses.includes(response.statusCode)){response.resume();finish(fault(response.statusCode===403?'UNPAIRED':response.statusCode===404?'UPDATE_HOST':'HTTP_'+response.statusCode));return;}
        let size=0;const chunks=[];
        response.on('error',error=>finish(error));
        response.on('data',chunk=>{size+=chunk.length;if(size>limit){finish(fault('REPLY_TOO_LARGE'));return;}chunks.push(chunk);});
        response.on('end',()=>{try{finish(null,new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{finish(fault('BAD_REPLY'));}});
      });
      request.on('error',error=>finish(error));
      timer=setTimeout(()=>finish(fault('TIMEOUT')),timeout);
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted){abort();return;}
      request.end(bytes);
    }catch(error){finish(error);}
  });
}
async function jsonRequest(options){
  const raw=await exchange(options);let result;
  try{result=JSON.parse(raw);}catch{throw fault('BAD_REPLY');}
  if(!result || typeof result!=='object' || Array.isArray(result))throw fault('BAD_REPLY');
  return result;
}
module.exports={exchange,jsonRequest,endpoint,fault};
