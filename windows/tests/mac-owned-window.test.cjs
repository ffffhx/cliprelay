'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');const {pathToFileURL}=require('node:url');
async function fixture({autoStart=false}={}){
  let ready,menuItems,hotkey,legacySends=0,encryptedSends=0,controller,network,quits=0;const handlers=new Map(),windows=[],appEvents=new Map();
  class Window extends EventEmitter{
    constructor(){super();this.webContents=new EventEmitter();this.webContents.id=windows.length+1;this.webContents.mainFrame={};this.webContents.setWindowOpenHandler=()=>{};windows.push(this);}
    loadFile(file,options){this.webContents.mainFrame.url=pathToFileURL(file).href+'?'+new URLSearchParams(options.query);}
    show(){}focus(){}showInactive(){}isDestroyed(){return false;}close(){this.emit('closed');}
  }
  const app={setName(){},setPath(){},getPath:()=>'/fixture',requestSingleInstanceLock:()=>true,on:(name,fn)=>appEvents.set(name,fn),quit(){quits++;},isReady:()=>true,dock:{hide(){}},whenReady:()=>({then:fn=>{ready=fn();return {catch:cb=>{ready=ready.catch(cb);}};}})};
  class Store{constructor(){this.data={legacySelected:false};}selected(){return {id:'paired',name:'PC',enabled:true};}hosts(){return [this.selected()];}}
  class Network{constructor(){network=this;this.claims=0;}snapshot(){return {available:true,computers:[],pairing:{state:'idle'}};}claim(){this.claims++;}reconcile(){}route(){return null;}cancelPair(){}close(){}}
  class Controller{constructor(options){controller=this;this.store=options.store;this.status='connected';this.started=0;}start(){}snapshot(){return {hosts:[{id:'paired',name:'PC'}],status:'connected',pairing:{state:'idle'}};}startPair(){this.started++;return this.snapshot();}sendCurrent(){encryptedSends++;return Promise.reject(Object.assign(new Error('fixture changed certificate'),{code:'HOST_CERT_CHANGED'}));}cancelPair(){}close(){}reconcileRoutes(){}}
  class Bonjour{publish(){const service=new EventEmitter();service.stop=()=>{};return service;}destroy(){}}
  Controller.prototype.withClipboard=operation=>Promise.resolve().then(operation);
  const notifications=[],accessibility=[],savedConfigs=[];let trayTitle;
  class Notification extends EventEmitter{static isSupported(){return true;}constructor(options){super();this.options=options;}show(){notifications.push(this);}close(){this.emit('close');}}
  const electron={app,Tray:class{setTitle(value){trayTitle=value;}setContextMenu(items){menuItems=items;}},Menu:{buildFromTemplate:items=>items},nativeImage:{createEmpty:()=>({})},globalShortcut:{register:(_,fn)=>{hotkey=fn;}},clipboard:{},Notification,BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},screen:{getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1200,height:800}})},systemPreferences:{isTrustedAccessibilityClient(value){accessibility.push(value);}},safeStorage:{},dialog:{showErrorBox:(_,message)=>assert.fail(message)}};
  const receiver=new EventEmitter();receiver.listen=(_,cb)=>cb();receiver.listening=true;
  const filename=path.resolve(__dirname,'../electron/mac/main.cjs');
  const imports={'./stream-viewer.cjs':{StreamViewer:class{snapshot(){return {available:false,phase:'idle'};}reconcile(){}stop(){}async open(){throw new Error('VIEWER_UNAVAILABLE');}}},electron,'bonjour-service':{Bonjour},'./config.cjs':{loadConfig:()=>({peer:'legacy.local',peerPort:47632,legacyEnabled:true,deviceName:'Mac',discoveryEnabled:false,hostAutoStart:autoStart}),saveConfig:(_directory,value)=>savedConfigs.push(value)},'./relay.cjs':{sendSelection:async()=>{legacySends++;},createReceiver:()=>receiver,discoveredPeer(){}},'./paired-store.cjs':{PairedStore:Store},'./paired-controller.cjs':{PairedController:Controller,message:()=> 'fixture connection failed'},'node:child_process':{execFile(){},execFileSync:()=> 'Mac'},'./host-notices.cjs':require('../electron/mac/host-notices.cjs')};
  Object.assign(imports,{'./network-catalog.cjs':{NetworkCatalog:class{}},'./network-controller.cjs':{NetworkController:Network},'./routed-store.cjs':{RoutedStore:class{constructor(base){return base;}}},'./client-identity.cjs':{createClientIdentity:()=>{}}});
  const fileActions=[];imports['./file-controller.cjs']={FileController:class{snapshot(){return {tasks:[]};}reconcile(){}releaseWindow(){}close(){}async action(action,data,window){fileActions.push({action,data,window});}},message:()=> 'File operation failed'};
  imports['./terminal-window.cjs']={DesktopTerminal:class{open(){}reconcile(){}close(){}}};
  const clipboardActions=[];let clipboardCancels=0,clipboardAuthorized;
  imports['./clipboard-sync.cjs']={ClipboardSync:class{snapshot(){return {phase:'off'};}reconcile(){}close(){}cancelReceive(){clipboardCancels++;}externalApplied(){}setEnabled(data){clipboardActions.push(['set',data]);}resume(data){clipboardActions.push(['resume',data]);}async receive(data,authorized){assert.ok(authorized());clipboardAuthorized=authorized;clipboardActions.push(['receive',data]);}},message:()=> 'Clipboard operation failed'};
  const bitrateActions=[];imports['./bitrate-controller.cjs']={BitrateController:class{snapshot(){return {phase:'idle'};}reconcile(){}close(){}apply(data){bitrateActions.push(data);}},message:()=> 'Bitrate operation failed'};
  const displayActions=[],inputActions=[];imports['./display-controller.cjs']={DisplayController:class{snapshot(){return {phase:'idle'};}reconcile(){}close(){}apply(data){displayActions.push(data);}setInput(data){inputActions.push(data);}},message:()=> 'Display operation failed'};
  const privacyActions=[];imports['./privacy-controller.cjs']={PrivacyController:class{snapshot(){return {phase:'idle'};}reconcile(){}close(){}setEnabled(data){privacyActions.push(data);}},message:()=> 'Privacy operation failed'};
  const audioActions=[];imports['./audio-mute-controller.cjs']={AudioMuteController:class{snapshot(){return {phase:'idle'};}reconcile(){}close(){}setEnabled(data){audioActions.push(data);}},message:()=> 'Audio mute operation failed'};
  const lockActions=[];imports['./session-lock-controller.cjs']={SessionLockController:class{snapshot(){return {phase:'idle'};}reconcile(){}close(){}setEnabled(data){lockActions.push(data);}},message:()=> 'Audio mute operation failed'};
  const wakeActions=[];imports['./wake-controller.cjs']={WakeController:class{snapshot(){return {phase:'idle'};}reconcile(){}close(){}action(action,data){wakeActions.push(data);}},message:()=> 'Wake operation failed'};
  const hostActions=[];let hostOwner;imports['./host-permission-controller.cjs']={HostPermissionController:class{constructor(){hostOwner=this;this.releases=0;this.closes=0;this.stop=Promise.resolve();}snapshot(){return {available:true,screenRecording:null,inputControl:null};}async action(action,data){hostActions.push({action,data});return this.snapshot();}releaseWindow(){this.releases++;return this.stop;}close(){this.closes++;return this.stop;}},message:()=> 'Permission operation failed'};
  const hostingActions=[];let hostingOwner;imports['./host-controller.cjs']={HostController:class{constructor(options){hostingOwner=this;this.options=options;this.releases=0;this.closes=0;this.launches=0;this.state={available:true,phase:'idle',requests:[],nativeWorkers:false};}snapshot(){return this.state;}emit(value){this.state={...this.state,...value};this.options.onUpdate(this.state);}async launch(){this.launches++;}async action(action,data){hostingActions.push({action,data});return this.snapshot();}releaseWindow(){this.releases++;}async close(){this.closes++;}},message:()=> 'Hosting operation failed'};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{__dirname:path.dirname(filename),require:name=>imports[name] || require(name),setTimeout:()=>0,Buffer,URLSearchParams},{filename});await ready;
  return {request:handlers.get('mac:request'),open:()=>{menuItems.find(item=>item.label==='配对电脑与安全收发…').click();return windows.at(-1);},openPermissions:()=>{menuItems.find(item=>item.label==='本机远程访问权限…').click();return windows.at(-1);},openHost:()=>{menuItems.find(item=>item.label==='允许其他设备连接这台 Mac…').click();return windows.at(-1);},event:window=>({sender:window.webContents,senderFrame:window.webContents.mainFrame}),hotkey,get legacySends(){return legacySends;},get encryptedSends(){return encryptedSends;},get quits(){return quits;},get trayTitle(){return trayTitle;},clipboardActions,get clipboardCancels(){return clipboardCancels;},get clipboardAuthorized(){return clipboardAuthorized;},controller,windows,fileActions,bitrateActions,displayActions,inputActions,privacyActions,audioActions,lockActions,wakeActions,hostActions,hostOwner,hostingActions,hostingOwner,appEvents,notifications,accessibility,savedConfigs};
}
test('Mac pairing IPC is restricted to its owned top-level window and never returns key material',async()=>{
  const f=await fixture(),window=f.open(),event=f.event(window);
  const snapshot=await f.request(event,'paired-status');assert.equal(snapshot.hosts[0].name,'PC');assert.ok(!JSON.stringify(snapshot).includes('CERTIFICATE'));
  await f.request(event,'privacy-set-enabled',{viewId:'owned',enabled:true});assert.equal(f.privacyActions.length,1);
  await f.request(event,'audio-mute-set-enabled',{viewId:'owned',enabled:true});assert.equal(f.audioActions.length,1);
  await f.request(event,'session-lock-set-enabled',{viewId:'owned',enabled:true});assert.equal(f.lockActions.length,1);
  await f.request(event,'wake-send',{viewId:'owned'});assert.equal(f.wakeActions.length,1);
  await assert.rejects(f.request({...event,senderFrame:{}},'audio-mute-set-enabled',{}),/Unknown renderer/);
  await assert.rejects(f.request({...event,senderFrame:{}},'session-lock-set-enabled',{}),/Unknown renderer/);
  await assert.rejects(f.request({...event,senderFrame:{}},'wake-send',{}),/Unknown renderer/);
  await assert.rejects(f.request({...event,senderFrame:{}},'privacy-set-enabled',{}),/Unknown renderer/);
  await f.request(event,'pair-start',{address:'fixture'});assert.equal(f.controller.started,1);
  await assert.rejects(f.request({...event,senderFrame:{}},'pair-start',{}),/Unknown renderer/);assert.equal(f.controller.started,1);
  await f.request(event,'network-claim',{code:'12345678'});
  await assert.rejects(f.request({...event,senderFrame:{}},'network-claim',{code:'12345678'}),/Unknown renderer/);
  await assert.rejects(f.request(event,'network-claim',{code:'x'.repeat(33000)}),/Invalid request/);
  const alert=f.windows.find(candidate=>candidate.webContents.mainFrame.url.includes('kind=alert'));
  await assert.rejects(f.request(f.event(alert),'privacy-set-enabled',{}),/Unknown action/);assert.equal(f.privacyActions.length,1);
  await assert.rejects(f.request(f.event(alert),'audio-mute-set-enabled',{}),/Unknown action/);assert.equal(f.audioActions.length,1);
  await assert.rejects(f.request(f.event(alert),'session-lock-set-enabled',{}),/Unknown action/);assert.equal(f.lockActions.length,1);
  await assert.rejects(f.request(f.event(alert),'wake-send',{}),/Unknown action/);assert.equal(f.wakeActions.length,1);
  await assert.rejects(f.request(f.event(alert),'pair-start',{}),/Unknown action/);assert.equal(f.controller.started,1);
  await f.request(event,'files-download',{names:['test']});assert.equal(f.fileActions.length,1);assert.equal(f.fileActions[0].window,window);
  await assert.rejects(f.request({...event,senderFrame:{}},'files-upload'),/Unknown renderer/);
  await assert.rejects(f.request(f.event(alert),'files-upload'),/Unknown action/);assert.equal(f.fileActions.length,1);
  await f.request(event,'terminal-open');await assert.rejects(f.request({...event,senderFrame:{}},'terminal-open'),/Unknown renderer/);
  await f.request(event,'bitrate-apply',{budgetKbps:6000});assert.equal(f.bitrateActions.length,1);
  await assert.rejects(f.request({...event,senderFrame:{}},'bitrate-apply',{}),/Unknown renderer/);
  await assert.rejects(f.request(f.event(alert),'bitrate-apply',{}),/Unknown action/);assert.equal(f.bitrateActions.length,1);
  await f.request(event,'display-select',{viewId:'owned',display:'right'});assert.equal(f.displayActions.length,1);
  await assert.rejects(f.request({...event,senderFrame:{}},'display-select',{}),/Unknown renderer/);
  await assert.rejects(f.request(f.event(alert),'display-select',{}),/Unknown action/);assert.equal(f.displayActions.length,1);
  await f.request(event,'input-set-paused',{viewId:'owned',paused:true});assert.equal(f.inputActions.length,1);
  await assert.rejects(f.request({...event,senderFrame:{}},'input-set-paused',{}),/Unknown renderer/);
  await assert.rejects(f.request(f.event(alert),'input-set-paused',{}),/Unknown action/);assert.equal(f.inputActions.length,1);
});
test('Mac clipboard IPC requires its exact paired document and releases manual requests on reload, crash and close',async()=>{
  const f=await fixture(),window=f.open(),event=f.event(window),url=event.senderFrame.url;
  for(const action of ['clipboard-set-enabled','clipboard-resume','clipboard-receive']){
    await f.request(event,action,{viewId:'owned',enabled:true});
    await assert.rejects(f.request({...event,senderFrame:{}},action,{}),/Unknown renderer/);
    event.senderFrame.url=url+'#wrong';await assert.rejects(f.request(event,action,{}));event.senderFrame.url=url;
  }
  assert.deepEqual(f.clipboardActions.map(action=>action[0]),['set','resume','receive']);assert.equal(f.clipboardAuthorized(),true);
  const other=f.openPermissions();await assert.rejects(f.request(f.event(other),'clipboard-receive',{}));
  window.webContents.emit('did-start-loading');window.webContents.emit('render-process-gone');window.close();
  assert.equal(f.clipboardCancels,3);assert.equal(f.clipboardAuthorized(),false);
  await assert.rejects(f.request(event,'clipboard-receive',{}));assert.equal(f.clipboardActions.length,3);
});

