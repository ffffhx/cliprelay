'use strict';
// Launch as a detached Electron test application, not from a resident terminal
// job. Uses a disposable native config with no peers and a separate HTTP port.
const {app}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {NativeHost}=require('../electron/native-host.cjs');
const {DesktopWindows}=require('../electron/windows.cjs');
const root=process.argv.find(value=>value.startsWith('--root='))?.slice(7);
if(!root)throw new Error('Pass --root=<isolated native fixture directory>');
assert.equal(fs.readFileSync(path.join(root,'.electron-test-fixture'),'utf8'),'startup-registration-disabled');
const output=path.join(root,'test-results');fs.mkdirSync(output,{recursive:true});
app.setPath('userData',path.join(output,'profile'));
app.on('window-all-closed',()=>{});
let host,windows;
const results=[];
const record=result=>{results.push(result);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(action,label){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await action())return;await sleep(100);}throw new Error('Timeout: '+label);}
app.whenReady().then(async()=>{
  host=new NativeHost({root,launcher:path.resolve(__dirname,'../electron/launch-native.ps1')});
  host.on('failure',error=>record({failure:error.message}));
  windows=new DesktopWindows(host,path.resolve(__dirname,'..'));
  const ready=once(host,'ready');await host.start();await ready;
  const initial=await host.request('snapshot');assert.equal(initial.config.port,47931);assert.deepEqual(initial.config.peers,[]);
  const summary=await host.request('summary',{results:[{Name:'test receiver',Address:'127.0.0.1',Success:true,StatusCode:200,ErrorKind:'',ErrorMessage:'',ElapsedMilliseconds:1,ResponseBody:'ok'}]});
  assert.equal(summary.State,'success');assert.equal(summary.SuccessCount,1);
  await assert.rejects(host.request('patch',{peers:[],expectedRevision:-1}),/设备列表已改变/);
  let keyRestart=once(host,'ready');await host.request('patch',{accessToken:'qa-local-receiver-key'});await keyRestart;
  const merged=await host.request('merge',{peers:[],devices:[{Id:'new-qa-device',Name:'QA discovered phone',Address:'192.0.2.2',Port:47932,Platform:'android',RequiresAuth:true}],addNew:true});
  assert.equal(merged.Added,1);assert.equal(merged.Peers[0].accessToken,'');
  keyRestart=once(host,'ready');await host.request('patch',{accessToken:''});await keyRestart;
  record({nativeReady:true,port:initial.config.port});
  const errors=[];
  for(const name of ['control-center','peer-editor','screen-share-picker','preview-remote','updates','remote-desktop','remote-network']){
    const window=windows.open(name);
    window.webContents.on('console-message',details=>{if(details.level==='error')errors.push({name,message:details.message});});
    await waitFor(()=>window.webContents.executeJavaScript('document.body?.dataset.ready === "true"').catch(()=>false),name);
    assert.match(window.webContents.getURL(),/renderer\/index\.html\?view=/);
    const info=await window.webContents.executeJavaScript('({title:document.title,buttons:document.querySelectorAll("button").length,text:document.body.innerText})');
    assert.ok(info.buttons>0);assert.ok(info.text.length>20);
    fs.writeFileSync(path.join(output,name+'.png'),(await window.webContents.capturePage()).toPNG());
    record({window:name,buttons:info.buttons,html:true});
    window.destroy();
  }
  assert.deepEqual(errors,[]);
  // Real renderer input -> restricted preload -> named pipe -> original save.
  const center=windows.open('control-center');
  await waitFor(()=>center.webContents.executeJavaScript('document.body?.dataset.ready === "true"').catch(()=>false),'control reopen');
  const editor=windows.open('peer-editor');
  await waitFor(()=>editor.webContents.executeJavaScript('document.body?.dataset.ready === "true"').catch(()=>false),'editor reopen');
  await editor.webContents.executeJavaScript(`document.getElementById('peer-name').value='QA disabled target';document.getElementById('peer-address').value='192.0.2.1';document.getElementById('peer-port').value='47932';document.querySelector('[role="switch"]').click();[...document.querySelectorAll('button')].find(button=>button.textContent==='保存设备').click();`);
  await waitFor(()=>editor.isDestroyed(),'save editor');
  const saved=await host.request('snapshot');assert.equal(saved.config.peers[0].name,'QA disabled target');assert.equal(saved.config.peers[0].enabled,false);assert.equal(saved.config.peers[0].port,47932);
  record({rendererSave:true});
  await host.request('patch',{peers:[]});
  // The fixture stubs startup registration before this real native save.
  const restarted=once(host,'ready');
  await host.request('patch',{deviceName:'Electron migration restarted'});
  await restarted;
  const after=await host.request('snapshot');assert.equal(after.config.deviceName,'Electron migration restarted');assert.equal(after.config.port,47931);
  record({nativeRestart:true});
  windows.close();const exited=once(host,'exit');host.stop();await exited;
  record({complete:true});app.quit();
}).catch(async error=>{
  record({error:error.stack});windows?.close();
  if(host){const exited=once(host,'exit');host.stop();await Promise.race([exited,sleep(10000)]);}
  app.exit(1);
});
