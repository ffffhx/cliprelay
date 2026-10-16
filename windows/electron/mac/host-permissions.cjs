'use strict';
const path=require('node:path');
const {spawn}=require('node:child_process');
const artifact=require('./host-engine-artifact.cjs');
const fault=code=>Object.assign(new Error(code),{code});
const exactKeys=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) &&
  Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));

// Owns short-lived permission commands only. It never starts a streaming host.
class HostPermissions{
  constructor({directory,pin,platform=process.platform,arch=process.arch,launch=spawn,verify=artifact.verify,
    queryTimeout=10000,requestTimeout=120000,killDelay=1000,now=Date.now,onUpdate=()=>{}}){
    this.directory=directory;this.pin=Object.freeze({...pin});this.platform=platform;this.arch=arch;
    this.launch=launch;this.verify=verify;this.queryTimeout=queryTimeout;this.requestTimeout=requestTimeout;
    this.killDelay=killDelay;this.now=now;this.onUpdate=onUpdate;this.operation=null;this.closed=false;
    this.state={checking:false,screenRecording:null,inputControl:null,checkedAt:null,error:null};
  }
  snapshot(){return {...this.state};}
  notify(){if(!this.closed){try{this.onUpdate(this.snapshot());}catch{}}}
  query(){return this.run('status');}
  request(permission){
    const action=permission==='screenRecording'?'request-screen':permission==='inputControl'?'request-input':null;
    return action?this.run(action):Promise.reject(fault('INVALID_HOST_PERMISSION'));
  }
  run(action){
    if(this.closed)return Promise.reject(fault('HOST_PERMISSIONS_CLOSED'));
    if(this.operation){
      if(action==='status' && this.operation.action==='status' && !this.operation.done)return this.operation.promise;
      return Promise.reject(fault('HOST_PERMISSIONS_BUSY'));
    }
    const op={action,child:null,done:false,exited:false,chunks:[],bytes:0,stderrBytes:0,deadline:null,killTimer:null};
    op.promise=new Promise((resolve,reject)=>{op.resolve=resolve;op.reject=reject;});
    op.closedPromise=new Promise(resolve=>{op.resolveClosed=resolve;});
    this.operation=op;
    // Do not preserve a previous grant across an unverified query or failure.
    this.state={checking:true,screenRecording:null,inputControl:null,checkedAt:null,error:null};this.notify();
    if(op.done)return op.promise;
    try{
      if(this.platform!=='darwin' || !['arm64','x64'].includes(this.arch))throw fault('HOST_PLATFORM_UNSUPPORTED');
      if(typeof this.directory!=='string' || !path.isAbsolute(this.directory) ||
          this.pin.arch!==(this.arch==='x64'?'x86_64':'arm64'))throw fault('HOST_ENGINE_INVALID');
      try{this.verify(this.directory,this.pin);}catch{throw fault('HOST_ENGINE_INVALID');}
      if(op.done)return op.promise;
      const executable=path.join(this.directory,artifact.EXECUTABLE);
      op.child=this.launch(executable,['--cliprelay-permissions',action],{
        cwd:path.dirname(executable),stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false,detached:false
      });
      op.child.on('error',()=>this.finish(op,'HOST_PERMISSION_COMMAND_FAILED',true));
      op.child.once('close',(code,signal)=>{
        op.exited=true;clearTimeout(op.killTimer);clearTimeout(op.deadline);
        if(!op.done){
          if(code!==0 || signal)this.finish(op,'HOST_PERMISSION_COMMAND_FAILED',false);
          else{
            let value;
            try{
              value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(op.chunks)));
              const requested=action==='status'?'none':action==='request-screen'?'screenRecording':'inputControl';
              if(!exactKeys(value,['protocol','screenRecording','inputControl','requested']) || value.protocol!==1 ||
                  typeof value.screenRecording!=='boolean' || typeof value.inputControl!=='boolean' || value.requested!==requested)throw new Error();
            }catch{this.finish(op,'HOST_PERMISSION_BAD_REPLY',false);}
            if(!op.done)this.finish(op,null,false,value);
          }
        }
        this.release(op);
      });
      if(!op.child.stdout || !op.child.stderr)throw fault('HOST_PERMISSION_COMMAND_FAILED');
      op.child.stdout.on('error',()=>this.finish(op,'HOST_PERMISSION_BAD_REPLY',true));
      op.child.stderr.on('error',()=>this.finish(op,'HOST_PERMISSION_BAD_REPLY',true));
      op.child.stdout.on('data',chunk=>{
        if(op.done)return;
        const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);op.bytes+=bytes.length;
        if(op.bytes>4096)this.finish(op,'HOST_PERMISSION_BAD_REPLY',true);
        else op.chunks.push(bytes);
      });
      op.child.stderr.on('data',chunk=>{
        if(op.done)return;
        op.stderrBytes+=Buffer.byteLength(chunk);
        if(op.stderrBytes>16384)this.finish(op,'HOST_PERMISSION_BAD_REPLY',true);
      });
      op.deadline=setTimeout(()=>this.finish(op,'HOST_PERMISSION_TIMEOUT',true),action==='status'?this.queryTimeout:this.requestTimeout);
      op.deadline.unref?.();
    }catch(error){
      const allowed=['HOST_PLATFORM_UNSUPPORTED','HOST_ENGINE_INVALID','HOST_PERMISSION_COMMAND_FAILED'];
      this.finish(op,allowed.includes(error.code)?error.code:'HOST_PERMISSION_COMMAND_FAILED',true);
    }
    return op.promise;
  }
  release(op){
    clearTimeout(op.deadline);clearTimeout(op.killTimer);op.chunks=[];
    if(this.operation===op)this.operation=null;
    op.resolveClosed();
  }
  finish(op,error,terminate,value){
    if(op.done)return;
    op.done=true;clearTimeout(op.deadline);op.chunks=[];
    if(error){
      this.state={checking:false,screenRecording:null,inputControl:null,checkedAt:null,error};
      op.reject(fault(error));
    }else{
      this.state={checking:false,screenRecording:value.screenRecording,inputControl:value.inputControl,checkedAt:this.now(),error:null};
      op.resolve(this.snapshot());
    }
    if(terminate && op.child && !op.exited){
      try{op.child.kill('SIGTERM');}catch{}
      if(!op.exited){
        op.killTimer=setTimeout(()=>{if(!op.exited){try{op.child.kill('SIGKILL');}catch{}}},this.killDelay);
        op.killTimer.unref?.();
      }
    }
    // Keep the operation occupied until its process is actually reaped. A new
    // permission request must never overlap a timed-out or cancelled dialog.
    if(!op.child || op.exited)this.release(op);
    this.notify();
  }
  cancel(){
    const op=this.operation;
    if(op)this.finish(op,'HOST_PERMISSION_CANCELLED',true);
    return op?.closedPromise || Promise.resolve();
  }
  close(){
    this.closed=true;const stopped=this.cancel();
    this.state={checking:false,screenRecording:null,inputControl:null,checkedAt:null,error:'HOST_PERMISSIONS_CLOSED'};
    return stopped;
  }
}
module.exports={HostPermissions};