test('Mac hotkey never falls back to enabled legacy HTTP after a paired send failure',async()=>{
  const f=await fixture();f.hotkey();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.encryptedSends,1);assert.equal(f.legacySends,0);
});

test('host permission commands belong only to the live owned settings window',async()=>{
  const f=await fixture();assert.equal(f.hostActions.length,0);const window=f.openPermissions(),event=f.event(window);
  const initial=await f.request(event,'initial');assert.equal(initial.screenRecording,null);assert.equal(f.hostActions.length,0);
  await f.request(event,'host-permissions-check');await f.request(event,'host-permissions-request',{permission:'screenRecording'});assert.equal(f.hostActions.length,2);
  await assert.rejects(f.request({...event,senderFrame:{}},'host-permissions-request',{permission:'inputControl'}),/Unknown renderer/);
  const other=f.open();await assert.rejects(f.request(f.event(other),'host-permissions-request',{permission:'inputControl'}));assert.equal(f.hostActions.length,2);
  window.webContents.emit('render-process-gone');assert.equal(f.hostOwner.releases,1);
  await f.request(event,'cancel');assert.equal(f.hostOwner.releases,2);
  await assert.rejects(f.request(event,'host-permissions-check'),/Unknown renderer/);
});

test('application quit waits for its permission child to close and cannot duplicate shutdown',async()=>{
  const f=await fixture();let finish,prevented=0;f.hostOwner.stop=new Promise(resolve=>finish=resolve);const event={preventDefault(){prevented++;}};
  f.appEvents.get('before-quit')(event);f.appEvents.get('before-quit')(event);assert.equal(prevented,2);assert.equal(f.hostOwner.closes,1);assert.equal(f.quits,0);
  finish();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.quits,1);
  f.appEvents.get('before-quit')(event);assert.equal(prevented,2);assert.equal(f.hostOwner.closes,1);
});

