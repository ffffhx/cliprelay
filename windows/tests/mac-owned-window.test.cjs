'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');const {pathToFileURL}=require('node:url');
async function fixture(){
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
  const electron={app,Tray:class{setTitle(){}setContextMenu(items){menuItems=items;}},Menu:{buildFromTemplate:items=>items},nativeImage:{createEmpty:()=>({})},globalShortcut:{register:(_,fn)=>{hotkey=fn;}},clipboard:{},Notification:class{show(){}},BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},screen:{getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1200,height:800}})},systemPreferences:{isTrustedAccessibilityClient(){}},safeStorage:{},dialog:{showErrorBox:(_,message)=>assert.fail(message)}};
  const receiver=new EventEmitter();receiver.listen=(_,cb)=>cb();receiver.listening=true;
  const filename=path.resolve(__dirname,'../electron/mac/main.cjs');
  const imports={'./stream-viewer.cjs':{StreamViewer:class{snapshot(){return {available:false,phase:'idle'};}reconcile(){}stop(){}async open(){throw new Error('VIEWER_UNAVAILABLE');}}},electron,'bonjour-service':{Bonjour},'./config.cjs':{loadConfig:()=>({peer:'legacy.local',peerPort:47632,legacyEnabled:true,deviceName:'Mac',discoveryEnabled:false}),saveConfig(){}},'./relay.cjs':{sendSelection:async()=>{legacySends++;},createReceiver:()=>receiver,discoveredPeer(){}},'./paired-store.cjs':{PairedStore:Store},'./paired-controller.cjs':{PairedController:Controller,message:()=> 'fixture connection failed'},'node:child_process':{execFile(){},execFileSync:()=> 'Mac'}};
  Object.assign(imports,{'./network-catalog.cjs':{NetworkCatalog:class{}},'./network-controller.cjs':{NetworkController:Network},'./routed-store.cjs':{RoutedStore:class{constructor(base){return base;}}},'./client-identity.cjs':{createClientIdentity:()=>{}}});
  const fileActions=[];imports['./file-controller.cjs']={FileController:class{snapshot(){return {tasks:[]};}reconcile(){}releaseWindow(){}close(){}async action(action,data,window){fileActions.push({action,data,window});}},message:()=> 'File operation failed'};
  imports['./terminal-window.cjs']={DesktopTerminal:class{open(){}reconcile(){}close(){}}};
  const bitrateActions=[];imports['./bitrate-controller.cjs']={BitrateController:class{snapshot(){return {phase:'idle'};}reconcile(){}close(){}apply(data){bitrateActions.push(data);}},message:()=> 'Bitrate operation failed'};
  const displayActions=[],inputActions=[];imports['./display-controller.cjs']={DisplayController:class{snapshot(){return {phase:'idle'};}reconcile(){}close(){}apply(data){displayActions.push(data);}setInput(data){inputActions.push(data);}},message:()=> 'Display operation failed'};
  const privacyActions=[];imports['./privacy-controller.cjs']={PrivacyController:class{snapshot(){return {phase:'idle'};}reconcile(){}close(){}setEnabled(data){privacyActions.push(data);}},message:()=> 'Privacy operation failed'};
  const audioActions=[];imports['./audio-mute-controller.cjs']={AudioMuteController:class{snapshot(){return {phase:'idle'};}reconcile(){}close(){}setEnabled(data){audioActions.push(data);}},message:()=> 'Audio mute operation failed'};
  const lockActions=[];imports['./session-lock-controller.cjs']={SessionLockController:class{snapshot(){return {phase:'idle'};}reconcile(){}close(){}setEnabled(data){lockActions.push(data);}},message:()=> 'Audio mute operation failed'};
  const wakeActions=[];imports['./wake-controller.cjs']={WakeController:class{snapshot(){return {phase:'idle'};}reconcile(){}close(){}action(action,data){wakeActions.push(data);}},message:()=> 'Wake operation failed'};
  const hostActions=[];let hostOwner;imports['./host-permission-controller.cjs']={HostPermissionController:class{constructor(){hostOwner=this;this.releases=0;this.closes=0;this.stop=Promise.resolve();}snapshot(){return {available:true,screenRecording:null,inputControl:null};}async action(action,data){hostActions.push({action,data});return this.snapshot();}releaseWindow(){this.releases++;return this.stop;}close(){this.closes++;return this.stop;}},message:()=> 'Permission operation failed'};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{__dirname:path.dirname(filename),require:name=>imports[name] || require(name),setTimeout:()=>0,Buffer,URLSearchParams},{filename});await ready;
  return {request:handlers.get('mac:request'),open:()=>{menuItems.find(item=>item.label==='配对电脑与安全收发…').click();return windows.at(-1);},openPermissions:()=>{menuItems.find(item=>item.label==='本机远程访问权限…').click();return windows.at(-1);},event:window=>({sender:window.webContents,senderFrame:window.webContents.mainFrame}),hotkey,get legacySends(){return legacySends;},get encryptedSends(){return encryptedSends;},get quits(){return quits;},controller,windows,fileActions,bitrateActions,displayActions,inputActions,privacyActions,audioActions,lockActions,wakeActions,hostActions,hostOwner,appEvents};
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
