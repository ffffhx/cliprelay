'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const {spawn}=require('node:child_process');
const {fault}=require('./paired-transport.cjs');

const helperErrors=new Set(['INVALID_INITIALIZATION','INITIALIZATION_TIMEOUT','NODE_UNAVAILABLE','INVALID_PEER','CONNECTION_FAILED','INVALID_COMMAND']);
const keys=(value,expected)=>value && typeof value==='object' && !Array.isArray(value) &&
  Object.keys(value).length===expected.length && expected.every(key=>Object.hasOwn(value,key));

function initialization(value){
  if(!keys(value,['controlUrl','hostname','authKey','peerIP']) || typeof value.controlUrl!=='string' ||
      Buffer.byteLength(value.controlUrl)>2048 || typeof value.hostname!=='string' || !/^cr-[a-f0-9]{24}$/.test(value.hostname) ||
      typeof value.authKey!=='string' || Buffer.byteLength(value.authKey)>4096 || typeof value.peerIP!=='string' || net.isIP(value.peerIP)!==4)
    throw fault('INVALID_NETWORK_INITIALIZATION');
  const octets=value.peerIP.split('.').map(Number);
  if(octets[0]!==100 || octets[1]<64 || octets[1]>127)throw fault('INVALID_NETWORK_INITIALIZATION');
  let url;try{url=new URL(value.controlUrl);}catch{throw fault('INVALID_NETWORK_INITIALIZATION');}
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/' ||
      ![url.origin,url.origin+'/'].includes(value.controlUrl))throw fault('INVALID_NETWORK_INITIALIZATION');
  return Buffer.from(JSON.stringify({version:1,...value})+'\n');
}

function executable(directory,platform=process.platform){
  const relative=platform==='win32'?'runtime/cliprelay-client-network.exe':platform==='darwin'?'runtime/cliprelay-client-network':null;
  if(!relative)throw fault('NETWORK_UNAVAILABLE');
  try{
    directory=path.resolve(directory);
    for(const item of [directory,path.join(directory,'runtime')]){
      const stat=fs.lstatSync(item);if(!stat.isDirectory() || stat.isSymbolicLink())throw new Error();
    }
    const manifestFile=path.join(directory,'manifest.json'),manifestStat=fs.lstatSync(manifestFile);
    if(!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size>1024*1024)throw new Error();
    const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
    if(manifest.role!=='desktop-network' || manifest.protocol!==1 || manifest.platform!==(platform==='win32'?'windows':'macos') ||
        !/^[a-f0-9]{64}$/.test(manifest.files?.[relative] || ''))throw new Error();
    const file=path.join(directory,...relative.split('/')),stat=fs.lstatSync(file);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>128*1024*1024 ||
        crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==manifest.files[relative])throw new Error();
    if(platform==='darwin')fs.accessSync(file,fs.constants.X_OK);
    return file;
  }catch{throw fault('NETWORK_INVALID');}
}

function privateDirectory(directory){
  if(typeof directory!=='string' || !path.isAbsolute(directory))throw fault('INVALID_NETWORK_STORAGE');
  try{
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const stat=fs.lstatSync(directory);if(!stat.isDirectory() || stat.isSymbolicLink())throw new Error();
    if(process.platform!=='win32')fs.chmodSync(directory,0o700);
  }catch{throw fault('INVALID_NETWORK_STORAGE');}
}

