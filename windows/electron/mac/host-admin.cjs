'use strict';
const https=require('node:https'),tls=require('node:tls'),crypto=require('node:crypto');
const fault=code=>Object.assign(new Error(code),{code});
// Only the application's main process receives the private state object. Keep
// the destination and read-only endpoint fixed; there is no renderer HTTP proxy.
function hostStatus({state,signal,timeout=3000,port=48790}){
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
      request=https.request({host:'127.0.0.1',port,path:'/api/cliprelay/host',method:'GET',agent,maxHeaderSize:16384,
        headers:{Connection:'close',Authorization:authorization}},response=>{
        if(response.statusCode!==200){response.resume();finish(fault(response.statusCode===401?'HOST_ADMIN_UNAUTHORIZED':'HOST_ADMIN_BAD_REPLY'));return;}
        let length=0;const chunks=[];
        response.on('error',()=>finish(fault('HOST_ADMIN_UNAVAILABLE')));
        response.on('data',chunk=>{length+=chunk.length;if(length>16384)finish(fault('HOST_ADMIN_BAD_REPLY'));else chunks.push(chunk);});
        response.on('end',()=>{
          try{
            const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
            if(!value || Object.keys(value).sort().join(',')!=='inputControl,owned,ownerPid,pid,protocol,screenRecording' || value.protocol!==1 ||
                !Number.isSafeInteger(value.pid) || value.pid<=1 || !Number.isSafeInteger(value.ownerPid) || value.ownerPid<=1 ||
                ['owned','screenRecording','inputControl'].some(name=>typeof value[name]!=='boolean'))throw fault('HOST_ADMIN_BAD_REPLY');
            finish(null,value);
          }catch{finish(fault('HOST_ADMIN_BAD_REPLY'));}
        });
      });
      request.on('error',error=>finish(fault(['HOST_CERT_CHANGED','HOST_ADMIN_CANCELLED'].includes(error.code)?error.code:'HOST_ADMIN_UNAVAILABLE')));
      timer=setTimeout(()=>finish(fault('HOST_ADMIN_TIMEOUT')),timeout);
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted){abort();return;}
      request.end();
    }catch{finish(fault('HOST_ADMIN_UNAVAILABLE'));}
  });
}
module.exports={hostStatus};
