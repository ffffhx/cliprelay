'use strict';
const path=require('node:path'),{spawn}=require('node:child_process');
const artifact=require('./host-engine-artifact.cjs');
const {HostPermissions}=require('./host-permissions.cjs');
const {hostStatus}=require('./host-admin.cjs');
const fault=code=>Object.assign(new Error(code),{code});
const failures=new Set(['HOST_PLATFORM_UNSUPPORTED','HOST_ENGINE_INVALID','HOST_ENGINE_EXITED','HOST_ENGINE_START_FAILED',
  'HOST_ENGINE_TIMEOUT','HOST_ENGINE_IDENTITY_CHANGED','HOST_ENGINE_OWNER_LOST','HOST_PERMISSION_REQUIRED',
  'HOST_PERMISSION_TIMEOUT','HOST_PERMISSION_COMMAND_FAILED','HOST_PERMISSION_BAD_REPLY',
  'HOST_CERT_CHANGED','HOST_ADMIN_INVALID','HOST_ADMIN_BAD_REPLY','HOST_ADMIN_UNAUTHORIZED','HOST_ADMIN_UNAVAILABLE','HOST_ADMIN_TIMEOUT',
  'HOST_KEYCHAIN_UNAVAILABLE','HOST_STATE_INVALID','HOST_STATE_UNOWNED','HOST_STATE_CHANGED','HOST_STATE_UNAVAILABLE']);
