'use strict';
const crypto=require('node:crypto');
const protocol=require('./display-protocol.cjs');
const presentation=require('./bitrate-protocol.cjs');
const {fault}=require('./paired-transport.cjs');
const {sameRoute}=require('./routed-store.cjs');
const terminal=new Set(['HOST_CERT_CHANGED','UNPAIRED','RELAY_UNPAIRED','KEYCHAIN_UNAVAILABLE']);
const uncertain=new Set(['TIMEOUT','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','BAD_REPLY','DISPLAY_INVALID_RESPONSE','HTTP_503']);
function message(error){return ({DISPLAY_STALE:'连接或显示器列表已改变，请重新选择',DISPLAY_BUSY:'正在切换显示器，请稍候',DISPLAY_NOT_READY:'请等远程画面和输入恢复后再切换',DISPLAY_UNSUPPORTED:'请更新两端组件后使用显示器切换',DISPLAY_INVALID_VALUE:'请选择列表中的显示器',DISPLAY_INVALID_RESPONSE:'电脑返回的显示器状态无效'})[error?.code]||'暂时无法切换显示器，请检查远程连接';}
class DisplayController{
  constructor({store,viewer,request=protocol.request,now=()=>performance.now(),pollMs=1000,pendingPollMs=100,timeoutMs=20000}){
    Object.assign(this,{store,viewer,request,now,pollMs,pendingPollMs,timeoutMs});
  }
  current(r){return !this.closed&&this.record===r&&!r.abort.signal.aborted&&this.viewer.currentSession()===r.session&&sameRoute(this.store.selected(),r.host);}
  check(r){if(!this.current(r))throw fault('CANCELLED');}
  reconcile(){
    if(this.closed)return;const session=this.viewer.currentSession();
    if(this.record?.session===session)return;
    this.dispose();if(!session)return;
    const r=this.record={session,host:{...session.host},viewId:crypto.randomBytes(16).toString('hex'),abort:new AbortController(),error:'',result:null};
    if(!session.telemetry||!session.input){r.error='DISPLAY_UNSUPPORTED';return;}
    void this.poll(r);
  }
  dispose(){const r=this.record;this.record=null;if(r){r.abort.abort();clearTimeout(r.timer);clearTimeout(r.deadline);r.identity=null;}}
  schedule(r){if(this.current(r)&&!r.pending&&r.session.input){clearTimeout(r.timer);r.timer=setTimeout(()=>void this.poll(r),this.pollMs);r.timer.unref?.();}}
  async identity(r){if(!r.identity)r.identity=await this.store.identity();this.check(r);return r.identity;}
  binding(r,d){
    if(!d.supported||!d.inputEpochSelection)throw fault('DISPLAY_UNSUPPORTED');
    if(d.shared||!d.stream||d.instance!==r.session.input.instance||d.stream.id!==r.session.input.stream)throw fault('DISPLAY_STALE');
  }
  async read(r,body=null){const identity=await this.identity(r);const d=await this.request(r.host,identity,body,r.abort.signal);this.check(r);return d;}
  async poll(r){
    if(!this.current(r)||r.pending||r.polling)return;r.polling=true;
    try{const d=await this.read(r);if(r.pending)return;this.binding(r,d);r.latest={d,at:this.now()};r.error='';}
    catch(error){if(this.current(r)&&!r.pending){if(terminal.has(error.code)){this.viewer.reconcile(error.code);this.reconcile();}else r.error=error.code==='UPDATE_HOST'?'DISPLAY_UNSUPPORTED':error.code||'DISPLAY_UNAVAILABLE';}}
    finally{r.polling=false;this.schedule(r);}
  }
  snapshot(){
    const r=this.record;if(!r||!this.current(r))return {phase:'idle',canSelect:false,displays:[]};
    const d=r.latest?.d,fresh=r.latest&&this.now()-r.latest.at<4000;
    return {phase:r.pending?'switching':r.error?'unavailable':d?'ready':'loading',viewId:r.viewId,error:r.error,
      canSelect:!!(fresh&&!r.pending&&!r.error&&r.session.input?.phase==='active'&&presentation.presented(d,this.viewer.snapshot().progress)),
      displays:d?[...d.displays]:[],capture:d?.capture||'',requested:r.pending?.display||'',result:r.result?{...r.result}:null};
  }
  apply(data){
    this.reconcile();const r=this.record;
    if(!data||Object.keys(data).sort().join(',')!=='display,viewId'||!protocol.id(data.display))throw fault('DISPLAY_INVALID_VALUE');
    if(!r||data.viewId!==r.viewId)throw fault('DISPLAY_STALE');
    if(r.pending)throw fault('DISPLAY_BUSY');
    if(!this.snapshot().canSelect)throw fault(r.error||'DISPLAY_NOT_READY');
    if(!r.latest.d.displays.includes(data.display))throw fault('DISPLAY_INVALID_VALUE');
    const p=r.pending={display:data.display,before:r.latest.d};r.result=null;clearTimeout(r.timer);
    r.deadline=setTimeout(()=>this.fail(r,'DISPLAY_TIMEOUT'),this.timeoutMs);r.deadline.unref?.();
    void this.switch(r,p);return this.snapshot();
  }
  fail(r,code){
    if(!this.current(r))return;
    // An uncertain selection must never reopen input against an unknown capture.
    r.session.input?.close(code);this.viewer.finish(code);this.reconcile();
  }
  async delay(r){
    this.check(r);await new Promise((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);r.abort.signal.removeEventListener('abort',abort);reject(fault('CANCELLED'));};
      const timer=setTimeout(()=>{r.abort.signal.removeEventListener('abort',abort);resolve();},this.pendingPollMs);
      r.abort.signal.addEventListener('abort',abort,{once:true});
    });this.check(r);
  }
  async switch(r,p){
    try{
      const input=r.session.input,bound=await input.pause();this.check(r);
      const before=await this.read(r);this.binding(r,before);
      if(before.instance!==p.before.instance||before.generation!==p.before.generation||before.capture!==p.before.capture||before.revision!==p.before.revision||
        before.requestId!==p.before.requestId||before.phase!=='active'||!before.displays.includes(p.display)||before.requestId===Number.MAX_SAFE_INTEGER)throw fault('DISPLAY_STALE');
      const frame=this.viewer.snapshot().progress?.rendered||0;
      let accepted;
      try{accepted=await this.read(r,{instance:bound.instance,stream:bound.stream,inputEpoch:bound.epoch,revision:before.revision,display:p.display});}
      catch(error){if(!uncertain.has(error.code))throw error;}
      this.check(r);
      if(accepted&&!accepted.accepted)throw fault('DISPLAY_REJECTED');
      const matches=d=>d.requestId===before.requestId+1&&d.requested===p.display&&d.requestStream===bound.stream&&d.inputEpoch===bound.epoch;
      if(accepted&&!matches(accepted))throw fault('DISPLAY_INVALID_RESPONSE');
      for(;;){
        let d;try{d=await this.read(r);}catch(error){if(!uncertain.has(error.code)&&error.code!=='HTTP_429')throw error;await this.delay(r);continue;}
        this.binding(r,d);
        if(input.phase!=='paused'||input.epoch!==bound.epoch)throw fault('DISPLAY_STALE');
        if(d.requestId>before.requestId){
          if(!matches(d))throw fault('DISPLAY_STALE');
          if(d.result==='failed')throw fault('DISPLAY_REJECTED');
          if(d.result==='applied'){
            if(d.generation<=before.generation||d.capture!==p.display||d.stream.generation!==d.generation||d.stream.firstFrame<=before.stream.firstFrame)throw fault('DISPLAY_INVALID_RESPONSE');
            await input.resume({generation:d.generation,capture:d.capture,firstFrame:d.stream.firstFrame,afterFrame:frame,width:d.stream.width,height:d.stream.height});this.check(r);
            r.latest={d,at:this.now()};r.pending=null;r.result={kind:'applied',display:p.display};r.error='';clearTimeout(r.deadline);this.schedule(r);return;
          }
        }else if(d.requestId<before.requestId)throw fault('DISPLAY_STALE');
        await this.delay(r);
      }
    }catch(error){if(this.current(r))this.fail(r,error.code||'DISPLAY_UNAVAILABLE');}
  }
  close(){this.closed=true;this.dispose();}
}
module.exports={DisplayController,message};
