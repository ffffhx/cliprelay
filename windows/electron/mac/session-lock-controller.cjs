'use strict';
const crypto=require('node:crypto');
const protocol=require('./session-lock-protocol.cjs');
const {fault}=require('./paired-transport.cjs');
const {sameRoute}=require('./routed-store.cjs');
const terminal=new Set(['HOST_CERT_CHANGED','UNPAIRED','RELAY_UNPAIRED','KEYCHAIN_UNAVAILABLE']);
const finalStates=new Set(['locked','failed','cancelled']);
function message(error){return ({LOCK_STALE:'会话已改变，请重新设置结束锁屏',LOCK_BAD_REQUEST:'结束锁屏操作无效',LOCK_NOT_READY:'请等远程画面恢复后再设置结束锁屏',LOCK_UPDATE_REQUIRED:'请更新被控电脑后设置结束锁屏',LOCK_UNSUPPORTED:'当前电脑不支持结束锁屏',LOCK_NO_EXCLUSIVE_STREAM:'结束锁屏需要这台电脑只有一个远控连接',LOCK_BUSY:'电脑已有锁屏安排或正在处理请求',LOCK_CANCEL_PENDING:'取消尚未确认，电脑仍可能按原安排锁屏',LOCK_ALREADY_REQUESTED:'电脑已提交锁屏请求，无法再取消，请等待执行结果',LOCK_INVALID_RESPONSE:'电脑返回的锁屏状态无效'})[error?.code]||'锁屏安排状态未确认，请检查连接';}

