'use strict';
const fault=code=>Object.assign(new Error(code),{code});
const messages={
  LOGIN_STARTUP_UNAVAILABLE:'请使用已安装的 Mac 应用设置登录启动。',
  LOGIN_STARTUP_INVALID:'登录启动设置无效。',
  LOGIN_STARTUP_UNCONFIRMED:'系统尚未确认登录启动设置，请检查系统设置中的登录项。',
  LOGIN_STARTUP_CLOSED:'应用正在退出，未更改登录启动设置。'
};
const message=error=>messages[error?.code] || messages.LOGIN_STARTUP_UNCONFIRMED;
class LoginStartup{
  constructor({app,platform=process.platform}){
    this.app=app;this.supported=platform==='darwin' && app?.isPackaged===true &&
      typeof app.getLoginItemSettings==='function' && typeof app.setLoginItemSettings==='function';
    this.closed=false;this.state={available:false,status:'unavailable',enabled:false,registered:false,error:null};
    this.refresh();
  }
  snapshot(){return {...this.state,available:this.supported && !this.closed};}
  refresh(){
    if(this.closed || !this.supported)return this.snapshot();
    try{
      const actual=this.app.getLoginItemSettings({type:'mainAppService'});
      if(!actual || !['not-registered','enabled','requires-approval','not-found'].includes(actual.status) ||
        typeof actual.openAtLogin!=='boolean' || actual.openAtLogin!==(actual.status==='enabled'))throw fault('LOGIN_STARTUP_UNCONFIRMED');
      this.state={status:actual.status,enabled:actual.status==='enabled',
        registered:actual.status==='enabled' || actual.status==='requires-approval',error:null};
    }catch{this.state={status:'unknown',enabled:false,registered:false,error:'LOGIN_STARTUP_UNCONFIRMED'};}
    return this.snapshot();
  }
  setEnabled(data){
    if(!data || Array.isArray(data) || Object.keys(data).join(',')!=='enabled' || typeof data.enabled!=='boolean')throw fault('LOGIN_STARTUP_INVALID');
    if(this.closed)throw fault('LOGIN_STARTUP_CLOSED');
    if(!this.supported)throw fault('LOGIN_STARTUP_UNAVAILABLE');
    // No saved preference is replayed at launch. macOS remains authoritative,
    // including changes made by the user in System Settings while we run.
    let failed=false;
    try{this.app.setLoginItemSettings({type:'mainAppService',openAtLogin:data.enabled});}catch{failed=true;}
    const actual=this.refresh();
    const confirmed=data.enabled?['enabled','requires-approval'].includes(actual.status):actual.status==='not-registered';
    if(failed || !confirmed){this.state.error='LOGIN_STARTUP_UNCONFIRMED';throw fault('LOGIN_STARTUP_UNCONFIRMED');}
    return this.snapshot();
  }
  close(){this.closed=true;}
}
module.exports={LoginStartup,message};