// One instance owns one saved peer's private node directory and one child.
// ready means the helper's local listeners exist, not that the peer is online.
// A route is transient; never persist its port or pass enrollment to renderers.
class NetworkChannel{
  constructor({directory,stateDirectory,onUpdate=()=>{},spawnProcess=spawn,resolveExecutable=executable,
               startupMs=30000,pollMs=2000,responseMs=5000,shutdownMs=5000}){
    Object.assign(this,{directory,stateDirectory,onUpdate,spawnProcess,resolveExecutable,startupMs,pollMs,responseMs,shutdownMs});
    this.phase='idle';this.error='';this.current=null;this.route=null;this.path='connecting';
  }
  snapshot(){return {phase:this.phase,error:this.error,path:this.path,route:this.route?{...this.route}:null};}
  changed(){try{this.onUpdate(this.snapshot());}catch{/* A window callback cannot orphan the helper. */}}
  start(value,{signal}={}){
    if(this.current)return Promise.reject(fault('NETWORK_BUSY'));
    if(signal?.aborted)return Promise.reject(fault('CANCELLED'));
    let bytes,file;
    try{bytes=initialization(value);file=this.resolveExecutable(this.directory);privateDirectory(this.stateDirectory);}
    catch(error){bytes?.fill(0);return Promise.reject(fault(['INVALID_NETWORK_INITIALIZATION','INVALID_NETWORK_STORAGE','NETWORK_INVALID','NETWORK_UNAVAILABLE'].includes(error.code)?error.code:'NETWORK_UNAVAILABLE'));}
    let resolve,reject,closed;
    const started=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const ending=new Promise(yes=>{closed=yes;});
    const record={child:null,buffer:Buffer.alloc(0),bytes,resolve,reject,closed,ending,settled:false,stopping:false,
      routeId:crypto.randomUUID(),signal,abort:()=>this.stop(),timers:[],poll:null,response:null,port:0};
    this.current=record;this.phase='starting';this.error='';this.route=null;this.path='connecting';
    const settle=(error,route)=>{if(record.settled)return;record.settled=true;error?record.reject(fault(error)):record.resolve(route);};
    record.settle=settle;
    const finish=()=>{
      for(const timer of record.timers)clearTimeout(timer);
      clearInterval(record.poll);clearTimeout(record.response);
      record.signal?.removeEventListener('abort',record.abort);record.bytes?.fill(0);record.buffer.fill(0);
      settle(record.failure || 'NETWORK_CLOSED');
      if(this.current===record){this.current=null;this.route=null;this.path='connecting';this.phase=record.failure?'error':'idle';this.error=record.failure || '';this.changed();}
      record.closed();
    };
    const fail=code=>{
      if(this.current!==record || record.stopping)return;
      record.failure=code;settle(code);this.shutdown(record);
    };
    record.fail=fail;
    try{
      const child=this.spawnProcess(file,['--state-dir',this.stateDirectory],{cwd:path.dirname(file),windowsHide:true,shell:false,stdio:['pipe','pipe','ignore']});
      record.child=child;
      child.on('error',()=>fail('NETWORK_UNAVAILABLE'));
      child.once('close',()=>{
        if(!record.stopping){record.failure='NETWORK_CLOSED';settle(record.failure);}
        finish();
      });
      if(!child.stdin || !child.stdout){fail('NETWORK_UNAVAILABLE');return started;}
      child.stdin.on('error',()=>fail('NETWORK_CLOSED'));
      child.stdout.on('error',()=>fail('NETWORK_CLOSED'));
      child.stdout.on('data',chunk=>this.consume(record,chunk));
      child.once('spawn',()=>{
        if(record.stopping || this.current!==record){record.bytes.fill(0);return;}
        child.stdin.write(record.bytes,error=>{record.bytes.fill(0);if(error)fail('NETWORK_CLOSED');});
      });
      record.timers.push(setTimeout(()=>fail('NETWORK_TIMEOUT'),this.startupMs));
      record.signal?.addEventListener('abort',record.abort,{once:true});
      if(record.signal?.aborted)record.abort();
      this.changed();
    }catch{record.failure='NETWORK_UNAVAILABLE';settle(record.failure);finish();}
    return started;
  }
  consume(record,chunk){
    if(this.current!==record || record.stopping)return;
    let offset=0;
    while(offset<chunk.length){
      const newline=chunk.indexOf(10,offset),end=newline<0?chunk.length:newline;
      if(record.buffer.length+end-offset>1024){record.fail('NETWORK_BAD_REPLY');return;}
      record.buffer=Buffer.concat([record.buffer,chunk.subarray(offset,end)]);
      if(newline<0)return;
      let message;
      try{message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(record.buffer));}
      catch{record.fail('NETWORK_BAD_REPLY');return;}
      record.buffer=Buffer.alloc(0);offset=end+1;
      if(keys(message,['type','code']) && message.type==='error' && helperErrors.has(message.code)){
        record.fail('NETWORK_CONNECTION_FAILED');return;
      }
      if(!keys(message,['type','ready','port','path']) || message.type!=='status' || typeof message.ready!=='boolean' ||
          !Number.isInteger(message.port) || !['connecting','direct','relay'].includes(message.path) ||
          (message.ready?(message.port<1029 || message.port>65514):message.port!==record.port)){
        record.fail('NETWORK_BAD_REPLY');return;
      }
      if(record.port && (!message.ready || message.port!==record.port)){
        record.fail('NETWORK_ROUTE_LOST');return;
      }
      clearTimeout(record.response);record.response=null;
      if(message.ready){
        if(!record.port){
          record.port=message.port;clearTimeout(record.timers[0]);
          this.route={address:'127.0.0.1',port:message.port,overlay:true,overlayPort:48789,routeId:record.routeId};
          this.phase='ready';record.settle(null,{...this.route});
          record.poll=setInterval(()=>this.poll(record),this.pollMs);record.poll.unref?.();
        }
        this.path=message.path;this.changed();
      }
      if(this.current!==record || record.stopping)return;
    }
  }
  poll(record){
    if(this.current!==record || record.stopping || record.response)return;
    record.response=setTimeout(()=>record.fail('NETWORK_TIMEOUT'),this.responseMs);
    record.child.stdin.write('{"action":"status"}\n',error=>{if(error)record.fail('NETWORK_CLOSED');});
  }
  shutdown(record){
    if(record.stopping)return record.ending;
    record.stopping=true;record.settle(record.failure || 'CANCELLED');
    clearInterval(record.poll);clearTimeout(record.response);
    for(const timer of record.timers)clearTimeout(timer);
    if(this.current===record){this.route=null;this.path='connecting';this.phase=record.failure?'error':'closing';this.error=record.failure || '';this.changed();}
    record.child?.stdin?.end();
    record.timers.push(setTimeout(()=>{if(this.current===record)record.child?.kill('SIGKILL');},this.shutdownMs));
    return record.ending;
  }
  stop(){
    if(this.current)return this.shutdown(this.current);
    this.phase='idle';this.error='';this.route=null;this.path='connecting';this.changed();return Promise.resolve();
  }
}
module.exports={NetworkChannel,initialization,executable};
