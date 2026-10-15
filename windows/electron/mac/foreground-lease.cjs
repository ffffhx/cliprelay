'use strict';
const crypto=require('node:crypto');
const {sameRoute}=require('./routed-store.cjs');
const {fault}=require('./paired-transport.cjs');
const terminal=new Set(['HOST_CERT_CHANGED','UNPAIRED','RELAY_UNPAIRED','KEYCHAIN_UNAVAILABLE']);

// One serialized loop owns a short host lease. A new stream/route never adopts
// an old lease, and no failed start/renew is automatically retried as a start.
class ForegroundLeaseController{
  constructor({store,viewer,protocol,prefix,request=protocol.request,now=()=>performance.now(),pollMs=1000,renewMs=3000}){
    Object.assign(this,{store,viewer,protocol,prefix,request,now,pollMs,renewMs});this.cleanups=new Set();
  }
  code(name){return this.prefix+'_'+name;}
  fault(name){return fault(this.code(name));}
  current(r){return !this.closed&&this.record===r&&!r.abort.signal.aborted&&this.viewer.currentSession()===r.session&&sameRoute(this.store.selected(),r.host);}
  reconcile(){
    if(this.closed)return;
    const session=this.viewer.currentSession();
    if(this.record?.session===session&&this.current(this.record))return;
    this.dispose();
    if(!session||!sameRoute(this.store.selected(),session.host))return;
    const r=this.record={session,host:{...session.host},abort:new AbortController(),viewId:crypto.randomBytes(16).toString('hex'),desired:false,phase:'loading',error:''};
    if(!session.telemetry){r.phase='unavailable';r.error=this.code('UNSUPPORTED');return;}
    void this.poll(r);
  }
  dispose(){
    const r=this.record;this.record=null;if(!r)return;
    r.abort.abort();clearTimeout(r.timer);clearTimeout(r.expiry);
    if(r.lease&&r.identity){
      // A lost start response can still have activated the host. Use the old
      // pinned route and its exact lease even after ownership has moved on.
      const cleanup=this.cleanup(r.host,r.identity,r.lease).finally(()=>this.cleanups.delete(cleanup));
      this.cleanups.add(cleanup);
    }
  }
  async cleanup(host,identity,lease){
    for(let attempt=0;attempt<3;attempt++){
      try{const result=await this.request(host,identity,'stop',lease);if(this.restored(result))return;}
      catch(error){if(terminal.has(error.code))return;}
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,250));
    }
    // The host and worker also expire independently; no client retry renews it.
  }
  schedule(r,immediate=false){
    if(!this.current(r)){this.reconcile();return;}
    clearTimeout(r.timer);r.timer=setTimeout(()=>void this.poll(r),immediate?0:this.pollMs);r.timer.unref?.();
  }
  fresh(r){return r.display&&this.now()-r.at<4000&&this.protocol.presented(r.display,this.viewer.snapshot().progress);}
  restored(state){return !state.active&&!state.recovering;}
  viewIdentity(d){return [d?.instance,d?.stream?.id].join(':');}
  streamBinding(d){return {instance:d.instance,stream:d.stream.id};}
  sameBinding(a,b){return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>a[key]===b[key]);}
  available(r){try{this.binding(r);return true;}catch{return false;}}
  binding(r){
    const d=r.display;
    if(!d?.supported)throw this.fault('UNSUPPORTED');
    if(!d.stream)throw this.fault('NO_EXCLUSIVE_STREAM');
    if(!this.fresh(r))throw this.fault('NOT_READY');
    const binding=this.streamBinding(d);
    if(r.intentBinding&&!this.sameBinding(r.intentBinding,binding))throw this.fault('STALE');
    if(r.lease){const {lease,...held}=r.lease;if(!this.sameBinding(held,binding))throw this.fault('STALE');}
    return binding;
  }
  confirmed(r,state,sentAt){
    if(!state.active||state.recovering||state.lease!==r.lease?.lease)throw this.fault('EXPIRED');
    const expiresAt=sentAt+state.expiresMs;
    if(expiresAt<=this.now())throw this.fault('EXPIRED');
    r.renewAt=sentAt+Math.min(this.renewMs,state.expiresMs/3);r.phase='active';r.error='';
    this.deadline(r,expiresAt);
  }
  deadline(r,expiresAt){
    r.expiresAt=expiresAt;
    clearTimeout(r.expiry);
    r.expiry=setTimeout(()=>{if(this.current(r)){r.desired=false;r.phase='restoring';r.error=this.code('EXPIRED');this.schedule(r,true);}},Math.max(1,expiresAt-this.now()));r.expiry.unref?.();
  }
  async stop(r){
    if(!r.lease)return;
    r.desired=false;r.phase='restoring';clearTimeout(r.expiry);
    const value=await this.request(r.host,r.identity,'stop',r.lease,r.abort.signal);
    if(!this.current(r))return;
    if(value.recovering)throw this.fault('RECOVERY_PENDING');
    if(value.active)throw this.fault('INVALID_RESPONSE');
    r.lease=null;r.intentBinding=null;r.expiresAt=0;r.phase='off';r.state=null;
  }
  failure(r,error){
    if(!this.current(r))return;
    r.desired=false;clearTimeout(r.expiry);
    if(!r.lease)r.intentBinding=null;
    r.error=error.code==='UPDATE_HOST'?this.code('UNSUPPORTED'):error.code?.startsWith(this.prefix+'_')?error.code:this.code('UNAVAILABLE');
    r.phase=r.lease?'restoring':'unavailable';
    if(terminal.has(error.code)){this.viewer.reconcile(error.code);this.reconcile();}
  }
  async poll(r){
    if(!this.current(r)){this.reconcile();return;}if(r.polling)return;
    r.polling=true;
    try{
      if(!r.identity)r.identity=await this.store.identity();
      if(!this.current(r))return;
      if(r.lease&&!r.desired){await this.stop(r);return;}
      const d=await this.request(r.host,r.identity,'displays',null,r.abort.signal);
      if(!this.current(r))return;
      const previous=r.display;
      if(previous&&this.viewIdentity(previous)!==this.viewIdentity(d)){
        r.viewId=crypto.randomBytes(16).toString('hex');
        if(!r.desired&&!r.lease)r.intentBinding=null;
      }
      r.display=d;r.at=this.now();
      if(r.desired){
        const binding=this.binding(r);
        if(r.lease&&this.now()>=r.expiresAt)throw this.fault('EXPIRED');
        if(!r.lease||this.now()>=r.renewAt){
          const op=r.lease?'renew':'start';
          if(!r.lease)r.lease={...binding,lease:crypto.randomBytes(16).toString('hex')};
          const sentAt=this.now(),result=await this.request(r.host,r.identity,op,r.lease,r.abort.signal);
          if(!this.current(r))return;
          if(r.desired)this.confirmed(r,result,sentAt);
        }else{
          const sentAt=this.now(),result=await this.request(r.host,r.identity,'status',null,r.abort.signal);
          if(!this.current(r))return;
          if(!result.active||result.recovering||result.lease!==r.lease.lease)throw this.fault('EXPIRED');
          const expiresAt=Math.min(r.expiresAt,sentAt+result.expiresMs);
          if(expiresAt<=this.now())throw this.fault('EXPIRED');
          this.deadline(r,expiresAt);
        }
      }else if(!r.lease){
        const result=await this.request(r.host,r.identity,'status',null,r.abort.signal);
        if(!this.current(r))return;
        r.state=result;r.stateAt=this.now();
        if(!r.desired){
          r.phase=result.recovering?'restoring':result.active?'unavailable':result.supported?'off':'unavailable';
          r.error=result.recovering?this.code('RECOVERY_PENDING'):result.active?this.code('BUSY'):result.supported?'':this.code('UNSUPPORTED');
        }
      }
    }catch(error){this.failure(r,error);}
    finally{
      if(this.current(r)&&r.lease&&!r.desired){
        try{await this.stop(r);}catch(error){this.failure(r,error);}
      }
      r.polling=false;this.schedule(r,!!(r.desired&&!r.lease));
    }
  }
  snapshot(){
    const r=this.record;if(!r||!this.current(r))return {phase:'idle',canEnable:false,canDisable:false};
    const active=r.phase==='active'&&r.desired&&this.now()<r.expiresAt&&this.fresh(r);
    return {viewId:r.viewId,phase:r.phase==='active'&&!active?'restoring':r.phase,error:r.error,active,
      canEnable:!!(r.phase==='off'&&!r.lease&&!r.desired&&r.state?.supported&&this.restored(r.state)&&this.now()-r.stateAt<4000&&this.available(r)),
      canDisable:!!(r.desired||r.lease),expiresMs:active?Math.max(0,Math.floor(r.expiresAt-this.now())):0};
  }
  setEnabled(data){
    this.reconcile();const r=this.record;
    if(!data||Object.keys(data).sort().join(',')!=='enabled,viewId'||typeof data.enabled!=='boolean')throw this.fault('BAD_REQUEST');
    if(!r||data.viewId!==r.viewId)throw this.fault('STALE');
    const state=this.snapshot();
    if(data.enabled&&!state.canEnable)throw fault(r.error||this.code('NOT_READY'));
    if(!data.enabled&&!state.canDisable)return state;
    r.desired=data.enabled;r.phase=data.enabled?'starting':'restoring';r.error='';
    if(data.enabled)r.intentBinding=this.streamBinding(r.display);
    this.schedule(r,true);return this.snapshot();
  }
  close(){this.closed=true;this.dispose();return Promise.allSettled([...this.cleanups]);}
}
module.exports={ForegroundLeaseController};
