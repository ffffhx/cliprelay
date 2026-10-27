'use strict';
// Real Electron renderer + preload + IPC, with deterministic transport replies.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const http=require('node:http');
const {DesktopWindows}=require('../electron/windows.cjs');
const root=process.argv.find(v=>v.startsWith('--root='))?.slice(7);
assert.equal(fs.readFileSync(path.join(root,'.electron-test-fixture'),'utf8'),'startup-registration-disabled');
const output=path.join(root,'test-results');fs.mkdirSync(output,{recursive:true});
app.setPath('userData',path.join(output,'profile'));app.on('window-all-closed',()=>{});
const calls=[],checks=[],sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(check,label){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await sleep(40);}throw new Error('Timeout: '+label);}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const peer=(id,name,platform)=>({id,name,platform,address:id==='pc'?'192.168.1.20':'192.168.1.8',port:47632,enabled:true,legacyAllowed:true});
const state={revision:0,config:{deviceName:'我的 Windows',port:47632,peers:[peer('pc','Studio PC','windows'),peer('phone','OnePlus 12','android')],notifications:true,startupEnabled:true,discoveryEnabled:true},addresses:[{Address:'192.168.1.9'}],runtime:{State:'success',Detail:'文本已发送到 OnePlus 12',At:Date.now(),ScreenshotHotkeyAvailable:true},update:{CurrentVersion:'0.4.0',Checked:true},sharing:{Stage:'idle'}};
let discovery,probe,merge,windows,center;
let remoteAvailable=false,clipboardUnavailable=false,remoteServer;
let incomingEnabled=true,incomingFailure=false,incomingMutation;
let codeRequired=false,deviceCode='12345678',codeUpdate,codeFailure=false,networkHosts=[],networkOnline=true,networkPairing={state:'idle'},target,session={phase:'idle',peerId:'',error:''};
const host={async request(action,data={}){
  calls.push({action,data:structuredClone(data)});
  if(action==='snapshot')return structuredClone(state);
  if(action==='patch'){const {expectedRevision,...patch}=data;if(expectedRevision!==undefined&&expectedRevision!==state.revision)throw new Error('设备列表已改变，请重试。');Object.assign(state.config,structuredClone(patch));state.revision++;return structuredClone(state);}
  if(action==='discover')return discovery?discovery.promise:[];
  if(action==='merge'){if(merge)return merge.promise;const added=data.addNew?data.devices.filter(d=>!data.peers.some(p=>p.id===(d.id||d.Id))).map(d=>({...d,enabled:true,remotePort:remoteServer.address().port})):[];let updated=0;const peers=data.peers.map(p=>{const d=data.devices.find(d=>(d.id||d.Id)===p.id);const address=d?.address||d?.Address;if(!data.addNew&&address&&address!==p.address){updated++;return {...p,address};}return p;});return {Peers:[...peers,...added],Added:added.length,Updated:updated,Removed:0};}
  if(action==='probe')return probe?probe.promise:data.peers.map(p=>({Success:p.id==='pc'&&!clipboardUnavailable,ErrorMessage:p.id==='pc'&&!clipboardUnavailable?'':'连接超时',StatusCode:p.id==='pc'&&!clipboardUnavailable?200:0}));
  if(action==='normalize-peer'){if(!data.address||data.port<1||data.port>65535)throw new Error('设备地址或端口无效');return data;}
  if(action==='remote'){
    if(data.action==='deviceAccess'){if(data.required!==undefined)codeRequired=data.required;return {ok:true,data:{required:codeRequired,code:deviceCode}};}
    if(data.action==='deviceCode')return {ok:true,data:{value:deviceCode}};
    if(data.action==='deviceCodeRotate'){if(codeUpdate)await codeUpdate.promise;if(codeFailure)return {ok:false,error:'Network unavailable'};deviceCode='87654321';return {ok:true,data:{value:deviceCode}};}
    if(data.action==='status')return incomingFailure?{ok:false,error:'Service unavailable'}:{ok:true,data:{enabled:incomingEnabled,ready:incomingEnabled}};
    if(incomingMutation)await incomingMutation.promise;
    if(data.action==='enable'||data.action==='disable'){incomingEnabled=data.action==='enable';return {ok:true,data:{enabled:incomingEnabled}};}
  }
  if(action.startsWith('update-'))return null;
  throw new Error('Unexpected '+action);
}};
const evaluate=async script=>{try{return await center.webContents.executeJavaScript(script);}catch(error){throw new Error(script+'\n'+error.message);}};
const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const ready=()=>evaluate('document.body.dataset.ready === "true"').catch(()=>false);
const record=name=>{checks.push(name);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(checks,null,2));};
app.whenReady().then(async()=>{
  remoteServer=http.createServer((req,res)=>{assert.equal(req.url,'/serverinfo');res.end(remoteAvailable?'<root status_code="200"><appversion>7.1</appversion><uniqueid>pc</uniqueid><state>SUNSHINE_SERVER_FREE</state></root>':'ok');});
  await new Promise(r=>remoteServer.listen(0,'127.0.0.1',r));
  windows=new DesktopWindows(host,path.resolve(__dirname,'..'));
  windows.client={open(peer){target=peer;session={phase:'starting',peerId:peer.id,error:''};return session;},direct:{get busy(){return false;},status:()=>session,stop:()=>session={phase:'idle',peerId:'',error:''}},paired:{store:{hosts:()=>networkHosts}},network:{
    snapshot:()=>({pairing:networkPairing}),route:()=>networkOnline?{address:'127.0.0.1',port:remoteServer.address().port}:null,
    claim(code){networkPairing={state:'connecting'};setTimeout(()=>{if(code!=='12345678'){networkPairing={state:'error',error:'PAIRING_CODE_EXPIRED'};return;}networkHosts=[{networkId:'a'.repeat(24),name:'Paired away computer',enabled:true}];networkPairing={state:'paired'};},80);return {pairing:networkPairing};},
    connectSaved(){this.pairTask=Promise.resolve();this.pairing={state:networkOnline?'paired':'error',error:'NETWORK_NOT_READY'};},
    cancelPair(){networkPairing={state:'error',error:'CANCELLED'};},remove(){networkHosts=[];}
  },close(){}};
  discovery=deferred();center=windows.open();await wait(ready,'renderer ready');
  await wait(()=>calls.some(c=>c.action==='discover'),'automatic detection');
  assert.equal(await evaluate('typeof require'),'undefined');
  assert.match(await evaluate('window.cliprelay.request("share").catch(e=>e.message)'),/Invalid desktop action/);
  assert.doesNotMatch(await evaluate('document.body.innerText'),/共享本机屏幕|发送当前剪贴板|允许设备连接/);
  assert.equal(await evaluate('document.querySelector("h1").textContent'),'剪切板');
  assert.equal(await evaluate('document.querySelectorAll("[data-action=toggle-target]").length'),2);
  assert.equal(await evaluate('document.querySelectorAll("[data-action=connect]").length'),0);
  record('sandbox, removed share action, concise navigation');
  await click('[data-action="targets"]');await click('[data-target="phone"]');await click('[data-action="targets-save"]');
  await wait(()=>!state.config.peers[1].enabled,'target saved');
  discovery.resolve([]);discovery=null;
  await wait(()=>evaluate('document.body.innerText.includes("1/2 台设备接收可用")'),'all-device detection after target change');
  assert.deepEqual(calls.filter(c=>c.action==='probe').at(-1).data.peers.map(p=>[p.id,p.enabled]),[['pc',true],['phone',false]]);
  record('changing sending targets during discovery preserves detection of every device');
  let probeCount=calls.filter(c=>c.action==='probe').length;
  probe=deferred();await click('[data-action="probe"]');await wait(()=>calls.filter(c=>c.action==='probe').length>probeCount,'probe started');
  await click('[data-action="targets"]');await click('[data-target="pc"]');await click('[data-action="targets-save"]');
  await wait(()=>state.config.peers.every(p=>!p.enabled),'no sending targets selected');
  assert.equal(await evaluate('document.querySelector(".probe-summary").innerText.includes("正在检测")'),true);
  probe.resolve([{Success:true},{Success:false,ErrorMessage:'连接超时'}]);probe=null;
  await wait(()=>evaluate('document.body.innerText.includes("1/2 台设备接收可用")'),'target change preserves active probe');
  await click('[data-action="probe"]');await wait(()=>calls.filter(c=>c.action==='probe').length>probeCount+1,'zero sending targets still probes');
  await wait(()=>evaluate('document.body.innerText.includes("1/2 台设备接收可用")'),'zero target probe completed');
  assert.equal(state.config.peers.every(p=>!p.enabled),true);
  await click('[data-action="targets"]');await click('[data-target="phone"]');await click('[data-action="targets-save"]');
  await wait(()=>state.config.peers[1].enabled,'target reselected');
  assert.equal(await evaluate('document.querySelector(".probe-summary").innerText.includes("1/2 台设备接收可用")'),true);
  record('sending selection neither cancels probes nor clears results; zero selected targets can be checked');
  const mergeCount=calls.filter(c=>c.action==='merge').length;
  merge=deferred();await click('[data-action="probe"]');await wait(()=>calls.filter(c=>c.action==='merge').length>mergeCount,'address refresh started');
  const discovered=calls.filter(c=>c.action==='merge').at(-1).data.peers.map(p=>({...p,address:p.id==='pc'?'192.168.1.21':p.address}));
  await click('[data-action="targets"]');await click('[data-target="phone"]');await click('[data-action="targets-save"]');
  await wait(()=>state.config.peers.every(p=>!p.enabled),'targets changed while refreshing addresses');
  merge.resolve({Peers:discovered,Added:0,Updated:1,Removed:0});merge=null;
  await wait(()=>evaluate('document.body.innerText.includes("1/2 台设备接收可用")'),'refreshed addresses probed');
  assert.equal(state.config.peers[0].address,'192.168.1.21');assert.equal(state.config.peers.every(p=>!p.enabled),true);
  record('address refresh preserves target changes made during discovery');
  probeCount=calls.filter(c=>c.action==='probe').length;
  probe=deferred();await click('[data-action="probe"]');await wait(()=>calls.filter(c=>c.action==='probe').length>probeCount,'new probe started');
  state.config.peers[0].name='Renamed PC';state.revision++;windows.refresh();await wait(()=>evaluate('document.body.innerText.includes("Renamed PC")'),'external roster update');
  probe.resolve([{Success:true}]);probe=null;await sleep(200);assert.equal(await evaluate('document.querySelector(".probe-summary")'),null);record('stale probe cannot label a changed roster');
  state.config.peers[1].enabled=true;state.revision++;windows.refresh();await sleep(100);
  await click('[data-action="probe"]');await wait(()=>evaluate('document.body.innerText.includes("1/2 台设备接收可用")'),'partial detection');
  await click('[data-action="probe-detail"]');assert.match(await evaluate('document.querySelector("dialog").innerText'),/连接超时/);await click('[data-action="dismiss"]');
  fs.writeFileSync(path.join(output,'devices.png'),(await center.webContents.capturePage()).toPNG());record('partial results, device error details and screenshot');
  await click('[data-action="toggle-target"][data-id="pc"]');await wait(()=>state.config.peers[0].enabled,'card sending toggle saved');
  assert.equal(await evaluate('document.querySelector(".probe-summary").innerText.includes("1/2 台设备接收可用")'),true);
  state.config.peers[0].address='127.0.0.1';state.config.peers[0].remotePort=remoteServer.address().port;state.revision++;windows.refresh();await sleep(120);
  await click('[data-action="probe"]');await wait(()=>evaluate('document.body.innerText.includes("1/2 台设备接收可用")'),'clipboard succeeds');
  await click('[data-page="remote"]');await wait(()=>evaluate('document.body.innerText.includes("未检测到兼容的远控服务")'),'remote check rejects clipboard-style reply');
  assert.equal(await evaluate('document.querySelector("[data-action=connect]").disabled'),true);
  assert.equal(await evaluate('document.querySelectorAll("[data-device-id]").length'),1);
  assert.doesNotMatch(await evaluate('document.querySelector("#page").innerText'),/OnePlus|可发送|接收未响应/);
  remoteAvailable=true;clipboardUnavailable=true;
  await click('[data-page="devices"]');await click('[data-action="probe"]');await wait(()=>evaluate('document.body.innerText.includes("0/2 台设备接收可用")'),'clipboard receiver unavailable');
  await click('[data-page="remote"]');await click('[data-action="remote-probe"]');await wait(()=>evaluate('!document.querySelector("[data-action=connect]").disabled'),'remote remains connectable');
  const windowCount=BrowserWindow.getAllWindows().length;
  await click('[data-action="connect"][data-id="pc"]');assert.equal(target.address,'127.0.0.1');assert.equal(target.port,remoteServer.address().port);
  assert.equal(BrowserWindow.getAllWindows().length,windowCount);
  assert.equal(await evaluate('document.querySelector("dialog").open'),false);
  await wait(()=>evaluate('document.body.innerText.includes("正在启动控制")'),'connection state shown inline');
  await click('[data-action="remote-stop"]');
  record('clipboard card toggles persist; remote availability is independent; connect has no second window');
  assert.equal(windows.open('remote-home'),center);assert.equal(windows.open('screen-share-picker'),undefined);
  fs.writeFileSync(path.join(output,'remote.png'),(await center.webContents.capturePage()).toPNG());record('connect forwards actual device; old remote route reuses center; share window removed');
  await click('[data-page="settings"]');
  await wait(()=>evaluate('document.querySelector("[data-action=toggle-host]").getAttribute("aria-checked")==="true"'),'host defaults enabled');
  incomingMutation=deferred();await click('[data-action="toggle-host"]');
  await wait(()=>evaluate('document.querySelector("[data-action=toggle-host]").disabled'),'pending host change disabled');
  await click('[data-action="toggle-host"]');
  assert.equal(calls.filter(c=>c.action==='remote'&&c.data.action==='disable').length,1);
  assert.equal(incomingEnabled,true);
  incomingMutation.resolve();incomingMutation=null;
  await wait(()=>evaluate('document.querySelector("[data-action=toggle-host]").getAttribute("aria-checked")==="false"'),'host disable saved');
  assert.equal(state.config.discoveryEnabled,true);
  await click('[data-page="devices"]');await click('[data-page="settings"]');
  assert.equal(await evaluate('document.querySelector("[data-action=toggle-host]").getAttribute("aria-checked")'),'false');
  await click('[data-action="toggle-host"]');await wait(()=>incomingEnabled,'host enabled');
  incomingFailure=true;windows.refresh();
  await wait(()=>evaluate('document.querySelector("#page").innerText.includes("Service unavailable")'),'host read failure visible');
  assert.equal(await evaluate('document.querySelector("[data-action=toggle-host]").disabled'),true);
  incomingFailure=false;windows.refresh();await wait(()=>evaluate('!document.querySelector("[data-action=toggle-host]").disabled'),'host status recovers');
  assert.equal(await evaluate('document.querySelector("[data-action=toggle-host]").getAttribute("aria-checked")'),'true');
  record('allow-connections uses host service state, persists off, prevents duplicate changes and recovers from read failure');
  assert.equal(await evaluate('document.querySelector("[data-setting=discoveryEnabled]").getAttribute("aria-label")'),'允许被发现');
  await click('[data-setting="discoveryEnabled"]');await wait(()=>!state.config.discoveryEnabled,'discoverability saved');
  await click('[data-page="remote"]');
  const scanCount=calls.filter(c=>c.action==='discover').length;
  discovery=deferred();await click('[data-action="connect-new"]');await wait(()=>calls.filter(c=>c.action==='discover').length>scanCount,'add computer starts scanning while hidden');
  await click('[data-action="manual"]');discovery.resolve([{Id:'stale',Name:'Stale scan',Address:'192.0.2.42',Platform:'windows',Port:47632}]);discovery=null;await sleep(150);
  assert.equal(await evaluate('document.querySelector("#modal-title").textContent'),'手动添加电脑');
  assert.equal(await evaluate('!!document.querySelector("#peer-form")'),true);await click('[data-action="dismiss"]');
  record('discoverability is visible in general settings; hidden computers can still scan; late scan cannot replace manual entry');
  const existingTargets=state.config.peers.map(p=>[p.id,p.enabled]);
  state.config.deviceId='local';discovery=deferred();const resultScanCount=calls.filter(c=>c.action==='discover').length;await click('[data-action="connect-new"]');
  await wait(()=>calls.filter(c=>c.action==='discover').length>resultScanCount,'computer scan requested');
  discovery.resolve([
    {Id:'local',Name:'This computer',Address:'192.168.1.9',Port:47632,Platform:'windows'},
    {Id:'phone',Name:'OnePlus 12',Address:'192.168.1.8',Port:47632,Platform:'android'},
    {Id:'pc',Name:'Renamed PC',Address:'127.0.0.1',Port:47632,Platform:'windows'},
    {Id:'new-mac',Name:'MacBook <studio>',Address:'127.0.0.1',Port:47981,Platform:'macos'},
    {Id:'new-mac',Name:'MacBook duplicate',Address:'127.0.0.1',Port:47981,Platform:'macos'}
  ]);discovery=null;
  await wait(()=>evaluate('document.querySelectorAll(".found-device").length===2'),'only unique nearby computers');
  assert.equal(await evaluate('document.querySelectorAll("[data-action=add-found]:disabled").length'),1);
  assert.doesNotMatch(await evaluate('document.querySelector("dialog").innerText'),/OnePlus|This computer|duplicate/);
  assert.equal(await evaluate('document.querySelectorAll(".found-device studio").length'),0);
  await sleep(120);fs.writeFileSync(path.join(output,'computer-discovery.png'),(await center.webContents.capturePage()).toPNG());
  await click('[data-action="add-found"]:not(:disabled)');await wait(()=>state.config.peers.length===3,'discovered computer saved');
  assert.deepEqual(state.config.peers.slice(0,2).map(p=>[p.id,p.enabled]),existingTargets);
  assert.equal(state.config.peers[2].platform,'macos');assert.equal(state.config.peers[2].address,'127.0.0.1');assert.equal(state.config.peers[2].enabled,false);
  record('computer scan filters phone/self/duplicates, marks saved computers, preserves metadata and clipboard targets');
  await click('[data-action="connect-new"]');await wait(()=>evaluate('document.querySelector("dialog").innerText.includes("暂未发现电脑")'),'empty scan guidance');
  await click('[data-action="dismiss"]');
  await click('[data-page="settings"]');await evaluate('document.querySelector("#device-name").focus();document.querySelector("#device-name").value="我的工作电脑"');
  windows.refresh();await sleep(200);assert.equal(await evaluate('document.querySelector("#device-name").value'),'我的工作电脑');
  await evaluate('document.querySelector("#device-name").blur()');await wait(()=>state.config.deviceName==='我的工作电脑','name auto save');
  await click('[data-setting="notifications"]');await wait(()=>!state.config.notifications,'preference saved');
  await evaluate('const select=document.querySelector("#appearance");select.value="dark";select.dispatchEvent(new Event("change",{bubbles:true}));select.blur()');
  assert.equal(await evaluate('document.body.classList.contains("dark")'),true);record('polling preserves editing, settings save, dark theme');
  await click('[data-tab="advanced"]');await evaluate('document.querySelectorAll("details")[1].open=true;const port=document.querySelector("#listen-port");port.focus();port.value="0"');
  center.close();await wait(()=>evaluate('document.querySelector(".toast").textContent.includes("65535")'),'invalid port feedback');assert.equal(center.isDestroyed(),false);assert.equal(state.config.port,47632);
  await evaluate('document.querySelector("#listen-port").value="47632";document.querySelector("#listen-port").blur()');record('invalid port cannot silently close or save');
  await click('[data-page="devices"]');await click('[data-action="detail"][data-id="pc"]');await click('[data-action="edit"]');
  await evaluate('document.querySelector("#peer-form [name=name]").value="<img src=x onerror=alert(1)>"');await click('[data-action="peer-save"]');await wait(()=>evaluate('!document.querySelector("dialog").open'),'peer saved');assert.equal(state.config.peers[0].platform,'windows');assert.equal(await evaluate('document.querySelectorAll(".clipboard-device-row img").length'),0);record('device edits preserve metadata and escape remote content');
  state.config.peers.push({...peer('tablet','验收平板','android'),enabled:false});state.revision++;clipboardUnavailable=false;windows.refresh();await wait(()=>evaluate('document.querySelectorAll(".clipboard-device-row").length===4'),'all four devices are horizontal rows');
  await click('[data-action="probe"]');await wait(()=>evaluate('document.body.innerText.includes("1/4 台设备接收可用")'),'all four device statuses');
  const bounds=await evaluate('[...document.querySelectorAll(".clipboard-device-row")].map(n=>({id:n.dataset.deviceId,width:n.clientWidth,height:n.clientHeight,top:n.getBoundingClientRect().top}))');
  assert.deepEqual(bounds.map(n=>n.id),state.config.peers.map(p=>p.id));assert.equal(bounds.every(n=>n.height<110&&n.width>500),true);
  await sleep(120);fs.writeFileSync(path.join(output,'four-device-rows.png'),(await center.webContents.capturePage()).toPNG());record('online and unavailable devices use equal horizontal rows in saved order');
  center.setSize(540,720);await sleep(150);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  fs.writeFileSync(path.join(output,'narrow.png'),(await center.webContents.capturePage()).toPNG());record('narrow desktop layout has no horizontal overflow');
  const remoteState={hosts:[{id:'host1',name:'我的电脑',address:'192.168.1.20',port:48789,enabled:true,selected:true}],status:'connected',pairing:{state:'idle'},viewer:{available:true,phase:'idle'},desktopOnly:true,launchTarget:{address:'192.168.1.20',port:48789,label:'我的电脑',nonce:'test-launch'}};
  const remoteCalls=[];
  ipcMain.handle('mac:request',(_event,action,data)=>{
    remoteCalls.push({action,data});
    if(action==='viewer-open')remoteState.viewer.phase='running';
    if(action==='viewer-stop')remoteState.viewer.phase='idle';
    return structuredClone(remoteState);
  });
  const remote=new BrowserWindow({width:920,height:754,show:false,webPreferences:{preload:path.resolve(__dirname,'../electron/mac/preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  await remote.loadFile(path.resolve(__dirname,'../electron/mac/ui.html'),{query:{kind:'paired'}});
  await wait(()=>remoteCalls.some(c=>c.action==='viewer-open'),'direct remote target connects');
  assert.doesNotMatch(await remote.webContents.executeJavaScript('document.body.innerText'),/发送当前剪贴板|允许设备连接|共享本机屏幕/);
  assert.equal(remoteCalls.find(c=>c.action==='paired-select').data.id,'host1');
  fs.writeFileSync(path.join(output,'remote-session.png'),(await remote.webContents.capturePage()).toPNG());
  record('real remote renderer consumes target and opens viewer without manual sending or approval UI');remote.destroy();ipcMain.removeHandler('mac:request');
  await click('[data-page="remote"]');
  windows.directory.devices=[{id:'b'.repeat(24),deviceId:'not-added',name:'Unadded public PC',platform:'windows',connectable:true}];windows.refresh();await sleep(150);
  assert.equal(await evaluate(`!!document.querySelector('[data-device-id="directory:bbbbbbbbbbbbbbbbbbbbbbbb"]')`),false);
  await wait(()=>evaluate('!document.querySelector("[data-action=remote-probe]").disabled'),'initial remote check finished');
  await click('[data-action="remote-probe"]');await wait(()=>evaluate('!document.querySelector("[data-action=remote-probe]").disabled'),'saved computer probe');
  assert.equal(state.config.peers.length,4);record('refresh and detection never add public computers');
  await click('[data-action="connect-new"]');await wait(()=>evaluate('!!document.querySelector("[data-action=code-add]")'),'code entry in LAN scan');
  await click('[data-action="code-add"]');await evaluate('document.querySelector("#code-form input").value="00000000"');await click('[data-action="code-submit"]');
  await wait(()=>evaluate('!!document.querySelector("[data-action=code-add]")'),'wrong code feedback and retry');assert.equal(networkHosts.length,0);
  await click('[data-action="code-add"]');await evaluate('document.querySelector("#code-form input").value="12345678"');await click('[data-action="code-submit"]');
  await wait(()=>evaluate(`!!document.querySelector('[data-device-id="network:aaaaaaaaaaaaaaaaaaaaaaaa"]')`),'code paired saved card');
  await wait(()=>evaluate(`!document.querySelector('[data-id="network:aaaaaaaaaaaaaaaaaaaaaaaa"][data-action=connect]').disabled`),'paired route actually probed');
  await click('[data-action="connect"][data-id="network:aaaaaaaaaaaaaaaaaaaaaaaa"]');assert.equal(target.networkId,'a'.repeat(24));assert.equal(target.deviceCode,undefined);await click('[data-action="remote-stop"]');
  await wait(()=>evaluate('!document.querySelector("[data-action=remote-probe]").disabled'),'connection stopped');
  networkOnline=false;await click('[data-action="remote-probe"]');await wait(()=>evaluate(`document.querySelector('[data-id="network:aaaaaaaaaaaaaaaaaaaaaaaa"][data-action=connect]').disabled`),'offline saved card disabled');
  assert.equal(await evaluate(`!!document.querySelector('[data-device-id="network:aaaaaaaaaaaaaaaaaaaaaaaa"]')`),true);
  assert.equal(JSON.stringify(state.config).includes('12345678'),false);
  record('external computer requires correct device code; saved authorization reconnects without code and remains listed offline');
  await click('[data-page="settings"]');await click('[data-tab="general"]');await wait(()=>evaluate('!!document.querySelector("[data-action=toggle-code-policy]")'),'code policy');
  await click('[data-action="toggle-code-policy"]');await wait(()=>codeRequired,'required code saved');
  await click('[data-page="remote"]');await click('[data-page="settings"]');
  assert.equal(await evaluate('document.querySelector("[data-action=toggle-code-policy]").getAttribute("aria-checked")'),'true');
  record('device code and first-pairing requirement are available in settings');
  const rotations=()=>calls.filter(c=>c.action==='remote'&&c.data.action==='deviceCodeRotate').length;
  await click('[data-action="rotate-device-code"]');await click('dialog [data-action="dismiss"]');assert.equal(rotations(),0);
  await click('[data-action="rotate-device-code"]');codeFailure=true;
  await click('[data-action="confirm-device-code"]');await wait(()=>evaluate('document.querySelector(".modal-error").textContent.includes("Network unavailable")'),'rotation failure');
  assert.equal(deviceCode,'12345678');await click('dialog [data-action="dismiss"]');codeFailure=false;
  await wait(()=>evaluate('!document.querySelector("[data-action=rotate-device-code]").disabled'),'rotation retry ready');
  session={phase:'running',peerId:'network:'+ 'a'.repeat(24),error:''};
  const beforeRotation=JSON.stringify({session,networkHosts,config:state.config,incomingEnabled,codeRequired});
  await click('[data-action="rotate-device-code"]');codeUpdate=deferred();
  await click('[data-action="confirm-device-code"]');await wait(()=>rotations()===2,'rotation submitted');
  assert.equal(await evaluate('document.querySelector("[data-action=confirm-device-code]").disabled'),true);
  await click('[data-action="confirm-device-code"]');assert.equal(rotations(),2);
  codeUpdate.resolve();codeUpdate=null;
  await wait(()=>evaluate('document.querySelector("#device-code").textContent==="87654321"&&!document.querySelector("dialog").open'),'new device code visible');
  assert.equal(JSON.stringify({session,networkHosts,config:state.config,incomingEnabled,codeRequired}),beforeRotation);
  assert.equal(await evaluate('document.querySelector("[data-action=rotate-device-code]").disabled'),false);
  center.setSize(560,700);await new Promise(r=>setTimeout(r,100));
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  record('device code rotation confirms, handles errors, prevents duplicate requests and preserves existing sessions and pairings');
  windows.close();remoteServer.close();app.quit();
}).catch(async error=>{fs.writeFileSync(path.join(output,'failure.txt'),error.stack);if(center&&!center.isDestroyed()){fs.writeFileSync(path.join(output,'failure-dialog.html'),await evaluate('document.querySelector("dialog").outerHTML'));fs.writeFileSync(path.join(output,'failure-calls.json'),JSON.stringify(calls.slice(-15),null,2));}remoteServer?.close();windows?.close();app.exit(1);});
