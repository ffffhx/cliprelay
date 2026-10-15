'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {endpoint,fault}=require('./paired-transport.cjs');
const {validateIdentity}=require('./paired-store.cjs');

function envelope(host,identity,options={}){
  validateIdentity(identity);
  const target=endpoint(host.address,host.port);
  if(target.port>65514 || target.address.includes('%'))throw fault('INVALID_STREAM_TARGET');
  const certificate=new crypto.X509Certificate(host.certificate);
  if(crypto.createHash('sha256').update(certificate.raw).digest('hex')!==host.id || !/^[a-f0-9]{32}$/.test(host.clientId))throw fault('INVALID_STREAM_TARGET');
  if(!options || typeof options!=='object' || Array.isArray(options) || Object.keys(options).some(k=>!['width','height','fps','bitrate','fullscreen'].includes(k)))throw fault('INVALID_STREAM_OPTIONS');
  const value={version:1,...target,clientId:host.clientId,certificate:identity.cert,privateKey:identity.key,hostCertificate:host.certificate,width:1920,height:1080,fps:60,bitrate:12000,fullscreen:false,...options};
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

function executable(directory,platform=process.platform,overlay=false){
  const relative=platform==='win32'?'runtime/ClipRelayStream.exe':platform==='darwin'?'runtime/ClipRelayStream.app/Contents/MacOS/Moonlight':null;
  if(!relative)throw fault('VIEWER_UNAVAILABLE');
  const file=path.join(directory,...relative.split('/'));
  const metadata=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  if(metadata.protocol!==1 || metadata.platform!==(platform==='win32'?'windows':'macos') || !/^[a-f0-9]{64}$/.test(metadata.files?.[relative] || ''))throw fault('VIEWER_INVALID');
  if(overlay && (!Array.isArray(metadata.capabilities) || !metadata.capabilities.includes('embedded-network')))throw fault('VIEWER_UPDATE_REQUIRED');
  const stat=fs.lstatSync(file);if(!stat.isFile() || stat.isSymbolicLink() || stat.size>256*1024*1024)throw fault('VIEWER_INVALID');
  if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==metadata.files[relative])throw fault('VIEWER_INVALID');
  if(platform==='darwin')fs.accessSync(file,fs.constants.X_OK);
  return file;
}

class StreamViewer{
  constructor({directory,store,onUpdate=()=>{},spawnProcess=spawn,resolveExecutable=executable}){
    Object.assign(this,{directory,store,onUpdate,spawnProcess,resolveExecutable});this.phase='idle';this.generation=0;this.available=false;
    try{this.file=this.resolveExecutable(directory);this.available=true;}catch{}
  }
  snapshot(){return {available:this.available,phase:this.phase,hostName:this.host?.name || ''};}
  changed(){this.onUpdate(this.snapshot());}
  matches(host){const now=this.store.selected();return !this.store.data.legacySelected && now?.enabled && ['id','clientId','certificate','address','port','overlay','overlayPort','routeId'].every(key=>now[key]===host[key]);}
  async open(options={}){
    if(this.child || this.phase==='starting' || this.phase==='closing')throw fault('VIEWER_BUSY');
    const host=this.store.selected();if(!host?.enabled || this.store.data.legacySelected)throw fault('PAIRING_REQUIRED');
    const generation=++this.generation;this.phase='starting';this.host={...host};this.changed();
    let bytes;
    try{
      const file=this.resolveExecutable(this.directory,process.platform,host.overlay===true);this.available=true;
      const identity=await this.store.identity();
      if(generation!==this.generation || !this.matches(host))throw fault('CANCELLED');
      bytes=envelope(host,identity,options);
      // The host app owns this child. Its still-open stdin is the session lease;
      // normal quit and crashes close it. Credentials never enter argv/env/disk.
      const env={...process.env};
      for(const key of ['ELECTRON_RUN_AS_NODE','CHROME_CRASHPAD_PIPE_NAME','QT_PLUGIN_PATH','QML2_IMPORT_PATH','QT_QPA_PLATFORM_PLUGIN_PATH','QT_QPA_PLATFORM','QT_LOGGING_RULES'])delete env[key];
      const child=this.spawnProcess(file,['--cliprelay-session'],{cwd:path.dirname(file),env,windowsHide:true,stdio:['pipe','ignore','ignore'],shell:false});
      this.child=child;
      // Failed OS process creation may return a ChildProcess without pipes.
      // Always handle its asynchronous error before inspecting stdin.
      child.on('error',()=>{});
      child.once('close',code=>{if(this.child!==child)return;clearTimeout(this.killTimer);this.child=null;this.host=null;this.phase=this.phase==='closing' || code===0?'idle':'error';this.changed();});
      if(!child.stdin)throw fault('VIEWER_UNAVAILABLE');
      child.stdin.on('error',()=>{if(this.child===child)this.stop();});
      await new Promise((resolve,reject)=>{
        child.once('error',()=>reject(fault('VIEWER_UNAVAILABLE')));
        child.once('spawn',()=>child.stdin.write(bytes,error=>error?reject(fault('VIEWER_UNAVAILABLE')):resolve()));
      });
      if(generation!==this.generation || this.child!==child || !this.matches(host))throw fault('CANCELLED');
      this.phase='running';this.changed();return this.snapshot();
    }catch(error){
      if(generation===this.generation){if(this.child)this.stop();else{this.phase='error';this.host=null;this.changed();}}
      throw error.code?error:fault('VIEWER_UNAVAILABLE');
    }finally{bytes?.fill(0);}
  }
  reconcile(){if(this.host && !this.matches(this.host))this.stop();}
  stop(){
    ++this.generation;
    if(!this.child){this.phase='idle';this.host=null;this.changed();return;}
    const child=this.child;this.phase='closing';this.changed();child.stdin?.end();
    clearTimeout(this.killTimer);this.killTimer=setTimeout(()=>{if(this.child===child)child.kill();},3000);this.killTimer.unref?.();
  }
}
module.exports={StreamViewer,envelope,executable};