test('hosting decisions belong only to the live owned host window; window close keeps hosting alive',async()=>{
  const f=await fixture(),window=f.openHost(),event=f.event(window);
  assert.equal((await f.request(event,'initial')).phase,'idle');assert.equal(f.hostingActions.length,0);
  const data={id:'a'.repeat(32),generation:'b'.repeat(32),verification:'1234 5678 9ABC'};
  for(const action of ['host-start','host-pair-approve','host-pair-reject','host-stop','host-client-revoke','host-set-auto-start']){
    await f.request(event,action,data);
    await assert.rejects(f.request({...event,senderFrame:{}},action,data),/Unknown renderer/);
  }
  assert.equal(f.hostingActions.length,6);assert.deepEqual(f.hostingActions[1],{action:'host-pair-approve',data});
  const other=f.open();await assert.rejects(f.request(f.event(other),'host-pair-approve',data),/fixture connection failed/);
  await assert.rejects(f.request(f.event(other),'host-client-revoke',data),/fixture connection failed/);
  await assert.rejects(f.request(f.event(other),'host-set-auto-start',{enabled:true}),/fixture connection failed/);
  const originalURL=event.senderFrame.url;event.senderFrame.url='https://example.invalid/';
  await assert.rejects(f.request(event,'host-start'),/Unknown renderer/);event.senderFrame.url=originalURL;
  await f.request(event,'host-open-permissions');assert.equal(f.hostingActions.length,6);assert.equal(f.hostActions.length,0);
  assert.ok(f.windows.at(-1).webContents.mainFrame.url.includes('kind=host-permissions'));
  window.webContents.emit('render-process-gone');await f.request(event,'cancel');
  assert.equal(f.hostingOwner.releases,2);assert.equal(f.hostingOwner.closes,0);
  await assert.rejects(f.request(event,'host-pair-approve',data),/Unknown renderer/);assert.equal(f.hostingActions.length,6);
});

