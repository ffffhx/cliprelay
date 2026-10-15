'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {endpoint,fault}=require('./paired-transport.cjs');
const {validateIdentity}=require('./paired-store.cjs');
const {sameRoute}=require('./routed-store.cjs');

function envelope(host,identity,options={},telemetry=false){
  validateIdentity(identity);
  const target=endpoint(host.address,host.port);
  if(target.port>65514 || target.address.includes('%'))throw fault('INVALID_STREAM_TARGET');
  const certificate=new crypto.X509Certificate(host.certificate);
  if(crypto.createHash('sha256').update(certificate.raw).digest('hex')!==host.id || !/^[a-f0-9]{32}$/.test(host.clientId))throw fault('INVALID_STREAM_TARGET');
  if(!options || typeof options!=='object' || Array.isArray(options) || Object.keys(options).some(k=>!['width','height','fps','bitrate','fullscreen'].includes(k)))throw fault('INVALID_STREAM_OPTIONS');
  const value={version:1,...target,clientId:host.clientId,certificate:identity.cert,privateKey:identity.key,hostCertificate:host.certificate,width:1920,height:1080,fps:60,bitrate:12000,fullscreen:false,...options};
  if(telemetry===true)value.telemetry=true;
  if(host.overlay!==undefined && typeof host.overlay!=='boolean')throw fault('INVALID_STREAM_TARGET');
  if(host.overlay){
    const remote=host.overlayPort ?? 48789;
    if(target.address!=='127.0.0.1' || target.port<1029 || !Number.isInteger(remote) || remote<1029 || remote>65514)throw fault('INVALID_STREAM_TARGET');
    value.overlay=true;value.overlayPort=remote;
  }else if(host.overlayPort!==undefined)throw fault('INVALID_STREAM_TARGET');
  for(const [key,low,high] of [['width',320,7680],['height',240,4320],['fps',15,120],['bitrate',1000,100000]])if(!Number.isInteger(value[key]) || value[key]<low || value[key]>high)throw fault('INVALID_STREAM_OPTIONS');
  if(typeof value.fullscreen!=='boolean')throw fault('INVALID_STREAM_OPTIONS');
  for(const key of ['certificate','privateKey','hostCertificate'])if(typeof value[key]!=='string' || Buffer.byteLength(value[key])>16384)throw fault('INVALID_STREAM_TARGET');
  const body=Buffer.from(JSON.stringify(value));if(body.length>65536)throw fault('INVALID_STREAM_TARGET');
  const header=Buffer.alloc(4);header.writeUInt32BE(body.length);return Buffer.concat([header,body]);
}

function telemetryCapability(directory){
  try{return JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8')).capabilities?.includes('presentation-events-v1')===true;}catch{return false;}
}

function executable(directory,platform=process.platform,overlay=false){
  const relative=platform==='win32'?'runtime/ClipRelayStream.exe':platform==='darwin'?'runtime/ClipRelayStream.app/Contents/MacOS/Moonlight':null;
  if(!relative)throw fault('VIEWER_UNAVAILABLE');
  const file=path.join(directory,...relative.split('/'));
  const metadata=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  if(metadata.protocol!==1 || metadata.platform!==(platform==='win32'?'windows':'macos') || !/^[a-f0-9]{64}$/.test(metadata.files?.[relative] || ''))throw fault('VIEWER_INVALID');
  if(!Array.isArray(metadata.capabilities) || !metadata.capabilities.includes('session-events-v1'))throw fault('VIEWER_UPDATE_REQUIRED');
  if(overlay && (!Array.isArray(metadata.capabilities) || !metadata.capabilities.includes('embedded-network')))throw fault('VIEWER_UPDATE_REQUIRED');
  const stat=fs.lstatSync(file);if(!stat.isFile() || stat.isSymbolicLink() || stat.size>256*1024*1024)throw fault('VIEWER_INVALID');
  if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==metadata.files[relative])throw fault('VIEWER_INVALID');
  if(platform==='darwin')fs.accessSync(file,fs.constants.X_OK);
  return file;
}

