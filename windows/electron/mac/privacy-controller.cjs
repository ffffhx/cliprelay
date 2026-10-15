'use strict';
const crypto=require('node:crypto');
const protocol=require('./privacy-protocol.cjs');
const {sameRoute}=require('./routed-store.cjs');
const {fault}=require('./paired-transport.cjs');
const terminal=new Set(['HOST_CERT_CHANGED','UNPAIRED','RELAY_UNPAIRED','KEYCHAIN_UNAVAILABLE']);
function message(error){return ({PRIVACY_STALE:'连接已改变，请重新操作隐私屏',PRIVACY_BAD_REQUEST:'隐私屏操作无效',PRIVACY_NOT_READY:'请等远程画面恢复后再开启隐私屏',PRIVACY_BUSY:'隐私屏正在使用或处理中',PRIVACY_UNSUPPORTED:'当前电脑不支持隐私屏，请检查电脑端版本',PRIVACY_DESKTOP_UNAVAILABLE:'电脑桌面暂时无法开启隐私屏',PRIVACY_NO_EXCLUSIVE_STREAM:'隐私屏需要这台电脑只有一个远控连接',PRIVACY_INVALID_RESPONSE:'电脑返回的隐私屏状态无效',PRIVACY_EXPIRED:'隐私屏已到期，请确认画面后重新开启'})[error?.code]||'隐私屏状态未确认，请检查远程连接';}