const retryable=new Set(['HOST_CERT_UNAVAILABLE','HOST_ADMIN_UNAVAILABLE','HOST_ADMIN_TIMEOUT']);
function delay(ms,signal){return new Promise((resolve,reject)=>{
  const done=()=>{signal.removeEventListener('abort',abort);resolve();};
  const timer=setTimeout(done,ms);
  const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(fault('HOST_ENGINE_CANCELLED'));};
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
});}
// Owns the native engine only. Pair approvals, network workers and complete host
// readiness are separate; an authenticated engine is not a verified video path.
class HostEngine{
  constructor({directory,pin,state,platform=process.platform,arch=process.arch,launch=spawn,verify=artifact.verify,
    permissions,probe=hostStatus,onUpdate=()=>{},readyTimeout=20000,probeTimeout=3000,pollMs=250,monitorMs=1500,
    stopGraceMs=12000,killDelayMs=1000}){
    Object.assign(this,{directory,pin:Object.freeze({...pin}),state,platform,arch,launch,verify,probe,onUpdate,
      readyTimeout,probeTimeout,pollMs,monitorMs,stopGraceMs,killDelayMs});
    this.permissions=permissions || new HostPermissions({directory,pin,platform,arch});
    this.current=null;this.closed=false;
    this.value={phase:'stopped',pid:null,error:null,screenRecording:null,inputControl:null};
  }
  snapshot(){return {...this.value};}
  publish(phase,error=null,pid=null,grants=null){
    this.value={phase,error,pid,screenRecording:grants?.screenRecording ?? null,inputControl:grants?.inputControl ?? null};
    try{this.onUpdate(this.snapshot());}catch{}
  }
  assertCurrent(op){if(this.current!==op || op.abort.signal.aborted || this.closed)throw fault('HOST_ENGINE_CANCELLED');}
  start(hostName){
    if(this.closed)return Promise.reject(fault('HOST_ENGINE_CLOSED'));
    if(this.current)return Promise.reject(fault('HOST_ENGINE_BUSY'));
    const op={abort:new AbortController(),child:null,exited:false,stopping:false,started:false,failure:null,stopPromise:null};
    this.current=op;this.publish('starting');
    op.startPromise=this.startOperation(op,hostName).catch(async error=>{
      const cancelled=op.abort.signal.aborted || this.closed;
      const code=cancelled?'HOST_ENGINE_CANCELLED':failures.has(error.code)?error.code:'HOST_ENGINE_START_FAILED';
      await this.stopOperation(op,cancelled?null:code);throw fault(code);
    });
    return op.startPromise;
  }
  async startOperation(op,hostName){
    this.assertCurrent(op);
    if(this.platform!=='darwin' || !['arm64','x64'].includes(this.arch))throw fault('HOST_PLATFORM_UNSUPPORTED');
    if(typeof this.directory!=='string' || !path.isAbsolute(this.directory) || this.pin.arch!==(this.arch==='x64'?'x86_64':'arm64'))throw fault('HOST_ENGINE_INVALID');
    try{this.verify(this.directory,this.pin);}catch{throw fault('HOST_ENGINE_INVALID');}
    const grants=await this.permissions.query();this.assertCurrent(op);
    if(grants.screenRecording!==true || grants.inputControl!==true)throw fault('HOST_PERMISSION_REQUIRED');
    this.state.prepare(hostName);this.assertCurrent(op);
    const executable=path.join(this.directory,artifact.EXECUTABLE);
    const env=this.state.environment({...process.env,CLIPRELAY_HOST_OWNER_PID:String(process.pid)});
    op.child=this.launch(executable,[],{cwd:path.dirname(executable),env,stdio:['pipe','ignore','ignore'],shell:false,detached:false,windowsHide:true});
    op.exitPromise=new Promise(resolve=>{op.resolveExit=resolve;});
    op.child.on('error',()=>{op.launchFailed=true;});
    op.child.stdin?.on('error',()=>{});
    op.child.once('close',(code,signal)=>{
      op.exited=true;op.exitCode=code;op.signalCode=signal;op.resolveExit();
      if(op.started && !op.stopping)void this.stopOperation(op,'HOST_ENGINE_EXITED');
    });
    if(!op.child.stdin || !Number.isInteger(op.child.pid))throw fault('HOST_ENGINE_START_FAILED');
    const deadline=Date.now()+this.readyTimeout;
    while(Date.now()<deadline){
      this.assertCurrent(op);
      if(op.exited || op.launchFailed)throw fault('HOST_ENGINE_EXITED');
      try{
        const status=await this.probe({state:this.state,signal:op.abort.signal,timeout:Math.min(this.probeTimeout,deadline-Date.now())});
        this.assertCurrent(op);this.acceptStatus(op,status);
        op.started=true;this.publish('running',null,op.child.pid,status);
        this.assertCurrent(op);
        op.monitor=this.monitor(op);return this.snapshot();
      }catch(error){if(!retryable.has(error.code))throw error;}
      await delay(Math.min(this.pollMs,Math.max(1,deadline-Date.now())),op.abort.signal);
    }
    throw fault('HOST_ENGINE_TIMEOUT');
  }
  acceptStatus(op,status){
    if(op.exited || op.launchFailed)throw fault('HOST_ENGINE_EXITED');
    if(status.pid!==op.child.pid || status.ownerPid!==process.pid)throw fault('HOST_ENGINE_IDENTITY_CHANGED');
    if(status.owned!==true)throw fault('HOST_ENGINE_OWNER_LOST');
    if(status.screenRecording!==true || status.inputControl!==true)throw fault('HOST_PERMISSION_REQUIRED');
  }
  async monitor(op){
    try{
      while(!op.abort.signal.aborted){
        await delay(this.monitorMs,op.abort.signal);this.assertCurrent(op);
        const status=await this.probe({state:this.state,signal:op.abort.signal,timeout:this.probeTimeout});
        this.assertCurrent(op);this.acceptStatus(op,status);
      }
    }catch(error){
      if(!op.abort.signal.aborted)await this.stopOperation(op,failures.has(error.code)?error.code:'HOST_ADMIN_UNAVAILABLE');
    }
  }
  stopOperation(op,error=null){
    if(op.stopPromise)return op.stopPromise;
    let resolveStop,rejectStop;
    op.stopPromise=new Promise((resolve,reject)=>{resolveStop=resolve;rejectStop=reject;});
    op.stopping=true;op.failure=error;op.abort.abort();
    if(this.current===op)this.publish('stopping',error);
    (async()=>{
      try{await this.permissions.cancel();}catch{}
      let terminate,force;
      try{
        if(op.child && !op.exited){
          // EOF is the native owner's normal shutdown request. Keep ownership
          // until the actual close event, including escalation after a timeout.
          try{op.child.stdin?.end();}catch{}
          terminate=setTimeout(()=>{if(!op.exited){try{op.child.kill('SIGTERM');}catch{}}},this.stopGraceMs);
          force=setTimeout(()=>{if(!op.exited){try{op.child.kill('SIGKILL');}catch{}}},this.stopGraceMs+this.killDelayMs);
          await op.exitPromise;
        }
      }finally{
        clearTimeout(terminate);clearTimeout(force);
        if(this.current===op){this.current=null;this.publish(this.closed?'closed':error?'failed':'stopped',error);}
      }
      return this.snapshot();
    })().then(resolveStop,rejectStop);
    return op.stopPromise;
  }
  stop(){return this.current?this.stopOperation(this.current):Promise.resolve(this.snapshot());}
  async close(){
    this.closed=true;await this.stop();
    try{await this.permissions.close();}finally{this.state.close();this.publish('closed');}
  }
}
module.exports={HostEngine};
