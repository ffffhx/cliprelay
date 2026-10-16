'use strict';
const fault=code=>Object.assign(new Error(code),{code});
// Both owners are main-process objects. The network service must finish using
// the engine's credentials before engine.close() releases their shared state.
class HostSession{
  constructor({engine,companion,onUpdate=()=>{}}){
    Object.assign(this,{engine,companion,onUpdate});this.current=null;this.closed=false;this.value={phase:'stopped',error:null,nativeWorkers:false};
    for(const owner of [engine,companion])owner.onUpdate=value=>this.ownerChanged(owner,value);
  }
  snapshot(){return {...this.value};}
  publish(phase,error=null){this.value={phase,error,nativeWorkers:false};try{this.onUpdate(this.snapshot());}catch{}}
  ownerChanged(owner,value){
    const op=this.current;if(!op || op.stopping)return;
    if(value.phase==='failed' || (value.phase==='stopping' && value.error) ||
        (op.started && value.phase!=='running'))void this.stopOperation(op,value.error || (owner===this.engine?'HOST_ENGINE_EXITED':'HOST_COMPANION_EXITED'));
  }
  assertCurrent(op){if(this.current!==op || op.stopping || this.closed)throw fault(op.failure || 'HOST_SESSION_CANCELLED');}
  start(hostName){
    if(this.closed)return Promise.reject(fault('HOST_SESSION_CLOSED'));
    if(this.current)return Promise.reject(fault('HOST_SESSION_BUSY'));
    const op={stopping:false,started:false,failure:null};this.current=op;this.publish('starting');
    return (async()=>{
      try{
        this.assertCurrent(op);await this.engine.start(hostName);this.assertCurrent(op);
        await this.companion.start();this.assertCurrent(op);
        if(this.engine.snapshot().phase!=='running' || this.companion.snapshot().phase!=='running')throw fault('HOST_SESSION_UNAVAILABLE');
        op.started=true;this.publish('running');this.assertCurrent(op);return this.snapshot();
      }catch(error){
        const code=op.failure || (op.stopping || this.closed?'HOST_SESSION_CANCELLED':error.code || 'HOST_SESSION_UNAVAILABLE');
        await this.stopOperation(op,code==='HOST_SESSION_CANCELLED'?null:code);throw fault(code);
      }
    })();
  }
  stopOperation(op,error=null){
    if(op.stopPromise)return op.stopPromise;
    let resolveStop,rejectStop;op.stopPromise=new Promise((resolve,reject)=>{resolveStop=resolve;rejectStop=reject;});
    op.stopping=true;op.failure=error;if(this.current===op)this.publish('stopping',error);
    (async()=>{
      // Keep the engine available while the companion joins active approvals,
      // handlers and restoration. Both stop methods wait for actual child close.
      await this.companion.stop();await this.engine.stop();
      if(this.current===op){this.current=null;this.publish(this.closed?'closed':error?'failed':'stopped',error);}
      return this.snapshot();
    })().then(resolveStop,rejectStop);return op.stopPromise;
  }
  stop(){return this.current?this.stopOperation(this.current):Promise.resolve(this.snapshot());}
  close(){
    if(!this.closePromise){
      this.closed=true;this.closePromise=(async()=>{await this.stop();await this.companion.close();await this.engine.close();this.publish('closed');return this.snapshot();})();
    }
    return this.closePromise;
  }
}
module.exports={HostSession};
