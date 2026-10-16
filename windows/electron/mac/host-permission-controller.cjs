'use strict';
const fs=require('node:fs'),path=require('node:path');
const {HostPermissions}=require('./host-permissions.cjs');
const fault=code=>Object.assign(new Error(code),{code});
const messages={
  HOST_ENGINE_UNAVAILABLE:'此安装包未包含本机远程访问组件。',
  HOST_ENGINE_INVALID:'本机远程访问组件校验失败，请重新安装完整应用。',
  HOST_PLATFORM_UNSUPPORTED:'此设备不支持本机远程访问组件。',
  HOST_PERMISSIONS_BUSY:'正在处理权限操作，请稍候。',
  HOST_PERMISSION_TIMEOUT:'权限检查或授权等待超时，请重试。',
  HOST_PERMISSION_CANCELLED:'权限操作已取消。',
  HOST_PERMISSION_COMMAND_FAILED:'无法读取系统权限，请重试。',
  HOST_PERMISSION_BAD_REPLY:'无法确认系统权限，请重试。',
  HOST_PERMISSIONS_CLOSED:'应用正在退出。',
  INVALID_HOST_PERMISSION:'请选择屏幕录制或键鼠控制权限。',
  HOST_PERMISSION_NOT_CHECKED:'请先检查当前系统权限。'
};
function message(error){return messages[error?.code] || '无法完成权限操作，请重试。';}
class HostPermissionController{
  constructor({directory,platform=process.platform,arch=process.arch,create=options=>new HostPermissions(options)}){
    this.owner=null;this.error=null;this.closed=false;
    try{
      if(platform!=='darwin' || !['arm64','x64'].includes(arch))throw fault('HOST_PLATFORM_UNSUPPORTED');
      const pinPath=path.join(directory,'host-engine-pin.json'),stat=fs.lstatSync(pinPath);
      if(!stat.isFile() || stat.isSymbolicLink() || stat.size>1024)throw fault('HOST_ENGINE_INVALID');
      const pin=JSON.parse(fs.readFileSync(pinPath,'utf8'));
      if(!pin || Object.keys(pin).length!==3 || pin.arch!==(arch==='x64'?'x86_64':'arm64') ||
          typeof pin.commit!=='string' || !/^[a-f0-9]{40}$/.test(pin.commit) ||
          typeof pin.manifestSha256!=='string' || !/^[a-f0-9]{64}$/.test(pin.manifestSha256))throw fault('HOST_ENGINE_INVALID');
      this.owner=create({directory:path.join(directory,'host-engine'),pin,platform,arch});
    }catch(error){this.error=error.code==='ENOENT'?'HOST_ENGINE_UNAVAILABLE':messages[error.code]?error.code:'HOST_ENGINE_INVALID';}
  }
  snapshot(){
    const state=this.owner?.snapshot() || {checking:false,screenRecording:null,inputControl:null,checkedAt:null,error:this.error};
    return {...state,available:!!this.owner && !this.closed,busy:!!this.owner?.operation,
      error:this.closed?'HOST_PERMISSIONS_CLOSED':state.error};
  }
  async action(action,data){
    if(!['host-permissions-status','host-permissions-check','host-permissions-request'].includes(action))throw fault('INVALID_HOST_PERMISSION');
    if(action==='host-permissions-status')return this.snapshot();
    if(this.closed)throw fault('HOST_PERMISSIONS_CLOSED');
    if(!this.owner)throw fault(this.error);
    if(action==='host-permissions-request'){
      if(!data || Object.keys(data).length!==1 || !['screenRecording','inputControl'].includes(data.permission))throw fault('INVALID_HOST_PERMISSION');
      if(this.owner.snapshot().checkedAt==null)throw fault('HOST_PERMISSION_NOT_CHECKED');
    }
    try{
      if(action==='host-permissions-check')await this.owner.query();
      else await this.owner.request(data.permission);
    }catch(error){
      // The process owner publishes sanitized failures and clears previous grants.
      // Busy is transient and must not overwrite the active operation's state.
      if(error.code==='HOST_PERMISSIONS_BUSY')throw error;
      await this.owner.cancel();
    }
    return this.snapshot();
  }
  releaseWindow(){return this.owner?.cancel() || Promise.resolve();}
  close(){this.closed=true;return this.owner?.close() || Promise.resolve();}
}
module.exports={HostPermissionController,message};
