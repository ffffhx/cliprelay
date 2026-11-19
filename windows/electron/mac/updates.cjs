'use strict';
const {EventEmitter} = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const base = 'https://github.com/ffffhx/cliprelay/releases/download';
function newer(next, current) {
  if (!/^\d+\.\d+\.\d+$/.test(next) || !/^\d+\.\d+\.\d+$/.test(current)) throw new Error('版本信息无效');
  const a = next.split('.').map(Number), b = current.split('.').map(Number);
  for (let i=0;i<3;i++) if(a[i]!==b[i])return a[i]>b[i];
  return false;
}
function assetFor(manifest, arch) {
  const version = manifest.versionName;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('更新版本无效');
  const asset = manifest.assets?.[arch];
  if (!asset || !/^ClipRelay-macOS-[a-zA-Z0-9.-]+\.zip$/.test(asset.archive)
    || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 2**31 || !/^[a-f0-9]{64}$/.test(asset.sha256)
    || asset.downloadUrl !== `${base}/macos-v${version}/${asset.archive}`) throw new Error('更新安装包信息无效');
  return asset;
}
class Updates extends EventEmitter {
  constructor({version, directory, development=false, arch=process.arch, fetch}) {
    super(); Object.assign(this,{version,directory,development,arch,fetch}); this.state={phase:development?'development':'idle',version};
  }
  set(patch){this.state={...this.state,error:undefined,...patch};this.emit('changed',this.state);return this.state;}
  async check(){
    if(this.development || this.busy || this.state.phase==='downloaded')return this.state;
    this.busy=true;this.set({phase:'checking'});
    try{
      const response=await this.fetch(`${base}/macos-latest/macos-update.json`,{signal:AbortSignal.timeout(30_000)});
      if(!response.ok)throw new Error(`更新服务返回 ${response.status}`);
      const manifest=await response.json();
      if(!newer(manifest.versionName,this.version))return this.set({phase:'idle'});
      this.asset=assetFor(manifest,this.arch);
      return this.set({phase:'available',nextVersion:manifest.versionName});
    }catch(error){return this.set({phase:'error',error:error.message});}
    finally{this.busy=false;}
  }
  async download(){
    if(this.development || this.busy || !this.asset)return this.state;
    this.busy=true;this.set({phase:'downloading',percent:0});
    let output,partial;
    try{
      await fs.mkdir(this.directory,{recursive:true});
      const file=path.join(this.directory,this.asset.archive);partial=file+'.part';
      const response=await this.fetch(this.asset.downloadUrl,{signal:AbortSignal.timeout(30*60_000)});
      if(!response.ok || !response.body)throw new Error('无法下载安装包');
      output=await fs.open(partial,'w');const hash=createHash('sha256');let size=0;
      for await(const bytes of response.body){
        size+=bytes.length;if(size>this.asset.size)throw new Error('安装包大小不符');
        hash.update(bytes);await output.writeFile(bytes);this.set({phase:'downloading',percent:size/this.asset.size*100});
      }
      if(size!==this.asset.size || hash.digest('hex')!==this.asset.sha256)throw new Error('安装包校验失败，请重试');
      await output.close();output=null;await fs.rename(partial,file);
      return this.set({phase:'downloaded',file,percent:100});
    }catch(error){await output?.close().catch(()=>{});if(partial)await fs.rm(partial,{force:true}).catch(()=>{});return this.set({phase:'error',error:error.message});}
    finally{this.busy=false;}
  }
}
function initialize({app,dialog,Notification,net,shell,BrowserWindow,development=false}){
  const updates=new Updates({version:app.getVersion(),directory:path.join(app.getPath('userData'),'Downloads'),development,fetch:net.fetch});
  updates.on('changed',state=>{for(const window of BrowserWindow.getAllWindows())window.setProgressBar(state.phase==='downloading'?state.percent/100:-1);});
  let opening=false,lastNotified='';
  const open=async()=>{
    if(opening)return;opening=true;
    try{
      if(development){await dialog.showMessageBox({message:`ClipRelay 开发版 ${app.getVersion()}`,detail:'使用本地源码构建，线上正式版不会覆盖此版本。'});return;}
      let state=await updates.check();
      if(state.phase==='available'){
        const result=await dialog.showMessageBox({message:`ClipRelay ${state.nextVersion} 已发布`,detail:'下载后打开压缩包，退出当前 App，再将新版 ClipRelay.app 拖到“应用程序”。现有设备配置会保留。',buttons:['下载新版','稍后'],cancelId:1});
        if(result.response!==0)return;state=await updates.download();
      }
      if(state.phase==='downloaded'){
        const result=await dialog.showMessageBox({message:'安装包已下载并校验',detail:'打开压缩包后，将 ClipRelay.app 拖到“应用程序”完成更新。',buttons:['打开安装包','稍后'],cancelId:1});
        if(result.response===0){const error=await shell.openPath(state.file);if(error)throw new Error(error);}
      }else if(state.phase==='idle' || state.phase==='error')await dialog.showMessageBox({type:state.error?'error':'info',message:state.error?'更新未完成':`当前已是最新版本 ${app.getVersion()}`,detail:state.error||''});
    }catch(error){await dialog.showMessageBox({type:'error',message:'更新未完成',detail:error.message});}
    finally{opening=false;}
  };
  const check=async()=>{const state=await updates.check();if(state.phase==='available' && state.nextVersion!==lastNotified){lastNotified=state.nextVersion;const notice=new Notification({title:`ClipRelay ${state.nextVersion} 已发布`,body:'点击查看并下载安装包。'});notice.on('click',open);notice.show();}};
  if(!development){const startup=setTimeout(check,15_000),timer=setInterval(check,4*60*60_000);startup.unref();timer.unref();app.once('before-quit',()=>{clearTimeout(startup);clearInterval(timer);});}
  return {open,updates};
}
module.exports={Updates,newer,assetFor,initialize};