class StreamViewer{
  constructor({directory,store,onUpdate=()=>{},spawnProcess=spawn,resolveExecutable=executable,resolveTelemetry=telemetryCapability,now=()=>performance.now(),
    retryDelays=[500,1000,2000,5000],recoveryMs=90000,maxRetries=8,stableMs=15000,startupMs=45000,killMs=3000}){
    Object.assign(this,{directory,store,onUpdate,spawnProcess,resolveExecutable,resolveTelemetry,now,retryDelays,recoveryMs,maxRetries,stableMs,startupMs,killMs});
    this.phase='idle';this.generation=0;this.available=false;this.error='';
    try{this.file=this.resolveExecutable(directory);this.available=true;}catch{}
  }
  snapshot(){
    const record=this.record,p=record?.progress;
    const progress=p && !record.closing && this.phase==='running'?{...p,receivedAgeMs:Math.min(60000,Math.ceil(Math.max(0,this.now()-record.receivedAt))),renderedAgeMs:Math.min(60000,Math.ceil(Math.max(0,this.now()-record.renderedAt)))}:null;
    return {available:this.available,phase:this.phase,hostName:this.intent?.bound.name || '',error:this.error,retry:this.intent?.retries || 0,telemetry:!!record?.telemetry,progress};
  }
  changed(){this.onUpdate(this.snapshot());}
  authorized(){
    const now=this.store.selected(),bound=this.intent?.bound;
    return bound && !this.store.data.legacySelected && now?.enabled && !now.routeBlocked &&
      ['id','certificate','clientId','networkId'].every(key=>now[key]===bound[key])?now:null;
  }
  clearTimers(){for(const name of ['retryTimer','deadlineTimer','stableTimer']){clearTimeout(this[name]);this[name]=null;}}
  finish(error=''){
    ++this.generation;this.intent=null;this.launching=null;this.clearTimers();this.error=error;
    this.phase=this.child?'closing':error?'error':'idle';this.changed();this.drain();
  }
  drain(){
    const record=this.record;if(!record || record.closing)return;
    record.closing=true;clearTimeout(record.startTimer);
    record.child.stdin?.end(()=>record.child.stdin.destroy());
    record.killTimer=setTimeout(()=>{if(this.record===record)record.child.kill();},this.killMs);record.killTimer.unref?.();
  }
  recover(){
    if(!this.authorized()){this.finish();return;}
    const intent=this.intent;intent.since ??= Date.now();
    if(Date.now()-intent.since>=this.recoveryMs || intent.retries>=this.maxRetries){this.finish('VIEWER_RECOVERY_EXHAUSTED');return;}
    ++this.generation;this.launching=null;this.clearTimers();this.phase='recovering';this.error='';
    if(this.record)this.record.recoveryRequested=true;
    this.deadlineTimer=setTimeout(()=>{if(this.intent===intent)this.finish('VIEWER_RECOVERY_EXHAUSTED');},Math.max(1,this.recoveryMs-(Date.now()-intent.since)));
    this.deadlineTimer.unref?.();this.changed();this.drain();this.schedule();
  }
  schedule(){
    if(!this.intent || this.child || this.launching || this.retryTimer || this.phase!=='recovering')return;
    const intent=this.intent,delay=this.retryDelays[Math.min(intent.retries,this.retryDelays.length-1)];
    this.retryTimer=setTimeout(()=>{
      this.retryTimer=null;if(this.intent!==intent)return;
      const host=this.authorized();if(!host){this.finish();return;}
      if(host.routeReady===false){this.schedule();return;}
      if(intent.retries>=this.maxRetries || Date.now()-intent.since>=this.recoveryMs){this.finish('VIEWER_RECOVERY_EXHAUSTED');return;}
      intent.retries++;
      this.launch().catch(()=>{});
    },delay);this.retryTimer.unref?.();
  }
  async open(options={}){
    if(this.child || this.intent || this.launching)throw fault('VIEWER_BUSY');
    const host=this.store.selected();if(!host?.enabled || this.store.data.legacySelected)throw fault('PAIRING_REQUIRED');
    if(host.routeBlocked)throw fault(host.routeBlocked);
    if(host.routeReady===false)throw fault('NETWORK_NOT_READY');
    if(!options || typeof options!=='object' || Array.isArray(options))throw fault('INVALID_STREAM_OPTIONS');
    this.intent={bound:{...host},options:Object.freeze({...options}),retries:0,since:null};this.error='';
    return this.launch();
  }
  async launch(){
    const host=this.authorized();if(!host){this.finish();throw fault('CANCELLED');}
    const intent=this.intent,generation=++this.generation;this.launching=generation;this.launchHost=host;
    this.phase=intent.since===null?'starting':'recovering';this.changed();
    let bytes;
    try{
      const file=this.resolveExecutable(this.directory,process.platform,host.overlay===true);this.available=true;
      const identity=await this.store.identity();
      if(generation!==this.generation || !sameRoute(this.authorized(),host))throw fault('CANCELLED');
      const telemetry=this.resolveTelemetry(this.directory);bytes=envelope(host,identity,intent.options,telemetry);
      // The host app owns this child. Its still-open stdin is the session lease;
      // normal quit and crashes close it. Credentials never enter argv/env/disk.
      const env={...process.env};
      for(const key of ['ELECTRON_RUN_AS_NODE','CHROME_CRASHPAD_PIPE_NAME','QT_PLUGIN_PATH','QML2_IMPORT_PATH','QT_QPA_PLATFORM_PLUGIN_PATH','QT_QPA_PLATFORM','QT_LOGGING_RULES'])delete env[key];
      const child=this.spawnProcess(file,['--cliprelay-session'],{cwd:path.dirname(file),env,windowsHide:true,stdio:['pipe','pipe','ignore'],shell:false});
      this.child=child;
      const record=this.record={child,host,intent,connected:false,ended:false,bytes:0,buffer:'',closing:false,telemetry,budgetAt:this.now()};
      // Failed OS process creation may return a ChildProcess without pipes.
      // Always handle its asynchronous error before inspecting stdin.
      child.on('error',()=>{if(this.record===record && !record.closing)this.finish('VIEWER_UNAVAILABLE');});
      child.once('close',()=>{
        if(this.record!==record)return;
        clearTimeout(record.killTimer);clearTimeout(record.startTimer);this.child=null;this.record=null;
        if(this.intent===intent && record.recoveryRequested){this.schedule();return;}
        if(this.intent===intent){this.finish('VIEWER_STOPPED');return;}
        this.phase=this.error?'error':'idle';this.changed();
      });
      if(!child.stdin || !child.stdout)throw fault('VIEWER_UNAVAILABLE');
      child.stdin.on('error',()=>{if(this.record===record && !record.closing)this.finish('VIEWER_UNAVAILABLE');});
      child.stdout.on('data',chunk=>this.events(record,chunk));
      child.stdout.on('error',()=>{if(this.record===record && !record.closing)this.finish('VIEWER_PROTOCOL_ERROR');});
      record.startTimer=setTimeout(()=>{if(this.record===record && !record.connected)this.finish('VIEWER_START_TIMEOUT');},this.startupMs);record.startTimer.unref?.();
      await new Promise((resolve,reject)=>{
        child.once('error',()=>reject(fault('VIEWER_UNAVAILABLE')));
        child.once('close',()=>reject(fault('VIEWER_UNAVAILABLE')));
        child.once('spawn',()=>child.stdin.write(bytes,error=>error?reject(fault('VIEWER_UNAVAILABLE')):resolve()));
      });
      if(generation!==this.generation || this.child!==child || !sameRoute(this.authorized(),host))throw fault('CANCELLED');
      return this.snapshot();
    }catch(error){
      if(generation===this.generation)this.finish(error.code==='CANCELLED'?'':error.code || 'VIEWER_UNAVAILABLE');
      throw error.code?error:fault('VIEWER_UNAVAILABLE');
    }finally{bytes?.fill(0);if(this.launching===generation)this.launching=null;}
  }
  events(record,chunk){
    if(this.record!==record || record.closing || this.intent!==record.intent)return;
    if(record.telemetry && this.now()-record.budgetAt>=1000){record.bytes=0;record.budgetAt=this.now();}
    record.bytes+=chunk.length;record.buffer+=chunk.toString('utf8');
    if(record.bytes>(record.telemetry?32768:4096)){this.finish('VIEWER_PROTOCOL_ERROR');return;}
    while(record.buffer.includes('\n')){
      const index=record.buffer.indexOf('\n'),line=record.buffer.slice(0,index);record.buffer=record.buffer.slice(index+1);
      if(line.length>1024){this.finish('VIEWER_PROTOCOL_ERROR');return;}
      let event;try{event=JSON.parse(line);}catch{this.finish('VIEWER_PROTOCOL_ERROR');return;}
      const keys=event && typeof event==='object'?Object.keys(event).sort().join(','):'';
      if(event?.version!==1 || record.ended || (event.event==='connected'?keys!=='event,version' || record.connected:
        event.event==='ended'?keys!=='event,reason,version' || !['network','pairing','host','user','parent','decoder'].includes(event.reason):
        event.event==='progress'?!record.telemetry || !record.connected || keys!=='event,height,received,receivedAgeMs,rendered,renderedAgeMs,version,width':true)){
        this.finish('VIEWER_PROTOCOL_ERROR');return;
      }
      if(!this.authorized()){this.finish();return;}
      if(event.event==='progress'){
        const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max,p=record.progress;
        if(!integer(event.received,0,0xffffffff)||!integer(event.rendered,0,event.received)||!integer(event.width,event.rendered?1:0,event.rendered?65536:0)||!integer(event.height,event.rendered?1:0,event.rendered?65536:0)||
          !integer(event.receivedAgeMs,0,60000)||!integer(event.renderedAgeMs,0,60000)||(!event.received&&event.receivedAgeMs!==60000)||(!event.rendered&&event.renderedAgeMs!==60000)||
          (p&&(event.received<p.received||event.rendered<p.rendered||(event.rendered===p.rendered&&(event.width!==p.width||event.height!==p.height||event.renderedAgeMs<p.renderedAgeMs))||(event.received===p.received&&event.receivedAgeMs<p.receivedAgeMs)))){
          this.finish('VIEWER_PROTOCOL_ERROR');return;
        }
        const now=this.now(),receivedAt=now-event.receivedAgeMs,renderedAt=now-event.renderedAgeMs;
        record.receivedAt=p&&p.received===event.received?Math.min(record.receivedAt,receivedAt):receivedAt;
        record.renderedAt=p&&p.rendered===event.rendered?Math.min(record.renderedAt,renderedAt):renderedAt;
        record.progress={received:event.received,rendered:event.rendered,width:event.width,height:event.height,receivedAgeMs:event.receivedAgeMs,renderedAgeMs:event.renderedAgeMs};this.changed();
      }else if(event.event==='connected'){
        record.connected=true;clearTimeout(record.startTimer);clearTimeout(this.deadlineTimer);
        this.phase='running';this.error='';this.changed();
        this.stableTimer=setTimeout(()=>{if(this.record===record && this.intent===record.intent){this.intent.retries=0;this.intent.since=null;}},this.stableMs);this.stableTimer.unref?.();
      }else{
        record.ended=true;
        if(event.reason==='network')this.recover();
        else this.finish(({pairing:'UNPAIRED',host:'VIEWER_HOST_ERROR',decoder:'VIEWER_DECODER_ERROR',parent:'VIEWER_STOPPED'})[event.reason] || '');
        return;
      }
    }
    if(record.buffer.length>1024)this.finish('VIEWER_PROTOCOL_ERROR');
  }
  reconcile(status){
    if(!this.intent)return;
    if(['HOST_CERT_CHANGED','UNPAIRED','RELAY_UNPAIRED','KEYCHAIN_UNAVAILABLE'].includes(status)){this.finish(status);return;}
    const now=this.authorized();if(!now){this.finish();return;}
    if(this.record && !sameRoute(now,this.record.host)){this.recover();return;}
    if(this.launching && (!sameRoute(now,this.launchHost) || now.routeReady===false)){this.recover();return;}
    this.schedule();
  }
  stop(){this.finish();}
}
module.exports={StreamViewer,envelope,executable};
