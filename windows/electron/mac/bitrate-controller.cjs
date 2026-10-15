'use strict';
const crypto=require('node:crypto');
const protocol=require('./bitrate-protocol.cjs');
const {fault}=require('./paired-transport.cjs');
const {sameRoute}=require('./routed-store.cjs');
const terminal=new Set(['HOST_CERT_CHANGED','UNPAIRED','RELAY_UNPAIRED','KEYCHAIN_UNAVAILABLE']);
function message(error){return ({BITRATE_INVALID_RESPONSE:'电脑返回的码率状态无效',BITRATE_NOT_READY:'请等远程画面恢复后再调整',BITRATE_NO_EXCLUSIVE_STREAM:'同一配对身份有多个远控连接，暂时无法确定调整目标',BITRATE_UNSUPPORTED:'请更新被控电脑后使用实时码率',VIEWER_UPDATE_REQUIRED:'请更新桌面控制组件后使用实时码率',BITRATE_ENCODER_UNSUPPORTED:'当前编码器不支持实时调整码率',BITRATE_BUSY:'正在确认上一次调整，请稍候',BITRATE_STALE:'连接状态已改变，请重新选择码率',BITRATE_INVALID_VALUE:'请输入 1–100 Mbps 之间的数值'})[error?.code]||'暂时无法读取码率，请检查远程连接';}
class BitrateController{
  constructor({store,viewer,request=protocol.request,now=()=>performance.now(),pollMs=1000,pendingPollMs=150,confirmMs=15000}){
    Object.assign(this,{store,viewer,request,now,pollMs,pendingPollMs,confirmMs});
  }
  current(r){return !this.closed&&this.record===r&&!r.abort.signal.aborted&&this.viewer.currentSession()===r.session&&sameRoute(this.store.selected(),r.host);}
  reconcile(){
    if(this.closed)return;
    const session=this.viewer.currentSession();
    if(this.record?.session===session)return;
    this.dispose();
    if(!session)return;
    const r=this.record={session,host:{...session.host},abort:new AbortController(),viewId:crypto.randomBytes(16).toString('hex'),error:'',result:null};
    if(!session.telemetry){r.error='VIEWER_UPDATE_REQUIRED';return;}
    void this.poll(r);
  }
  dispose(){const r=this.record;this.record=null;if(r){r.abort.abort();clearTimeout(r.timer);clearTimeout(r.deadline);}}
  schedule(r){if(this.current(r)&&r.session.telemetry){clearTimeout(r.timer);r.timer=setTimeout(()=>void this.poll(r),r.pending?this.pendingPollMs:this.pollMs);r.timer.unref?.();}}
  async identity(r){if(!r.identity)r.identity=await this.store.identity();if(!this.current(r))throw fault('CANCELLED');return r.identity;}
  metadata(r,d,b){
    if(!d.supported||!b.supported)throw fault('BITRATE_UNSUPPORTED');
    if(!d.stream||!b.stream)throw fault('BITRATE_NO_EXCLUSIVE_STREAM');
    if(!protocol.matching(d,b))throw fault('BITRATE_NOT_READY');
    const old=r.latest;
    if(old&&(old.b.instance!==b.instance||old.b.stream.id!==b.stream.id)){
      r.viewId=crypto.randomBytes(16).toString('hex');this.finish(r,'unconfirmed');
    }
    if(old&&old.b.instance===b.instance&&old.b.stream.id===b.stream.id&&b.stream.revision<old.b.stream.revision)return;
    r.latest={d,b,at:this.now()};r.error=b.stream.supported?'':'BITRATE_ENCODER_UNSUPPORTED';
    this.confirm(r);
  }
  confirm(r){
    const p=r.pending,latest=r.latest;if(!p||!p.postDone||!latest)return;
    const {d,b}=latest,s=b.stream;
    if(b.instance!==p.instance||s.id!==p.stream){this.finish(r,'unconfirmed');return;}
    if(s.requestId<=p.before)return;
    if(s.requestedKbps!==p.budget||(p.requestId&&s.requestId!==p.requestId)){this.finish(r,'superseded');return;}
    if(s.result==='failed'){this.finish(r,'rejected');return;}
    const progress=this.viewer.snapshot().progress;
    if(s.result==='applied'&&s.budgetKbps===p.budget&&protocol.presented(d,progress)&&progress.rendered>=s.appliedFrame&&progress.rendered>p.frame){
      if(this.viewer.acceptBitrate(r.session,p.budget))this.finish(r,'applied');
      else this.reconcile();
    }
  }
  finish(r,kind){if(!r.pending)return;r.result={kind,budgetKbps:r.pending.budget};r.pending=null;clearTimeout(r.deadline);}
  failure(r,error){
    if(!this.current(r))return;
    if(terminal.has(error.code)){this.viewer.reconcile(error.code);this.reconcile();return;}
    r.error=error.code==='UPDATE_HOST'?'BITRATE_UNSUPPORTED':error.code==='BITRATE_INVALID_RESPONSE'?'BITRATE_INVALID_RESPONSE':error.code?.startsWith('BITRATE_')?error.code:'BITRATE_UNAVAILABLE';
  }
  async poll(r){
    if(!this.current(r)||r.polling)return;
    r.polling=true;
    try{const identity=await this.identity(r);const [d,b]=await Promise.all([this.request(r.host,identity,'displays',null,r.abort.signal),this.request(r.host,identity,'bitrate',null,r.abort.signal)]);
      if(this.current(r))this.metadata(r,d,b);
    }catch(error){this.failure(r,error);}finally{r.polling=false;this.schedule(r);}
  }
  snapshot(){
    const r=this.record;if(!r||!this.current(r))return {phase:'idle',canApply:false};
    this.confirm(r);
    const latest=r.latest,fresh=latest&&this.now()-latest.at<4000,progress=this.viewer.snapshot().progress;
    return {phase:r.pending?'pending':r.error?'unavailable':latest?'ready':'loading',viewId:r.viewId,
      canApply:!!(fresh&&!r.error&&!r.pending&&protocol.presented(latest.d,progress)),error:r.error,
      currentKbps:latest?.b.stream.budgetKbps||0,videoKbps:latest?.b.stream.videoKbps||0,
      requestedKbps:r.pending?.budget||0,result:r.result?{...r.result}:null};
  }
  apply(data){
    this.reconcile();const r=this.record;
    if(!data||Object.keys(data).sort().join(',')!=='budgetKbps,viewId'||!protocol.integer(data.budgetKbps,1000,100000))throw fault('BITRATE_INVALID_VALUE');
    if(!r||data.viewId!==r.viewId)throw fault('BITRATE_STALE');
    if(r.pending)throw fault('BITRATE_BUSY');
    if(!this.snapshot().canApply)throw fault(r.error||'BITRATE_NOT_READY');
    const {b}=r.latest,p=r.pending={instance:b.instance,stream:b.stream.id,before:b.stream.requestId,revision:b.stream.revision,
      budget:data.budgetKbps,frame:this.viewer.snapshot().progress.rendered,postDone:false};
    r.result=null;
    r.deadline=setTimeout(()=>{if(this.current(r)&&r.pending===p)this.finish(r,'unconfirmed');},this.confirmMs);r.deadline.unref?.();
    void this.post(r,p);return this.snapshot();
  }
  async post(r,p){
    try{
      const identity=await this.identity(r);if(r.pending!==p)return;
      const b=await this.request(r.host,identity,'bitrate',{instance:p.instance,stream:p.stream,revision:p.revision,budgetKbps:p.budget},r.abort.signal);
      if(!this.current(r)||r.pending!==p)return;
      p.postDone=true;
      if(!b.accepted){this.finish(r,'rejected');return;}
      if(!b.supported||b.instance!==p.instance||b.stream?.id!==p.stream||b.stream.requestId<=p.before||b.stream.requestedKbps!==p.budget)throw fault('BITRATE_INVALID_RESPONSE');
      p.requestId=b.stream.requestId;this.metadata(r,r.latest.d,b);
    }catch(error){
      if(!this.current(r)||r.pending!==p)return;
      p.postDone=true;
      if(terminal.has(error.code)){this.failure(r,error);return;}
      if(['HTTP_400','HTTP_429','UPDATE_HOST'].includes(error.code))this.finish(r,'rejected');
      // A timeout or lost/malformed response does not prove the write failed.
      // Observe the host and presentation boundary; never resend automatically.
    }finally{if(this.current(r))this.schedule(r);}
  }
  close(){this.closed=true;this.dispose();}
}
module.exports={BitrateController,message};
