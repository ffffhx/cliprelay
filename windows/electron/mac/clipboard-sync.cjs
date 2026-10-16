'use strict';
const crypto=require('node:crypto');
const {sameRoute}=require('./routed-store.cjs');
const {fault}=require('./paired-transport.cjs');
const {validateText}=require('./paired-relay.cjs');
const {pngSize}=require('./clipboard-access.cjs');
const protocol=require('./clipboard-protocol.cjs');
function fingerprint(value,nativeImage){
  const hash=crypto.createHash('sha256');
  if(value.kind==='empty' || (value.kind==='text' && value.text===''))return hash.update('empty').digest('hex');
  if(value.kind==='text')return hash.update('text\0').update(validateText(value.text)).digest('hex');
  if(value.kind!=='png')throw fault('INVALID_CLIPBOARD');
  const expected=pngSize(value.bytes),image=nativeImage.createFromBuffer(value.bytes),size=image.getSize();
  if(image.isEmpty() || size.width!==expected.width || size.height!==expected.height)throw fault('INVALID_IMAGE');
  const pixels=image.toBitmap({scaleFactor:1});if(pixels.length!==size.width*size.height*4)throw fault('INVALID_IMAGE');
  // Compare decoded pixels: AppKit may re-encode identical PNG content.
  return hash.update(`png:${size.width}:${size.height}:`).update(pixels).digest('hex');
}
const empty=value=>value.kind==='empty' || (value.kind==='text' && !value.text);
function message(error){return ({
  CLIPBOARD_CONFLICT:'两端剪贴板同时变化，自动同步已暂停。可手动发送或取回所需内容，再继续同步。',
  CLIPBOARD_LOCAL_CHANGED:'本机剪贴板已变化，未覆盖新内容。请重新取回或继续同步。',
  CLIPBOARD_WRITE_UNCERTAIN:'无法确认本次写入结果，自动同步已暂停。检查两端内容后可继续同步。',
  CLIPBOARD_SYNC_UNSUPPORTED:'请更新被控电脑的 ClipRelay 后使用自动同步。',
  CLIPBOARD_LOCKED:'被控电脑已锁定，解锁后可继续同步。',
  CLIPBOARD_PERMISSION_REQUIRED:'请在被控电脑允许剪贴板访问，然后继续同步。',
  CLIPBOARD_EMPTY:'电脑剪贴板没有可取回的文字或图片。',
  CLIPBOARD_TOO_LARGE:'剪贴板内容过大：文字最多 1 MiB，PNG 最多 8 MiB、600 万像素。',
  IMAGE_TOO_LARGE:'图片过大：PNG 最多 8 MiB、600 万像素，单边最多 4096。',
  CLIPBOARD_VIEW_CHANGED:'电脑或远控会话已改变，请重新操作。',
  CANCELLED:'操作已取消。',UNPAIRED:'电脑已撤销配对，请重新配对。',HOST_CERT_CHANGED:'电脑身份改变，请核实后重新配对。'
})[error?.code] || '剪贴板同步暂不可用，请检查连接后继续同步。';}
class ClipboardSync{
  constructor({store,viewer,paired,nativeImage,powerMonitor,request=protocol.request,pollMs=1000}){
    Object.assign(this,{store,viewer,paired,nativeImage,powerMonitor,request,pollMs});this.pauses=new Set();this.listeners=[];
    for(const [event,reason,paused] of [['suspend','suspend',true],['resume','suspend',false],['lock-screen','lock',true],['unlock-screen','lock',false],['user-did-resign-active','session',true],['user-did-become-active','session',false]]){
      const listener=()=>{paused?this.pauses.add(reason):this.pauses.delete(reason);this.reconcile();};
      powerMonitor?.on(event,listener);this.listeners.push([event,listener]);
    }
  }
  systemPaused(){if(this.pauses.size)return true;try{return this.powerMonitor?.getSystemIdleState(1)==='locked';}catch{return true;}}
  ready(){
    const s=this.viewer.currentSession(),p=this.viewer.snapshot().progress;
    return !!s && s===this.session && sameRoute(this.host,s.host) && !this.viewer.inputPaused(s) &&
      s.telemetry===true && p?.rendered>0 && p?.received>0 && p.renderedAgeMs<5000 && p.receivedAgeMs<5000;
  }
  current(r){return !this.closed && this.record===r && !r.abort.signal.aborted && !this.manual &&
    !this.systemPaused() && this.store.selected()?.clipboardSync===true && sameRoute(this.store.selected(),r.host) &&
    this.viewer.currentSession()===r.session && this.ready();}
  reconcile(){
    if(this.closed)return;
    if(this.systemPaused())this.manual?.abort.abort();
    const host=this.store.selected(),session=this.viewer.currentSession();
    if(!((!host&&!this.host)||sameRoute(host,this.host)) || session!==this.session){
      this.dispose();this.manual?.abort.abort();this.host=host?{...host}:null;this.session=session;
      this.viewId=host?crypto.randomBytes(16).toString('hex'):'';this.hold=null;this.manualError='';
    }
    if(!host?.enabled || host.routeReady===false || host.clipboardSync!==true || this.store.data.legacySelected ||
      this.manual || this.hold || this.systemPaused() || !this.ready()){this.dispose();return;}
    if(this.record)return;
    const r=this.record={host:{...host},session,abort:new AbortController(),generation:0,phase:'starting',failures:0};
    r.task=this.poll(r);
  }
  dispose(){const r=this.record;this.record=null;if(r){r.abort.abort();clearTimeout(r.timer);}}
  externalApplied(){const r=this.record;if(r){r.generation++;r.baseline=null;r.phase='starting';}}
  schedule(r){if(!this.current(r)){this.reconcile();return;}clearTimeout(r.timer);r.timer=setTimeout(()=>{r.task=this.poll(r);},this.pollMs);r.timer.unref?.();}
  pause(r,code){if(!this.current(r))return;this.hold={phase:code==='CLIPBOARD_CONFLICT'?'conflict':'paused',error:code};this.dispose();}
  async local(active){return this.paired.withClipboard(async()=>{if(!active())throw fault('CANCELLED');const value=await this.paired.clipboard.readPayload(active);if(!active())throw fault('CANCELLED');return {value,hash:fingerprint(value,this.nativeImage)};});}
  async apply(value,expected,active){
    return this.paired.withClipboard(async()=>{
      if(!active())throw fault('CANCELLED');
      const current=await this.paired.clipboard.readPayload(active);
      if(!active())throw fault('CANCELLED');
      if(fingerprint(current,this.nativeImage)!==expected)throw fault('CLIPBOARD_LOCAL_CHANGED');
      await this.paired.clipboard.writePayload(value,active);
      const actual=await this.paired.clipboard.readPayload(active);
      if(!active())throw fault('CANCELLED');
      const hash=fingerprint(actual,this.nativeImage);
      if(hash!==fingerprint(value,this.nativeImage))throw fault('CLIPBOARD_LOCAL_CHANGED');
      return hash;
    });
  }
  async poll(r){
    if(!this.current(r)){this.reconcile();return;}if(r.polling)return;r.polling=true;
    const generation=r.generation,active=()=>this.current(r)&&generation===r.generation;
    let writing=false;
    try{
      r.identity ||= await this.store.identity();if(!active())return;
      const local=await this.local(active);if(!active())return;
      let observed;
      try{observed=await this.request(r.host,r.identity,{op:'observe',...(r.baseline?{revision:r.baseline.revision}:{})},r.abort.signal);}
      catch(error){if(error.code==='CLIPBOARD_CHANGED')return;throw error;}
      if(!active())return;
      if(!observed.changed && !r.baseline)throw fault('BAD_REPLY');
      const remote=observed.changed?fingerprint(observed.payload,this.nativeImage):r.baseline.remote;
      const next={local:local.hash,remote,revision:observed.revision};r.failures=0;
      if(!r.baseline || local.hash===remote){r.baseline=next;r.phase='active';return;}
      const localChanged=local.hash!==r.baseline.local,remoteChanged=remote!==r.baseline.remote;
      if(localChanged && remoteChanged){this.pause(r,'CLIPBOARD_CONFLICT');return;}
      if(localChanged && !empty(local.value)){
        const latest=await this.local(active);if(!active())return;if(latest.hash!==local.hash)return;
        const value=local.value;
        writing=true;
        await this.request(r.host,r.identity,{op:'write',id:crypto.randomBytes(16).toString('hex'),expect:observed.revision,kind:value.kind,
          ...(value.kind==='text'?{text:value.text}:{data:value.bytes.toString('base64')})},r.abort.signal);
        if(!active())return;
        next.remote=local.hash;
      }else if(remoteChanged && !empty(observed.payload)){
        next.local=await this.apply(observed.payload,local.hash,active);if(!active())return;
      }
      r.baseline=next;r.phase='active';
    }catch(error){
      if(!active())return;
      if(error.code==='CLIPBOARD_LOCAL_CHANGED' || error.code==='CLIPBOARD_CHANGED'){this.pause(r,'CLIPBOARD_CONFLICT');return;}
      if(writing){this.pause(r,'CLIPBOARD_WRITE_UNCERTAIN');return;}
      if(['CLIPBOARD_BUSY','CLIPBOARD_UNAVAILABLE','TIMEOUT','ECONNRESET','ECONNREFUSED'].includes(error.code) && ++r.failures<3)return;
      this.pause(r,error.code || 'CLIPBOARD_UNAVAILABLE');
      if(['UNPAIRED','HOST_CERT_CHANGED'].includes(error.code))this.viewer.reconcile(error.code);
    }finally{r.polling=false;if(this.record===r)this.schedule(r);}
  }
  check(data){this.reconcile();if(!data || typeof data.viewId!=='string' || !this.viewId || data.viewId!==this.viewId || !this.host)throw fault('CLIPBOARD_VIEW_CHANGED');}
  setEnabled(data){
    this.check(data);if(typeof data.enabled!=='boolean')throw fault('INVALID_CLIPBOARD');
    this.store.setClipboardSync(this.host.id,data.enabled);this.dispose();this.hold=null;this.manualError='';this.reconcile();
  }
  resume(data){this.check(data);if(!this.hold || !this.store.selected()?.clipboardSync)throw fault('CLIPBOARD_VIEW_CHANGED');this.hold=null;this.manualError='';this.reconcile();}
  cancelReceive(){this.manual?.abort.abort();}
  async receive(data,authorized=()=>true){
    this.check(data);if(this.manual || !this.host.enabled || this.host.routeReady===false || this.systemPaused())throw fault('CLIPBOARD_UNAVAILABLE');
    this.dispose();const m=this.manual={host:{...this.host},session:this.session,viewId:this.viewId,abort:new AbortController()};this.manualError='';
    const active=()=>authorized() && !this.closed && this.manual===m && !m.abort.signal.aborted && m.viewId===this.viewId && !this.systemPaused() &&
      sameRoute(this.store.selected(),m.host) && this.viewer.currentSession()===m.session;
    try{
      const identity=await this.store.identity();if(!active())throw fault('CANCELLED');
      const local=await this.local(active);if(!active())throw fault('CANCELLED');
      const value=await this.request(m.host,identity,{op:'read'},m.abort.signal);if(!active())throw fault('CANCELLED');
      if(empty(value))throw fault('CLIPBOARD_EMPTY');
      await this.apply(value,local.hash,active);if(!active())throw fault('CANCELLED');this.hold=null;
    }catch(error){if(active())this.manualError=error.code || 'CLIPBOARD_UNAVAILABLE';throw error;}
    finally{if(this.manual===m){this.manual=null;this.reconcile();}}
  }
  snapshot(){
    const host=this.store.selected(),enabled=host?.clipboardSync===true;
    const phase=this.manual?'receiving':!enabled?'off':this.hold?.phase || this.record?.phase || 'waiting';
    const error=this.manualError || this.hold?.error || '';
    return {viewId:this.viewId || '',enabled,phase,error,message:error?message({code:error}):'',canConfigure:!!host,
      canResume:!!this.hold && enabled && this.ready() && !this.systemPaused() && !this.manual,
      canReceive:!!host?.enabled && host.routeReady!==false && !this.manual && !this.systemPaused()};
  }
  close(){this.closed=true;this.dispose();this.manual?.abort.abort();for(const [event,listener] of this.listeners)this.powerMonitor?.removeListener(event,listener);this.listeners=[];}
}
module.exports={ClipboardSync,fingerprint,message};
