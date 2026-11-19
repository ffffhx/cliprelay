'use strict';
const fs=require('node:fs');
const net=require('node:net');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const methods=new Set(['status','quit','restart']);
function dataDirectory(){return process.env.CLIPRELAY_LIFECYCLE_DIRECTORY || (process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'ClipRelay'):path.join(os.homedir(),'Library/Application Support/ClipRelay'));}
function sameToken(first,second){
  if(typeof first!=='string')return false;
  const a=Buffer.from(first),b=Buffer.from(second);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}
async function serve({directory=dataDirectory(),status,request}){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const identity=crypto.randomBytes(16).toString('hex');
  const endpoint=process.platform==='win32'?`\\\\.\\pipe\\cliprelay-app-${identity}`:path.join(os.tmpdir(),`cliprelay-app-${identity}.sock`);
  const token=crypto.randomBytes(32).toString('hex');
  const sockets=new Set();
  let pending=false;
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    socket.setTimeout(5000,()=>socket.destroy());socket.setEncoding('utf8');
    let buffer='',handled=false;
    socket.on('data',chunk=>{
      if(handled)return;buffer+=chunk;
      if(Buffer.byteLength(buffer)>4096){handled=true;socket.destroy();return;}
      if(!buffer.includes('\n'))return;handled=true;
      try{
        const message=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));
        if(!sameToken(message.token,token))throw new Error('APP_UNAUTHORIZED');
        if(!methods.has(message.method))throw new Error('APP_COMMAND_INVALID');
        const operation=message.method;
        if(operation!=='status' && pending)throw new Error('APP_SHUTTING_DOWN');
        const result={pid:process.pid,...status()};
        if(operation!=='status'){pending=true;result.accepted=true;result.operation=operation;}
        // Flush the acknowledgement before the application's normal quit cleanup.
        socket.end(JSON.stringify({ok:true,result})+'\n',()=>{if(operation!=='status')request(operation);});
      }catch(error){socket.end(JSON.stringify({ok:false,code:error.message})+'\n');}
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve);});
  if(process.platform!=='win32')fs.chmodSync(endpoint,0o600);
  const file=path.join(directory,'app-lifecycle.json'),temporary=`${file}.${process.pid}.tmp`;
  try{
    fs.writeFileSync(temporary,JSON.stringify({pid:process.pid,endpoint,token}),{mode:0o600});fs.renameSync(temporary,file);
  }catch(error){server.close();throw error;}
  let closing;
  return {close(){
    if(closing)return closing;
    closing=new Promise(resolve=>{
      for(const socket of sockets)socket.destroy();
      server.close(()=>{
        try{if(JSON.parse(fs.readFileSync(file,'utf8')).token===token)fs.rmSync(file);}catch{}
        if(process.platform!=='win32')try{fs.rmSync(endpoint,{force:true});}catch{}
        resolve();
      });
    });return closing;
  }};
}
async function requestApp(method,{directory=dataDirectory(),timeout=5000,token:overrideToken}={}){
  if(!methods.has(method))throw new Error('Use status, quit or restart.');
  let endpoint;
  try{endpoint=JSON.parse(fs.readFileSync(path.join(directory,'app-lifecycle.json'),'utf8'));}
  catch{throw new Error('ClipRelay is not running or this older process has no lifecycle CLI. Exit the old app normally once and launch the updated version.');}
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(endpoint.endpoint);
    let buffer='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;socket.destroy();error?reject(error):resolve(value);};
    socket.setEncoding('utf8');socket.setTimeout(timeout,()=>finish(new Error('APP_REQUEST_TIMEOUT: outcome unknown; inspect status before any further action.')));
    socket.on('error',error=>finish(error));socket.on('end',()=>finish(new Error('APP_RESPONSE_MISSING')));
    socket.on('connect',()=>socket.write(JSON.stringify({token:overrideToken??endpoint.token,method})+'\n'));
    socket.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>32768)return finish(new Error('APP_RESPONSE_TOO_LARGE'));
      if(!buffer.includes('\n'))return;
      try{const value=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));finish(value.ok?null:new Error(value.code),value.result);}catch(error){finish(error);}
    });
  });
}
async function initialize(app,{directory=dataDirectory(),development=false,sourceRoot=null}={}){
  const server=await serve({directory,status:()=>({version:app.getVersion(),channel:development?'development':'stable',sourceRoot}),request:method=>{if(method==='restart')app.relaunch({args:backgroundArguments()});app.quit();}});
  app.once('will-quit',()=>{void server.close();});
  return server;
}
function backgroundArguments(argv=process.argv){return [...argv.slice(1).filter(value=>!['--open-settings','--background'].includes(value)),'--background'];}
if(require.main===module){
  const args=process.argv.slice(2).filter(arg=>arg!=='--json');
  if(args.length!==1 || !methods.has(args[0])){console.error('Usage: npm run app -- <status|quit|restart>');process.exitCode=64;}
  else requestApp(args[0]).then(result=>console.log(JSON.stringify({ok:true,result},null,2))).catch(error=>{console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;});
}
module.exports={serve,requestApp,initialize,dataDirectory,backgroundArguments};