// One serialized loop owns a short host lease. A new stream/route never adopts
// an old lease, and no failed start/renew is automatically retried as a start.
class PrivacyController{
  constructor({store,viewer,request=protocol.request,now=()=>performance.now(),pollMs=1000,renewMs=3000}){
    Object.assign(this,{store,viewer,request,now,pollMs,renewMs});this.cleanups=new Set();
  }
  current(r){return !this.closed&&this.record===r&&!r.abort.signal.aborted&&this.viewer.currentSession()===r.session&&sameRoute(this.store.selected(),r.host);}
  reconcile(){
    if(this.closed)return;
    const session=this.viewer.currentSession();
    if(this.record?.session===session&&this.current(this.record))return;
    this.dispose();
    if(!session||!sameRoute(this.store.selected(),session.host))return;
    const r=this.record={session,host:{...session.host},abort:new AbortController(),viewId:crypto.randomBytes(16).toString('hex'),desired:false,phase:'loading',error:''};
    if(!session.telemetry){r.phase='unavailable';r.error='PRIVACY_UNSUPPORTED';return;}
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
      try{const result=await this.request(host,identity,'stop',lease);if(!result.active)return;}
      catch(error){if(terminal.has(error.code))return;}
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,250));
    }
    // The host and worker also expire independently; no client retry renews it.
  }
  schedule(r,immediate=false){
    if(!this.current(r)){this.reconcile();return;}
    clearTimeout(r.timer);r.timer=setTimeout(()=>void this.poll(r),immediate?0:this.pollMs);r.timer.unref?.();
  }
  fresh(r){return r.display&&this.now()-r.at<4000&&protocol.presented(r.display,this.viewer.snapshot().progress);}
  binding(r){
    const d=r.display;
    if(!d?.supported)throw fault('PRIVACY_UNSUPPORTED');
    if(!d.stream)throw fault('PRIVACY_NO_EXCLUSIVE_STREAM');
    if(!this.fresh(r))throw fault('PRIVACY_NOT_READY');
    if(r.intentBinding&&(r.intentBinding.instance!==d.instance||r.intentBinding.stream!==d.stream.id))throw fault('PRIVACY_STALE');
    if(r.lease&&(r.lease.instance!==d.instance||r.lease.stream!==d.stream.id))throw fault('PRIVACY_STALE');
    return {instance:d.instance,stream:d.stream.id};
  }
  confirmed(r,state,sentAt){
    if(!state.active||state.lease!==r.lease?.lease)throw fault('PRIVACY_EXPIRED');
    const expiresAt=sentAt+state.expiresMs;
    if(expiresAt<=this.now())throw fault('PRIVACY_EXPIRED');
    r.renewAt=sentAt+Math.min(this.renewMs,state.expiresMs/3);r.phase='active';r.error='';
    this.deadline(r,expiresAt);
  }
  deadline(r,expiresAt){
    r.expiresAt=expiresAt;
    clearTimeout(r.expiry);
    r.expiry=setTimeout(()=>{if(this.current(r)){r.desired=false;r.phase='restoring';r.error='PRIVACY_EXPIRED';this.schedule(r,true);}},Math.max(1,expiresAt-this.now()));r.expiry.unref?.();
  }
  async stop(r){
    if(!r.lease)return;
    r.desired=false;r.phase='restoring';clearTimeout(r.expiry);
    const value=await this.request(r.host,r.identity,'stop',r.lease,r.abort.signal);
    if(!this.current(r))return;
    if(value.active)throw fault('PRIVACY_INVALID_RESPONSE');
    r.lease=null;r.expiresAt=0;r.phase='off';r.state=null;
  }
  failure(r,error){
    if(!this.current(r))return;
    r.desired=false;clearTimeout(r.expiry);
    r.error=error.code==='UPDATE_HOST'?'PRIVACY_UNSUPPORTED':error.code?.startsWith('PRIVACY_')?error.code:'PRIVACY_UNAVAILABLE';
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
      if(previous&&(previous.instance!==d.instance||previous.stream?.id!==d.stream?.id))r.viewId=crypto.randomBytes(16).toString('hex');
      r.display=d;r.at=this.now();
      if(r.desired){
        const binding=this.binding(r);
        if(r.lease&&this.now()>=r.expiresAt)throw fault('PRIVACY_EXPIRED');
        if(!r.lease||this.now()>=r.renewAt){
          const op=r.lease?'renew':'start';
          if(!r.lease)r.lease={...binding,lease:crypto.randomBytes(16).toString('hex')};
          const sentAt=this.now(),result=await this.request(r.host,r.identity,op,r.lease,r.abort.signal);
          if(!this.current(r))return;
          if(r.desired)this.confirmed(r,result,sentAt);
        }else{
          const sentAt=this.now(),result=await this.request(r.host,r.identity,'status',null,r.abort.signal);
          if(!this.current(r))return;
          if(!result.active||result.lease!==r.lease.lease)throw fault('PRIVACY_EXPIRED');
          const expiresAt=Math.min(r.expiresAt,sentAt+result.expiresMs);
          if(expiresAt<=this.now())throw fault('PRIVACY_EXPIRED');
          this.deadline(r,expiresAt);
        }
      }else if(!r.lease){
        const result=await this.request(r.host,r.identity,'status',null,r.abort.signal);
        if(!this.current(r))return;
        r.state=result;r.stateAt=this.now();
        if(!r.desired){r.phase=result.active?'unavailable':result.supported?'off':'unavailable';r.error=result.active?'PRIVACY_BUSY':result.supported?'':'PRIVACY_UNSUPPORTED';}
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
      canEnable:!!(r.phase==='off'&&!r.lease&&!r.desired&&r.state?.supported&&!r.state.active&&this.now()-r.stateAt<4000&&this.fresh(r)&&r.display.stream),
      canDisable:!!(r.desired||r.lease),expiresMs:active?Math.max(0,Math.floor(r.expiresAt-this.now())):0};
  }
  setEnabled(data){
    this.reconcile();const r=this.record;
    if(!data||Object.keys(data).sort().join(',')!=='enabled,viewId'||typeof data.enabled!=='boolean')throw fault('PRIVACY_BAD_REQUEST');
    if(!r||data.viewId!==r.viewId)throw fault('PRIVACY_STALE');
    const state=this.snapshot();
    if(data.enabled&&!state.canEnable)throw fault(r.error||'PRIVACY_NOT_READY');
    if(!data.enabled&&!state.canDisable)return state;
    r.desired=data.enabled;r.phase=data.enabled?'starting':'restoring';r.error='';
    if(data.enabled)r.intentBinding={instance:r.display.instance,stream:r.display.stream.id};
    this.schedule(r,true);return this.snapshot();
  }
  close(){this.closed=true;this.dispose();return Promise.allSettled([...this.cleanups]);}
}
module.exports={PrivacyController,message};
