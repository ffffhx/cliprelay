'use strict';
const crypto=require('node:crypto');
const protocol=require('./file-protocol.cjs'),local=require('./file-storage.cjs');
const {sameRoute}=require('./routed-store.cjs');
const {fault}=require('./paired-transport.cjs');
const {message:pairedMessage}=require('./paired-controller.cjs');
const {requireValue,CHUNK,safeName,location,sha}=protocol;
const identityHash=value=>sha(new crypto.X509Certificate(value.cert).raw);
const denied=new Set(['HOST_CERT_CHANGED','UNPAIRED','RELAY_UNPAIRED','KEYCHAIN_UNAVAILABLE']);
const messages={FILES_BAD_PATH:'名称或路径不可用',FILES_LINK_NOT_ALLOWED:'不支持符号链接或重解析目录',FILES_NOT_FOUND:'文件或传输记录不存在',FILES_ACCESS_DENIED:'没有访问这个文件的权限',FILES_DISK_FULL:'目标磁盘空间不足',FILES_IO:'无法读写文件',FILES_NOT_READY:'电脑仍在准备文件，请稍后继续',FILES_HASH_MISMATCH:'文件校验失败，已停止传输',FILES_ID_CONFLICT:'传输记录不匹配，已停止',FILES_QUEUE_FULL:'传输记录已满，请清理已完成记录',FILES_TOO_LARGE:'单个文件最大为 1 TB',FILES_EXISTS:'同名文件或文件夹已存在，请更换名称或目录',FILES_SOURCE_CHANGED:'源文件已改变，请重新选择文件',FILES_UNAVAILABLE:'电脑端文件服务暂时不可用',FILES_BUSY:'电脑端正在处理其他文件，请稍后继续',FILES_INVALID_RESPONSE:'电脑返回的数据无效，传输已停止',FILES_OFFSET:'传输进度不一致，请重新创建任务',FILES_CHUNK_CONFLICT:'文件片段不一致，传输已停止',FILES_INVALID_STATE:'当前传输状态不允许此操作',FILES_DESTINATION_CHANGED:'保存目录或临时文件已改变，请重新创建任务',FILES_DESTINATION_UNSUPPORTED:'保存目录不支持安全发布文件，请选择本地 NTFS 或 APFS 目录',FILES_TARGET_CHANGED:'请选择原配对电脑后继续传输',FILES_LOCAL_STORAGE:'无法保存传输记录，已停止传输',FILES_DIALOG_BUSY:'已有文件选择窗口打开'};
function errorCode(error){if(messages[error?.code] || denied.has(error?.code) || ['PAIRING_REQUIRED','NETWORK_NOT_READY','NETWORK_PAUSED','NETWORK_REVOKED','NETWORK_PEER_CHANGED','UPDATE_HOST','TIMEOUT','CANCELLED'].includes(error?.code))return error.code;return ({ENOSPC:'FILES_DISK_FULL',EACCES:'FILES_ACCESS_DENIED',EPERM:'FILES_ACCESS_DENIED',ENOENT:'FILES_NOT_FOUND',EEXIST:'FILES_EXISTS'})[error?.code] || 'FILES_IO';}
function message(error){const code=errorCode(error);return messages[code] || pairedMessage({code});}
function delay(ms,signal){return new Promise((resolve,reject)=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);resolve();},abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(fault('CANCELLED'));},timer=setTimeout(finish,ms);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
class FileController{
  constructor({store,directory,dialog,shell,request=protocol.request,storage,onUpdate=()=>{},pollMs=300}){
    Object.assign(this,{store,dialog,shell,request,onUpdate,pollMs});this.storage=storage || new local.FileStorage(directory);this.operations=new Set();this.status='';const selected=store.selected();this.lastRoute=selected?{...selected}:null;this.resetBrowser();
  }
  resetBrowser(){this.browser={roots:[],root:'',path:'',entries:[],next:'',loaded:false};}
  snapshot(){
    return {browser:{...this.browser,entries:this.browser.entries.map(entry=>({...entry}))},busy:!!this.browsing,picking:!!this.picking,error:this.storageError || '',tasks:this.storage.jobs.map(task=>({id:task.id,hostId:task.hostId,hostName:task.hostName,direction:task.direction,name:task.name,root:task.root,path:task.path,size:task.size,offset:task.offset,verified:task.verified,state:task.state,finalName:task.finalName || '',error:task.error?message({code:task.error}):'',destination:task.state==='complete' && task.direction==='download'?task.destination.directory:''}))};
  }
  save(){try{this.storage.save();}catch{this.storageError=message({code:'FILES_LOCAL_STORAGE'});for(const operation of this.operations)operation.controller.abort();throw fault('FILES_LOCAL_STORAGE');}this.onUpdate();}
  selected(){
    requireValue(!this.closed && !this.storageError,'FILES_LOCAL_STORAGE');const host=this.store.selected();requireValue(host?.enabled && !this.store.data.legacySelected,'PAIRING_REQUIRED');
    if(denied.has(this.status))throw fault(this.status);if(host.routeBlocked)throw fault(host.routeBlocked);requireValue(host.routeReady!==false,'NETWORK_NOT_READY');return {...host};
  }
  guard(operation){local.check(operation.controller.signal);requireValue(sameRoute(this.selected(),operation.host),'FILES_TARGET_CHANGED');}
  async context(){
    const operation={host:this.selected(),controller:new AbortController()};this.operations.add(operation);
    try{operation.identity=await this.store.identity();this.guard(operation);operation.identityHash=identityHash(operation.identity);return operation;}catch(error){this.operations.delete(operation);throw error;}
  }
  matches(task,operation){return task.hostId===operation.host.id && task.clientId===operation.host.clientId && (task.networkId || '')===(operation.host.networkId || '') && task.identity===operation.identityHash;}
  async call(operation,command){this.guard(operation);const reply=await this.request(operation.host,operation.identity,command,operation.controller.signal);this.guard(operation);return reply;}
  reconcile(status){
    if(status!==undefined)this.status=status;
    const selected=this.store.selected(),changed=(!selected && !!this.lastRoute) || (!!selected && !sameRoute(selected,this.lastRoute));this.lastRoute=selected?{...selected}:null;
    if(!changed && !denied.has(this.status))return;
    if(changed)this.resetBrowser();for(const operation of this.operations)operation.controller.abort();
    let dirty=false;for(const task of this.storage.jobs)if(!local.terminal.has(task.state) && task.state!=='paused' && task.state!=='cancel-pending'){task.state=task.cancelRequested?'cancel-pending':'paused';task.error=denied.has(this.status)?this.status:'FILES_TARGET_CHANGED';dirty=true;}
    if(dirty)try{this.save();}catch{}this.onUpdate();
  }
  async browse(root='',relative='',more=false){
    requireValue(!this.browsing,'FILES_BUSY');const operation=await this.context();if(this.browsing){this.operations.delete(operation);throw fault('FILES_BUSY');}this.browsing=operation;
    try{
      let roots=this.browser.roots;if(!roots.length)roots=(await this.call(operation,{op:'roots'})).roots;
      if(!root)root=roots[0]?.id || '';if(!root){this.browser={roots,root:'',path:'',entries:[],next:'',loaded:true};return;}
      location(root,relative);requireValue(roots.some(item=>item.id===root),'FILES_BAD_PATH');
      if(more)requireValue(this.browser.root===root && this.browser.path===relative && !!this.browser.next,'FILES_INVALID_STATE');
      const after=more?this.browser.next:'',reply=await this.call(operation,{op:'list',root,path:relative,...(after?{after}:{})});
      requireValue(!reply.next || reply.next!==after,'FILES_INVALID_RESPONSE');
      const entries=more?[...this.browser.entries,...reply.entries]:reply.entries;requireValue(entries.length<=4096,'FILES_TOO_LARGE');
      requireValue(new Set(entries.map(entry=>entry.name)).size===entries.length,'FILES_INVALID_RESPONSE');
      this.browser={roots,root,path:relative,entries,next:reply.next,loaded:true};
    }finally{this.operations.delete(operation);if(this.browsing===operation)this.browsing=null;this.onUpdate();}
  }
  currentLocation(){requireValue(this.browser.loaded && this.browser.root,'FILES_NOT_READY');return location(this.browser.root,this.browser.path);}
  async mkdir(name){
    const destination=this.currentLocation();safeName(name);const operation=await this.context();
    try{await this.call(operation,{op:'mkdir',...destination,name});}finally{this.operations.delete(operation);}await this.browse(destination.root,destination.path);
  }
  task(operation,direction,remote){return {id:crypto.randomBytes(16).toString('hex'),hostId:operation.host.id,hostName:operation.host.name,clientId:operation.host.clientId,networkId:operation.host.networkId || '',identity:operation.identityHash,direction,...remote,state:'queued',size:0,offset:0,verified:0,sha256:'',error:'',cancelRequested:false};}
  async pick(window,direction,names){
    requireValue(!this.picking,'FILES_DIALOG_BUSY');const remote=this.currentLocation(),chosen=[];
    if(direction==='download'){
      requireValue(Array.isArray(names) && names.length>0 && names.length<=128 && new Set(names).size===names.length,'FILES_BAD_REQUEST');
      for(const name of names){const entry=this.browser.entries.find(entry=>entry.name===name);requireValue(entry && !entry.directory && !entry.blocked,'FILES_BAD_PATH');chosen.push({...entry});}
    }else requireValue(this.browser.roots.find(root=>root.id===remote.root)?.writable,'FILES_ACCESS_DENIED');
    const operation=await this.context();if(this.picking){this.operations.delete(operation);throw fault('FILES_DIALOG_BUSY');}this.picking=operation;
    try{
      requireValue(window && !window.isDestroyed(),'CANCELLED');
      const result=await this.dialog.showOpenDialog(window,{title:direction==='upload'?'选择要上传的文件':'选择下载保存目录',properties:direction==='upload'?['openFile','multiSelections']:['openDirectory','createDirectory']});
      this.guard(operation);requireValue(!window.isDestroyed(),'CANCELLED');if(result.canceled)return;
      requireValue(Array.isArray(result.filePaths) && result.filePaths.length>0 && result.filePaths.length<=128,'FILES_QUEUE_FULL');
      let tasks;
      if(direction==='upload'){
        tasks=[];for(const file of result.filePaths){const selected=await local.source(file);this.guard(operation);tasks.push({...this.task(operation,'upload',remote),...selected});}
      }else{
        requireValue(result.filePaths.length===1,'FILES_BAD_PATH');const destination=await local.destination(result.filePaths[0]);
        tasks=chosen.map(entry=>({...this.task(operation,'download',{...remote,name:entry.name}),size:entry.size,destination}));
      }
      this.guard(operation);this.storage.add(tasks);this.onUpdate();this.pump();
    }finally{this.operations.delete(operation);if(this.picking===operation)this.picking=null;}
  }
  releaseWindow(){this.picking?.controller.abort();}
  pause(id){const task=this.storage.get(id);requireValue(!local.terminal.has(task.state) && !task.cancelRequested,'FILES_INVALID_STATE');task.state='paused';task.error='';if(this.active?.task===task)this.active.controller.abort();this.save();}
  async resume(id){
    const task=this.storage.get(id);requireValue(['paused','cancel-pending'].includes(task.state) && this.active?.task!==task,'FILES_INVALID_STATE');const operation=await this.context();
    try{requireValue(this.matches(task,operation),'FILES_TARGET_CHANGED');task.state=task.cancelRequested?'cancelling':'queued';task.error='';this.save();}finally{this.operations.delete(operation);}this.pump();
  }
  cancel(id){
    const task=this.storage.get(id);requireValue(!local.terminal.has(task.state),'FILES_INVALID_STATE');task.cancelRequested=true;task.state='cancelling';task.error='';if(this.active?.task===task)this.active.controller.abort();this.save();this.pump();
  }
  async forget(id){const task=this.storage.get(id);requireValue(this.active?.task!==task && local.terminal.has(task.state),'FILES_INVALID_STATE');await local.cleanupPart(task);this.storage.forget(task);this.onUpdate();}
  async reveal(id){const task=this.storage.get(id);requireValue(task.state==='complete' && task.direction==='download' && task.finalName,'FILES_INVALID_STATE');await local.directoryFor(task);this.shell.showItemInFolder(require('node:path').join(task.destination.directory,task.finalName));}
  pump(){
    if(this.running || this.closed || this.storageError)return;
    this.running=this.runQueue().catch(()=>{}).finally(()=>{this.running=null;if(!this.closed && !this.storageError && this.storage.jobs.some(task=>['queued','cancelling'].includes(task.state)))this.pump();});
  }
  async runQueue(){
    for(;;){
      if(this.closed || this.storageError)return;const task=this.storage.jobs.find(task=>['queued','cancelling'].includes(task.state));if(!task)return;let operation;
      try{
        operation=await this.context();operation.task=task;this.active=operation;requireValue(['queued','cancelling'].includes(task.state),'CANCELLED');requireValue(this.matches(task,operation),'FILES_TARGET_CHANGED');
        if(task.cancelRequested)await this.cancelRemote(task,operation);
        else if(task.direction==='upload')await this.upload(task,operation);else await this.download(task,operation);
      }catch(error){
        if(!local.terminal.has(task.state)){
          const code=errorCode(error);
          // An explicit cancel interrupts an active transfer, then makes one
          // separate authenticated cancellation attempt. No offline retry loop.
          task.state=task.cancelRequested?(code==='CANCELLED' && task.state==='cancelling'?'cancelling':'cancel-pending'):'paused';
          task.error=code==='CANCELLED'?'':code;try{this.save();}catch{}
        }
      }finally{if(operation)this.operations.delete(operation);this.active=null;this.onUpdate();}
    }
  }
  async remote(task,operation,command){
    const result=await this.call(operation,{...command,id:task.id});
    requireValue(result.root===task.root && result.path===task.path && result.name===task.name && result.direction===task.direction && result.size===task.size,'FILES_ID_CONFLICT');
    if(task.sha256 && result.sha256)requireValue(result.sha256===task.sha256,'FILES_SOURCE_CHANGED');
    if(result.state==='error')throw fault(result.code || 'FILES_IO');
    return result;
  }
  async until(task,operation,result,allowed){
    const started=Date.now();while(!allowed.includes(result.state)){
      requireValue(result.state!=='cancelled','FILES_INVALID_STATE');requireValue(Date.now()-started<30*60*1000,'FILES_NOT_READY');
      task.verified=result.verified;this.onUpdate();await delay(this.pollMs,operation.controller.signal);result=await this.remote(task,operation,{op:'status'});
    }return result;
  }
  async upload(task,operation){
    const handle=await local.openSource(task),signal=operation.controller.signal;
    try{
      task.state='hashing';task.verified=0;this.onUpdate();const digest=await local.digest(handle,task.size,signal,offset=>{task.verified=offset;this.onUpdate();});await local.verifySource(task,handle);this.guard(operation);
      requireValue(!task.sha256 || task.sha256===digest,'FILES_SOURCE_CHANGED');task.sha256=digest;this.save();
      let reply=await this.remote(task,operation,{op:'upload-start',root:task.root,path:task.path,name:task.name,size:task.size,sha256:task.sha256});
      reply=await this.until(task,operation,reply,['uploading','complete']);task.offset=reply.offset;
      if(reply.state!=='complete'){
        task.state='uploading';task.verified=0;this.save();const buffer=Buffer.alloc(CHUNK);
        while(task.offset<task.size){
          this.guard(operation);const length=Math.min(CHUNK,task.size-task.offset),{bytesRead}=await handle.read(buffer,0,length,task.offset);requireValue(bytesRead===length,'FILES_SOURCE_CHANGED');
          const data=buffer.subarray(0,length),offset=task.offset;reply=await this.remote(task,operation,{op:'upload-chunk',offset,data:data.toString('base64'),sha256:sha(data)});
          requireValue(reply.state==='uploading' && reply.offset===offset+length,'FILES_OFFSET');task.offset=reply.offset;this.save();
        }
        await local.verifySource(task,handle);task.state='verifying';this.save();reply=await this.remote(task,operation,{op:'finish',sha256:task.sha256});reply=await this.until(task,operation,reply,['complete']);
      }
      requireValue(reply.offset===task.size && !!reply.finalName && reply.sha256===task.sha256,'FILES_INVALID_RESPONSE');task.finalName=reply.finalName;task.state='complete';task.verified=task.size;task.error='';this.save();
    }finally{await handle.close();}
  }
  async download(task,operation){
    const signal=operation.controller.signal;task.state='preparing';this.onUpdate();
    let reply=await this.remote(task,operation,{op:'download-start',root:task.root,path:task.path,name:task.name});reply=await this.until(task,operation,reply,['ready','complete']);
    requireValue(protocol.hash(reply.sha256),'FILES_INVALID_RESPONSE');requireValue(!task.sha256 || task.sha256===reply.sha256,'FILES_SOURCE_CHANGED');task.sha256=reply.sha256;this.save();
    const handle=await local.openPart(task,()=>this.save());
    try{
      task.state='downloading';task.verified=0;this.onUpdate();
      while(task.offset<task.size){
        const data=await this.call(operation,{op:'download-chunk',id:task.id,offset:task.offset});requireValue(data.size===task.size && data.offset===task.offset,'FILES_OFFSET');await local.directoryFor(task);this.guard(operation);
        const {bytesWritten}=await handle.write(data.bytes,0,data.bytes.length,task.offset);requireValue(bytesWritten===data.bytes.length,'FILES_IO');await handle.sync();task.offset+=data.bytes.length;this.save();
      }
      task.state='verifying';task.verified=0;this.onUpdate();const digest=await local.digest(handle,task.size,signal,offset=>{task.verified=offset;this.onUpdate();});requireValue(digest===task.sha256,'FILES_HASH_MISMATCH');
      reply=await this.remote(task,operation,{op:'finish',sha256:digest});requireValue(reply.state==='complete','FILES_INVALID_RESPONSE');
    }finally{await handle.close();}
    this.guard(operation);await local.publish(task,()=>this.save(),signal);
  }
  async cancelRemote(task,operation){
    // Publication may have succeeded immediately before a crash. A cancel
    // must acknowledge that existing verified file instead of reporting loss.
    if(await local.published(task,operation.controller.signal)){task.state='complete';task.offset=task.size;task.verified=task.size;task.error='';this.save();await local.cleanupPart(task);return;}
    let reply;try{reply=await this.call(operation,{op:'cancel',id:task.id});}catch(error){if(error.code!=='FILES_NOT_FOUND')throw error;}
    if(reply?.state==='complete' && task.direction==='upload'){
      requireValue(reply.direction===task.direction && reply.root===task.root && reply.path===task.path && reply.name===task.name && reply.sha256===task.sha256 && reply.size===task.size && !!reply.finalName,'FILES_ID_CONFLICT');
      task.state='complete';task.offset=task.size;task.finalName=reply.finalName;task.verified=task.size;
    }else{
      requireValue(!reply || ['complete','cancelled'].includes(reply.state),'FILES_NOT_READY');await local.cleanupPart(task);task.state='cancelled';
    }task.error='';this.save();
  }
  async action(action,data,window){
    if(action==='files-browse')await this.browse(data?.root || '',data?.path || '',data?.more===true);
    else if(action==='files-mkdir')await this.mkdir(data?.name);
    else if(action==='files-upload')await this.pick(window,'upload');
    else if(action==='files-download')await this.pick(window,'download',data?.names);
    else if(action==='files-pause')this.pause(data?.id);
    else if(action==='files-resume')await this.resume(data?.id);
    else if(action==='files-cancel')this.cancel(data?.id);
    else if(action==='files-forget')await this.forget(data?.id);
    else if(action==='files-reveal')await this.reveal(data?.id);
    else throw fault('FILES_BAD_REQUEST');
  }
  close(){this.closed=true;for(const operation of this.operations)operation.controller.abort();for(const task of this.storage.jobs)if(!local.terminal.has(task.state))task.state=task.cancelRequested?'cancel-pending':'paused';try{this.save();}catch{}}
}
module.exports={FileController,message};
