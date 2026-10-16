'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {app}=require('electron');
assert.equal(process.platform,'darwin');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.CI,'true');
assert.equal(process.env.CLIPRELAY_NATIVE_LOGIN_FIXTURE,'1');
const options=JSON.parse(process.env.CLIPRELAY_NATIVE_LOGIN_OPTIONS);
assert.ok(options.userData.startsWith(fs.realpathSync(process.env.RUNNER_TEMP)+path.sep));
app.setPath('userData',options.userData);app.disableHardwareAcceleration();
const {LoginStartup}=require(path.join(options.modules,'login-startup.cjs'));
const timer=setTimeout(()=>app.exit(3),15000);
app.whenReady().then(()=>{
  app.dock?.hide();assert.equal(app.isPackaged,true);
  const owner=new LoginStartup({app});let result;
  try{
    if(options.phase==='initial'){
      result=owner.refresh();assert.equal(result.status,'not-registered');assert.equal(result.enabled,false);
    }else if(options.phase==='enable'){
      result=owner.setEnabled({enabled:true});assert.equal(result.status,'enabled');assert.equal(result.enabled,true);
    }else if(options.phase==='reopen'){
      result=owner.refresh();assert.equal(result.enabled,true);
    }else if(options.phase==='external-disable'){
      assert.equal(owner.snapshot().enabled,true);
      app.setLoginItemSettings({type:'mainAppService',openAtLogin:false});result=owner.refresh();
      assert.equal(result.status,'not-registered');assert.equal(result.registered,false);
    }else if(options.phase==='cleanup'){
      app.setLoginItemSettings({type:'mainAppService',openAtLogin:false});result=owner.refresh();
      assert.equal(result.status,'not-registered');assert.equal(result.enabled,false);
    }else assert.fail('Unknown fixture phase');
    fs.writeFileSync(options.report,JSON.stringify({passed:true,phase:options.phase,electron:process.versions.electron,architecture:process.arch,state:result}));
  }catch(error){
    fs.writeFileSync(options.report,JSON.stringify({passed:false,phase:options.phase,state:owner.snapshot(),error:{code:error.code || 'NATIVE_LOGIN_FAILED',message:error.message}}));throw error;
  }finally{owner.close();}
  clearTimeout(timer);app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(timer);app.exit(1);});
