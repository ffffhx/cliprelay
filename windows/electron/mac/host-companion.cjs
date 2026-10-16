'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const artifact=require('./host-companion-artifact.cjs');
const fault=code=>Object.assign(new Error(code),{code});
const failures=new Set(['HOST_PLATFORM_UNSUPPORTED','HOST_COMPANION_INVALID','HOST_COMPANION_START_FAILED',
  'HOST_COMPANION_TIMEOUT','HOST_COMPANION_EXITED','HOST_COMPANION_BAD_REPLY','HOST_COMPANION_IPC_INVALID',
  'HOST_CERT_UNAVAILABLE','HOST_STATE_INVALID','HOST_STATE_NOT_PREPARED']);
function verifySocket(file){
  try{
    if(typeof file!=='string' || !path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file) || path.basename(file)!=='clipboard-relay.sock')throw Error();
    const directory=path.dirname(file),temporary=fs.realpathSync('/tmp');
    if(path.dirname(directory)!==temporary || !/^cliprelay-host-[A-Za-z0-9]+$/.test(path.basename(directory)) || fs.realpathSync(directory)!==directory)throw Error();
    const parent=fs.lstatSync(directory),socket=fs.lstatSync(file);
    if(!parent.isDirectory() || parent.isSymbolicLink() || parent.uid!==process.getuid() || (parent.mode&0o7777)!==0o700 ||
        !socket.isSocket() || socket.isSymbolicLink() || socket.uid!==process.getuid() || (socket.mode&0o7777)!==0o600)throw Error();
    return file;
  }catch{throw fault('HOST_COMPANION_IPC_INVALID');}
}
function receipt(raw,pid){
  let value;
  try{
    value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
    const names=['type','protocol','pid','ownerPid','ipc','nativeWorkers'];
    if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join(',')!==names.sort().join(',') ||
        value.type!=='listening' || value.protocol!==1 || value.pid!==pid || value.ownerPid!==process.pid ||
        typeof value.ipc!=='string' || value.ipc.length>1024 || value.nativeWorkers!==false)throw Error();
    // Only flat scalar fields are allowed; count their lexical keys as well so
    // duplicate fields cannot be silently replaced by JSON.parse.
    const encoded=raw.toString('utf8'),found=[...encoded.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map(match=>JSON.parse('"'+match[1]+'"'));
    if(found.length!==names.length || new Set(found).size!==names.length)throw Error();
  }catch{throw fault('HOST_COMPANION_BAD_REPLY');}
  return value;
}
// Owns the actual child until close, including failed starts and forced stops.
// Listening means control listeners exist, not a verified remote video session.
class HostCompanion{
  #ipc=null;
  constructor({directory,pin,state,platform=process.platform,arch=process.arch,launch=spawn,verify=artifact.verify,
    checkSocket=verifySocket,onUpdate=()=>{},readyTimeout=15000,stopGraceMs=20000,killDelayMs=1000}){
    Object.assign(this,{directory,pin:Object.freeze({...pin}),state,platform,arch,launch,verify,checkSocket,onUpdate,readyTimeout,stopGraceMs,killDelayMs});
    this.current=null;this.closed=false;this.value={phase:'stopped',error:null,nativeWorkers:false,fileTransfer:false};
  }
  snapshot(){return {...this.value};}
  publish(phase,error=null){this.value={phase,error,nativeWorkers:false,fileTransfer:phase==='running'&&this.current?.fileTransfer===true};try{this.onUpdate(this.snapshot());}catch{}}
  ipcPath(){if(this.value.phase!=='running' || !this.#ipc)throw fault('HOST_COMPANION_UNAVAILABLE');return this.checkSocket(this.#ipc);}
  assertCurrent(op){if(this.current!==op || op.stopping || this.closed)throw fault('HOST_COMPANION_CANCELLED');}
  start(){
    if(this.closed)return Promise.reject(fault('HOST_COMPANION_CLOSED'));
    if(this.current)return Promise.reject(fault('HOST_COMPANION_BUSY'));
    const op={child:null,exited:false,stopping:false,started:false,stopPromise:null,buffer:Buffer.alloc(0),frame:null};
    this.current=op;this.publish('starting');
    op.startPromise=this.startOperation(op).catch(async error=>{
      const cancelled=op.stopping || this.closed;
      const code=op.failure || (cancelled?'HOST_COMPANION_CANCELLED':failures.has(error.code)?error.code:'HOST_COMPANION_START_FAILED');
      await this.stopOperation(op,cancelled && !op.failure?null:code);throw fault(code);
    });
    return op.startPromise;
  }
  async startOperation(op){
    this.assertCurrent(op);
    if(this.platform!=='darwin' || !['arm64','x64'].includes(this.arch))throw fault('HOST_PLATFORM_UNSUPPORTED');
    if(typeof this.directory!=='string' || !path.isAbsolute(this.directory) || !path.isAbsolute(this.state.directory))throw fault('HOST_COMPANION_INVALID');
    try{op.fileTransfer=this.verify(this.directory,this.pin)?.manifest?.fileTransfer===1;}catch{throw fault('HOST_COMPANION_INVALID');}
    this.assertCurrent(op);op.frame=this.state.companionInitialization();
    if(!Buffer.isBuffer(op.frame) || !op.frame.length || op.frame.length>96*1024)throw fault('HOST_STATE_INVALID');
    const executable=path.join(this.directory,artifact.EXECUTABLE);
    op.child=this.launch(executable,['--state-dir',this.state.directory,'--owner-pid',String(process.pid)],
      {cwd:path.dirname(executable),env:{...process.env},stdio:['pipe','pipe','ignore'],shell:false,detached:false,windowsHide:true});
    op.exitPromise=new Promise(resolve=>{op.resolveExit=resolve;});
    const ready=new Promise((resolve,reject)=>{op.resolveReady=resolve;op.rejectReady=reject;});
    const fail=code=>{
      if(!op.stopping)op.failure=code;
      op.rejectReady(fault(code));if(op.started && !op.stopping)void this.stopOperation(op,code);
    };
    op.child.on('error',()=>fail('HOST_COMPANION_START_FAILED'));
    op.child.stdin?.on('error',()=>fail('HOST_COMPANION_START_FAILED'));
    op.child.stdout?.on('error',()=>fail('HOST_COMPANION_BAD_REPLY'));
    op.child.once('close',()=>{
      op.exited=true;op.frame?.fill(0);op.frame=null;op.resolveExit();fail('HOST_COMPANION_EXITED');
    });
    op.child.stdout?.on('data',chunk=>{
      if(op.stopping)return;
      try{
        if(op.replySeen || op.buffer.length+chunk.length>4096)throw fault('HOST_COMPANION_BAD_REPLY');
        op.buffer=Buffer.concat([op.buffer,chunk]);const newline=op.buffer.indexOf(10);
        if(newline<0)return;
        if(newline!==op.buffer.length-1)throw fault('HOST_COMPANION_BAD_REPLY');
        const value=receipt(op.buffer.subarray(0,newline),op.child.pid);
        this.#ipc=this.checkSocket(value.ipc);op.replySeen=true;op.buffer=Buffer.alloc(0);op.resolveReady();
      }catch(error){fail(error.code==='HOST_COMPANION_IPC_INVALID'?error.code:'HOST_COMPANION_BAD_REPLY');}
    });
    const timeout=setTimeout(()=>op.rejectReady(fault('HOST_COMPANION_TIMEOUT')),this.readyTimeout);
    try{
      if(!op.child.stdin || !op.child.stdout || !Number.isInteger(op.child.pid))op.rejectReady(fault('HOST_COMPANION_START_FAILED'));
      else try{op.child.stdin.write(op.frame,error=>{
        // Clear this Buffer only when Node has finished consuming it. JS string
        // copies and downstream library buffers are not claimed to be erased.
        op.frame?.fill(0);op.frame=null;if(error)fail('HOST_COMPANION_START_FAILED');
      });}catch{fail('HOST_COMPANION_START_FAILED');}
      await ready;this.assertCurrent(op);
      if(op.failure)throw fault(op.failure);
      if(op.exited)throw fault('HOST_COMPANION_EXITED');
      op.started=true;this.publish('running');this.assertCurrent(op);return this.snapshot();
    }finally{clearTimeout(timeout);}
  }
  stopOperation(op,error=null){
    if(op.stopPromise)return op.stopPromise;
    let resolveStop,rejectStop;op.stopPromise=new Promise((resolve,reject)=>{resolveStop=resolve;rejectStop=reject;});
    op.stopping=true;op.failure=error;this.#ipc=null;op.rejectReady?.(fault(error || 'HOST_COMPANION_CANCELLED'));
    if(this.current===op)this.publish('stopping',error);
    (async()=>{
      let terminate,force;
      try{
        if(op.child && !op.exited){
          try{op.child.stdin?.end();}catch{}
          terminate=setTimeout(()=>{if(!op.exited){try{op.child.kill('SIGTERM');}catch{}}},this.stopGraceMs);
          force=setTimeout(()=>{if(!op.exited){try{op.child.kill('SIGKILL');}catch{}}},this.stopGraceMs+this.killDelayMs);
          await op.exitPromise;
        }
      }finally{
        clearTimeout(terminate);clearTimeout(force);op.frame?.fill(0);op.frame=null;op.buffer.fill(0);
        if(this.current===op){this.current=null;this.publish(this.closed?'closed':error?'failed':'stopped',error);}
      }
      return this.snapshot();
    })().then(resolveStop,rejectStop);return op.stopPromise;
  }
  stop(){return this.current?this.stopOperation(this.current):Promise.resolve(this.snapshot());}
  close(){
    if(!this.closePromise){this.closed=true;this.closePromise=this.stop().then(()=>{this.publish('closed');return this.snapshot();});}
    return this.closePromise;
  }
}
module.exports={HostCompanion,verifySocket,receipt};