// Confirmed end-of-stream intent belongs to the host. Closing the panel/app or
// ending the native viewer must not disarm it. Only uncertain arm/cancel writes
// receive best-effort cancellation cleanup; this controller never sends commit.
class SessionLockController{
  constructor({store,viewer,request=protocol.request,now=()=>performance.now(),pollMs=1000}){
    Object.assign(this,{store,viewer,request,now,pollMs});this.cleanups=new Set();
  }
  live(r){return this.viewer.currentSession()===r.session;}
  current(r){const live=this.viewer.currentSession();return !this.closed&&this.record===r&&!r.abort.signal.aborted&&(!live||live===r.session)&&sameRoute(this.store.selected(),r.host);}
  reconcile(){
    if(this.closed)return;
    const live=this.viewer.currentSession();
    if(this.record&&this.current(this.record))return;
    this.dispose();
    if(!live||!sameRoute(this.store.selected(),live.host))return;
    const r=this.record={session:live,host:{...live.host},viewId:crypto.randomBytes(16).toString('hex'),abort:new AbortController(),phase:'loading',error:'',confirmed:false};
    if(!live.telemetry){r.phase='unavailable';r.error='LOCK_NOT_READY';return;}
    void this.poll(r);
  }
  dispose(){
    const r=this.record;this.record=null;if(!r)return;
    r.abort.abort();clearTimeout(r.timer);
    if(r.identity&&r.binding&&(r.cancelWanted||(r.armSent&&!r.confirmed))){
      const cleanup=this.cleanup(r.host,r.identity,r.binding).finally(()=>this.cleanups.delete(cleanup));this.cleanups.add(cleanup);
    }
  }
  async cleanup(host,identity,binding){
    const deadline=performance.now()+20000;
    for(let attempt=0;attempt<40&&performance.now()<deadline;attempt++){
      try{const state=await this.request(host,identity,'disarm',binding);if(state.state==='off')return;}
      catch(error){if(terminal.has(error.code)||error.code==='LOCK_ALREADY_REQUESTED')return;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  schedule(r,immediate=false){
    if(!this.current(r)){this.reconcile();return;}
    clearTimeout(r.timer);r.timer=setTimeout(()=>void this.poll(r),immediate?0:this.pollMs);r.timer.unref?.();
  }
  fresh(r){return this.live(r)&&r.display&&this.now()-r.displayAt<4000&&protocol.presented(r.display,this.viewer.snapshot().progress);}
  matchesDisplay(r,binding){return this.fresh(r)&&r.display.instance===binding.instance&&r.display.stream?.id===binding.stream;}
  observe(r,state,sentAt){
    r.state=state;r.stateAt=this.now();r.expiresAt=sentAt+state.expiresMs;
    if(r.armWanted||r.cancelWanted)return;
    r.error='';
    r.alreadyRequested=state.state==='requested';
    if(state.state==='off'){
      r.binding=null;r.confirmed=false;r.armSent=false;r.phase='off';
    }else{
      if(!protocol.same(state,r.binding)&&this.matchesDisplay(r,{instance:state.instance,stream:state.stream})){
        r.binding={instance:state.instance,stream:state.stream,lease:state.lease};
      }
      if(protocol.same(state,r.binding)){
        r.confirmed=true;r.phase=state.state;
      }else if(finalStates.has(state.state)){
        r.binding=null;r.confirmed=false;r.phase=state.state;
      }else{r.phase='unavailable';r.error='LOCK_BUSY';}
    }
    if(!state.cancelProtected)r.error='LOCK_UPDATE_REQUIRED';
    else if(!state.supported)r.error='LOCK_UNSUPPORTED';
  }
  async disarm(r){
    const state=await this.request(r.host,r.identity,'disarm',r.binding,r.abort.signal);
    if(!this.current(r))return;
    if(state.state!=='off'||!state.cancelProtected)throw fault('LOCK_INVALID_RESPONSE');
    r.cancelWanted=false;r.armWanted=false;r.armSent=false;r.confirmed=false;r.binding=null;
    this.observe(r,state,this.now());
  }
  failure(r,error){
    if(!this.current(r))return;
    if(terminal.has(error.code)){this.viewer.reconcile(error.code);this.dispose();this.reconcile();return;}
    r.error=error.code==='UPDATE_HOST'?'LOCK_UPDATE_REQUIRED':error.code?.startsWith('LOCK_')?error.code:'LOCK_UNAVAILABLE';
    if(r.cancelWanted&&error.code==='LOCK_ALREADY_REQUESTED'){
      r.cancelWanted=false;r.armWanted=false;r.confirmed=true;r.phase='requested';r.alreadyRequested=true;return;
    }
    if(r.armWanted){
      r.armWanted=false;
      if(r.armSent){r.cancelWanted=true;r.phase='cancelling';}
      else{r.binding=null;r.phase='unavailable';}
    }else r.phase=r.cancelWanted?'cancelling':'unconfirmed';
  }
  async poll(r){
    if(!this.current(r)){this.reconcile();return;}if(r.polling)return;
    r.polling=true;
    try{
      if(!r.identity)r.identity=await this.store.identity();
      if(!this.current(r))return;
      if(r.cancelWanted&&r.binding){await this.disarm(r);return;}
      if(this.live(r)){
        const d=await this.request(r.host,r.identity,'displays',null,r.abort.signal);
        if(!this.current(r))return;
        if(r.display&&(r.display.instance!==d.instance||r.display.stream?.id!==d.stream?.id))r.viewId=crypto.randomBytes(16).toString('hex');
        r.display=d;r.displayAt=this.now();
      }
      const sentAt=this.now(),state=await this.request(r.host,r.identity,'status',null,r.abort.signal);
      if(!this.current(r))return;
      this.observe(r,state,sentAt);
      if(r.cancelWanted)return;
      if(r.armWanted){
        if(!state.cancelProtected)throw fault('LOCK_UPDATE_REQUIRED');
        if(!state.supported)throw fault('LOCK_UNSUPPORTED');
        if(!this.matchesDisplay(r,r.binding))throw fault('LOCK_STALE');
        if(state.state!=='off'&&!finalStates.has(state.state))throw fault('LOCK_BUSY');
        r.armSent=true;const started=this.now();
        const result=await this.request(r.host,r.identity,'arm',r.binding,r.abort.signal);
        if(!this.current(r))return;
        if(!result.cancelProtected||result.state!=='armed'||!protocol.same(result,r.binding)||started+result.expiresMs<=this.now())throw fault('LOCK_INVALID_RESPONSE');
        if(!r.cancelWanted){r.armWanted=false;r.confirmed=true;this.observe(r,result,started);}
      }
    }catch(error){this.failure(r,error);}
    finally{r.polling=false;this.schedule(r,!!(r.cancelWanted&&r.phase!=='cancelling')||!!(r.armWanted&&!r.armSent));}
  }
  snapshot(){
    const r=this.record;if(!r||!this.current(r))return {phase:'idle',canArm:false,canDisarm:false};
    const state=r.state,fresh=state&&this.now()-r.stateAt<4000;
    const armed=r.phase==='armed'&&r.confirmed&&fresh&&this.now()<r.expiresAt&&!r.error;
    return {viewId:r.viewId,phase:r.phase==='armed'&&!armed?'unconfirmed':r.phase,error:r.error,armed,sessionRunning:this.live(r),
      canArm:!!(fresh&&state.cancelProtected&&state.supported&&!r.error&&!r.armWanted&&!r.cancelWanted&&!r.alreadyRequested&&
        (state.state==='off'||finalStates.has(state.state))&&this.fresh(r)&&r.display.stream),
      canDisarm:!!(r.binding&&state?.cancelProtected&&!r.cancelWanted&&!r.alreadyRequested&&!['requested','locked','failed','cancelled'].includes(r.phase)&&
        (r.confirmed||r.armWanted||r.armSent))};
  }
  setEnabled(data){
    this.reconcile();const r=this.record;
    if(!data||Object.keys(data).sort().join(',')!=='enabled,viewId'||typeof data.enabled!=='boolean')throw fault('LOCK_BAD_REQUEST');
    if(!r||data.viewId!==r.viewId)throw fault('LOCK_STALE');
    const state=this.snapshot();
    if(data.enabled){
      if(!state.canArm)throw fault(r.error||'LOCK_NOT_READY');
      r.binding={instance:r.display.instance,stream:r.display.stream.id,lease:crypto.randomBytes(16).toString('hex')};
      r.confirmed=false;r.armSent=false;r.armWanted=true;r.phase='arming';
    }else{
      if(!state.canDisarm)throw fault(r.alreadyRequested?'LOCK_ALREADY_REQUESTED':r.error||'LOCK_NOT_READY');
      r.cancelWanted=true;r.phase='cancelling';
    }
    r.error='';this.schedule(r,true);return this.snapshot();
  }
  close(){this.closed=true;this.dispose();return Promise.allSettled([...this.cleanups]);}
}
module.exports={SessionLockController,message};
