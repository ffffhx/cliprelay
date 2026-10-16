'use strict';
const fs=require('node:fs'),path=require('node:path');
const {HostState}=require('./host-state.cjs'),{HostEngine}=require('./host-engine.cjs'),{HostCompanion}=require('./host-companion.cjs'),{HostSession}=require('./host-session.cjs');
const {hostPairing,decision}=require('./host-pairing.cjs');
const {HostClients}=require('./host-clients.cjs');
const {HostMonitor}=require('./host-monitor.cjs');
const fault=code=>Object.assign(new Error(code),{code});
const messages={
  HOST_UNAVAILABLE:'此安装包未包含完整的本机远程访问组件。',HOST_ENGINE_INVALID:'远程画面组件校验失败，请重新安装完整应用。',
  HOST_COMPANION_INVALID:'远程连接组件校验失败，请重新安装完整应用。',HOST_PLATFORM_UNSUPPORTED:'此设备不支持本机远程访问。',
  HOST_PERMISSION_REQUIRED:'请先允许屏幕录制和键鼠控制，再启动远程访问。',HOST_KEYCHAIN_UNAVAILABLE:'系统钥匙串不可用，暂时无法启动远程访问。',
  HOST_SESSION_BUSY:'正在启动、停止或运行远程访问。',HOST_SESSION_CLOSED:'应用正在退出。',HOST_SESSION_CANCELLED:'启动已取消。',
  HOST_PAIR_INVALID:'配对操作无效，请刷新请求。',HOST_PAIR_STALE:'这次请求已过期或已处理，请核对当前请求。',
  HOST_PAIR_CLOSED:'远程访问已停止。',HOST_PAIR_TIMEOUT:'读取配对请求超时，请重试。',HOST_PAIR_UNAVAILABLE:'暂时无法读取配对请求，请重试。',
  HOST_PAIR_BAD_REPLY:'无法确认配对请求，请重试。',HOST_PAIR_CANCELLED:'配对操作已取消。',
  HOST_CLIENTS_INVALID:'设备操作无效，请刷新列表。',HOST_CLIENTS_STALE:'连接状态已改变，请重新选择设备。',
  HOST_CLIENTS_BUSY:'正在撤销设备权限，请稍候。',HOST_CLIENTS_UNAVAILABLE:'暂时无法读取已配对设备。',
  HOST_CLIENTS_UNCONFIRMED:'尚未确认撤销完成，请核对设备状态后重试。已停用的设备不会自动恢复权限。',
  HOST_PREFERENCES_INVALID:'自动启动设置无效。',HOST_PREFERENCES_BUSY:'正在保存设置，请稍候。',HOST_PREFERENCES_FAILED:'设置未能保存，请重试。',
  HOST_ENGINE_EXITED:'远程画面组件已退出，远程访问已停止。',HOST_COMPANION_EXITED:'远程连接组件已退出，远程访问已停止。'
};
function message(error){return messages[error?.code] || '无法完成远程访问操作，请检查权限后重试。';}
function readPin(directory,name,arch){
  const file=path.join(directory,name+'-pin.json'),stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>1024)throw fault('HOST_UNAVAILABLE');
  const pin=JSON.parse(fs.readFileSync(file,'utf8')),expected=name==='host-engine'?['arch','commit','manifestSha256']:['commit','manifestSha256'];
  if(!pin || Array.isArray(pin) || Object.keys(pin).length!==expected.length || !expected.every(key=>Object.hasOwn(pin,key)) ||
      !/^[a-f0-9]{40}$/.test(pin.commit) || !/^[a-f0-9]{64}$/.test(pin.manifestSha256) ||
      (name==='host-engine' && pin.arch!==(arch==='x64'?'x86_64':'arm64')))throw fault('HOST_UNAVAILABLE');
  return pin;
}
function createOwners({directory,stateDirectory,safeStorage,enginePin,companionPin,onUpdate}){
  const state=new HostState({directory:stateDirectory,safeStorage});
  const engine=new HostEngine({directory:path.join(directory,'host-engine'),pin:enginePin,state});
  const companion=new HostCompanion({directory:path.join(directory,'host-companion'),pin:companionPin,state});
  return {session:new HostSession({engine,companion,onUpdate}),companion};
}
class HostController{
  constructor({directory,stateDirectory,safeStorage,localName,platform=process.platform,arch=process.arch,create=createOwners,rpc=hostPairing,clientRequest,onUpdate=()=>{},onPairingRequest=()=>{},autoStart=false,saveAutoStart,monitorOptions={}}){
    Object.assign(this,{localName,rpc,onUpdate,saveAutoStart});this.autoStart=autoStart===true;this.owner=null;this.requests=[];this.operations=new Set();this.backgroundOperations=new Set();this.generation=0;this.error=null;this.closed=false;
    try{
      if(platform!=='darwin' || !['arm64','x64'].includes(arch))throw fault('HOST_PLATFORM_UNSUPPORTED');
      this.owner=create({directory,stateDirectory,safeStorage,enginePin:readPin(directory,'host-engine',arch),companionPin:readPin(directory,'host-companion',arch),onUpdate:()=>this.changed()});
      this.clients=new HostClients({session:this.owner.session,request:clientRequest});
      this.monitor=new HostMonitor({...monitorOptions,session:this.owner.session,version:()=>this.generation,
        read:signal=>this.query('host-pair-list',undefined,{signal,background:true}),
        onRequests:requests=>{this.requests=requests;this.error=null;this.publish();},
        onError:()=>{this.requests=[];this.error='HOST_PAIR_UNAVAILABLE';this.publish();},onNotice:onPairingRequest});
    }catch(error){this.error=error.code==='HOST_PLATFORM_UNSUPPORTED'?error.code:'HOST_UNAVAILABLE';}
  }
  snapshot(){
    const state=this.owner?.session.snapshot() || {phase:'stopped',error:null};
    return {available:!!this.owner && !this.closed,phase:this.closed?'closed':state.phase,error:state.error || this.error,
      requests:state.phase==='running' && !this.closed?this.requests.map(request=>({...request})):[],nativeWorkers:false,autoStart:this.autoStart,
      fileTransfer:!this.closed&&state.phase==='running'&&state.fileTransfer===true,
      clients:this.clients?.snapshot() || {viewId:null,phase:'unavailable',error:null,devices:[],revoking:null}};
  }
  changed(){
    if(this.owner?.session.snapshot().phase!=='running')this.invalidate();
    this.clients?.reconcile();
    this.monitor?.reconcile();this.publish();
  }
  publish(){try{this.onUpdate(this.snapshot());}catch{}}
  cancelRequests(){for(const operation of this.operations)operation.abort();}
  invalidate(){this.generation++;this.requests=[];this.cancelRequests();this.refreshOperation=null;}
  async query(op,data,{signal,background=false}={}){
    if(this.closed || this.owner?.session.snapshot().phase!=='running')throw fault('HOST_PAIR_CLOSED');
    const generation=this.generation,abort=new AbortController();this.operations.add(abort);
    if(background)this.backgroundOperations.add(abort);
    const cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    try{
      if(abort.signal.aborted)throw fault('HOST_PAIR_CANCELLED');
      const result=await this.rpc({companion:this.owner.companion,op,data,signal:abort.signal});
      if(this.closed || abort.signal.aborted || generation!==this.generation || this.owner.session.snapshot().phase!=='running')throw fault('HOST_PAIR_CANCELLED');
      return result;
    }finally{signal?.removeEventListener('abort',cancel);this.operations.delete(abort);this.backgroundOperations.delete(abort);}
  }
  async refresh(){await Promise.all([this.refreshPairing(),this.clients?.refresh()]);return this.snapshot();}
  refreshPairing(){
    if(this.owner?.session.snapshot().phase!=='running' || this.closed)return Promise.resolve(this.snapshot());
    if(this.refreshOperation)return this.refreshOperation.task;
    const operation={};this.refreshOperation=operation;
    operation.task=(async()=>{
      try{const result=await this.query('host-pair-list');if(this.refreshOperation===operation){this.requests=result.requests;this.error=null;}}
      catch(error){if(this.refreshOperation===operation){this.requests=[];if(!this.closed && this.owner.session.snapshot().phase==='running')this.error=['HOST_PAIR_TIMEOUT','HOST_PAIR_BAD_REPLY'].includes(error.code)?error.code:'HOST_PAIR_UNAVAILABLE';}}
      finally{if(this.refreshOperation===operation){this.refreshOperation=null;this.publish();}}
      return this.snapshot();
    })();return operation.task;
  }
  async action(action,data){
    if(!['host-status','host-start','host-stop','host-pair-approve','host-pair-reject','host-client-revoke','host-set-auto-start'].includes(action))throw fault('HOST_PAIR_INVALID');
    if(!action.startsWith('host-pair-') && !['host-client-revoke','host-set-auto-start'].includes(action) && data!==undefined && (data===null || Array.isArray(data) || typeof data!=='object' || Object.keys(data).length))throw fault('HOST_PAIR_INVALID');
    if(action==='host-status')return this.refresh();
    if(this.closed)throw fault('HOST_SESSION_CLOSED');
    if(action==='host-set-auto-start')return this.setAutoStart(data);
    if(!this.owner)throw fault(this.error || 'HOST_UNAVAILABLE');
    if(action==='host-start'){
      if(this.startTask || this.owner.session.current)throw fault('HOST_SESSION_BUSY');this.error=null;
      this.startTask=this.owner.session.start(this.localName).catch(error=>{
        if(!this.closed && error.code!=='HOST_SESSION_CANCELLED')this.error=messages[error.code]?error.code:'HOST_START_FAILED';
      }).finally(()=>{this.startTask=null;});return this.snapshot();
    }
    if(action==='host-stop'){this.error=null;this.cancelRequests();const stopping=this.owner.session.stop();await Promise.all([stopping,this.monitor?.join()]);return this.snapshot();}
    if(action==='host-client-revoke'){await this.clients.revoke(data);return this.snapshot();}
    const selected=decision(data);
    await this.query(action,selected);
    // Decisions are checked against the live in-memory generation in the
    // companion. A stale UI cannot authorize a newly-created same-ID request.
    this.invalidate();
    await this.refresh();return this.snapshot();
  }
  setAutoStart(data){
    if(!data || Object.keys(data).join(',')!=='enabled' || typeof data.enabled!=='boolean')return Promise.reject(fault('HOST_PREFERENCES_INVALID'));
    if(this.preferenceTask)return Promise.reject(fault('HOST_PREFERENCES_BUSY'));
    if(data.enabled && !this.owner)return Promise.reject(fault('HOST_UNAVAILABLE'));
    const enabled=data.enabled;this.preferenceTask=Promise.resolve().then(async()=>{
      try{
        if(typeof this.saveAutoStart!=='function')throw fault('HOST_PREFERENCES_FAILED');
        await this.saveAutoStart(enabled);this.autoStart=enabled;this.publish();return this.snapshot();
      }catch{throw fault('HOST_PREFERENCES_FAILED');}
      finally{this.preferenceTask=null;}
    });return this.preferenceTask;
  }
  launch(){
    if(this.launched || this.closed)return Promise.resolve(this.snapshot());this.launched=true;
    if(!this.autoStart)return Promise.resolve(this.snapshot());
    return this.action('host-start').catch(error=>{if(!this.closed){this.error=messages[error.code]?error.code:'HOST_START_FAILED';this.publish();}return this.snapshot();});
  }
  releaseWindow(){for(const operation of this.operations)if(!this.backgroundOperations.has(operation))operation.abort();this.clients?.releaseWindow();}
  close(){
    if(!this.closePromise){this.closed=true;this.invalidate();const monitoring=this.monitor?.close();this.closePromise=(async()=>{await Promise.allSettled([monitoring,this.preferenceTask]);await this.clients?.close();await this.owner?.session.close();return this.snapshot();})();}
    return this.closePromise;
  }
}
module.exports={HostController,message};