test('main startup passes strict opt-in and persists explicit changes without requesting accessibility',async()=>{
  for(const autoStart of [false,true,'true']){
    const f=await fixture({autoStart});assert.equal(f.hostingOwner.options.autoStart,autoStart===true);assert.equal(f.hostingOwner.launches,1);
    assert.deepEqual(f.accessibility,[false]);assert.deepEqual(f.savedConfigs,[]);
    f.hostingOwner.options.saveAutoStart(true);assert.equal(f.savedConfigs[0].hostAutoStart,true);assert.equal(f.savedConfigs[0].peer,'legacy.local');
  }
});
test('background notice opens current owned settings after window close and cannot reopen on quit',async()=>{
  const f=await fixture(),window=f.openHost();window.close();
  f.hostingOwner.emit({phase:'running',requests:[{state:'waiting',expires:Math.floor(Date.now()/1000)+120}],error:null});
  assert.equal(f.trayTitle,'ClipRelay · 1 个待确认');f.hostingOwner.options.onPairingRequest({count:1});assert.equal(f.notifications.length,1);
  const before=f.windows.length;f.notifications[0].emit('click');assert.equal(f.windows.length,before+1);assert.equal(f.hostingActions.length,0);
  assert.ok(f.windows.at(-1).webContents.mainFrame.url.includes('kind=host'));
  f.hostingOwner.emit({requests:[]});assert.equal(f.trayTitle,'ClipRelay');f.notifications[0].emit('click');assert.equal(f.windows.length,before+1);
  f.hostingOwner.emit({requests:[{state:'waiting',expires:Math.floor(Date.now()/1000)+120}]});f.hostingOwner.options.onPairingRequest({count:1});
  f.appEvents.get('before-quit')({preventDefault(){}});f.notifications[1].emit('click');assert.equal(f.windows.length,before+1);
});
