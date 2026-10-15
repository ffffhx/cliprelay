'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');const {pathToFileURL}=require('node:url');
async function fixture(){
  let ready,menuItems,hotkey,legacySends=0,encryptedSends=0,controller;const handlers=new Map(),windows=[];
  class Window extends EventEmitter{
    constructor(){super();this.webContents=new EventEmitter();this.webContents.id=windows.length+1;this.webContents.mainFrame={};this.webContents.setWindowOpenHandler=()=>{};windows.push(this);}
    loadFile(file,options){this.webContents.mainFrame.url=pathToFileURL(file).href+'?'+new URLSearchParams(options.query);}
    show(){}focus(){}showInactive(){}isDestroyed(){return false;}close(){this.emit('closed');}
  }
  const app={setName(){},setPath(){},getPath:()=>'/fixture',requestSingleInstanceLock:()=>true,on(){},isReady:()=>true,dock:{hide(){}},whenReady:()=>({then:fn=>{ready=fn();return {catch:cb=>{ready=ready.catch(cb);}};}})};
  class Store{constructor(){this.data={legacySelected:false};}selected(){return {id:'paired',name:'PC',enabled:true};}}
  class Controller{constructor(options){controller=this;this.store=options.store;this.status='connected';this.started=0;}start(){}snapshot(){return {hosts:[{id:'paired',name:'PC'}],status:'connected',pairing:{state:'idle'}};}startPair(){this.started++;return this.snapshot();}sendCurrent(){encryptedSends++;return Promise.reject(Object.assign(new Error('fixture changed certificate'),{code:'HOST_CERT_CHANGED'}));}cancelPair(){}close(){}}
  class Bonjour{publish(){const service=new EventEmitter();service.stop=()=>{};return service;}destroy(){}}
  const electron={app,Tray:class{setTitle(){}setContextMenu(items){menuItems=items;}},Menu:{buildFromTemplate:items=>items},nativeImage:{createEmpty:()=>({})},globalShortcut:{register:(_,fn)=>{hotkey=fn;}},clipboard:{},Notification:class{show(){}},BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},screen:{getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1200,height:800}})},systemPreferences:{isTrustedAccessibilityClient(){}},safeStorage:{},dialog:{showErrorBox:(_,message)=>assert.fail(message)}};
  const receiver=new EventEmitter();receiver.listen=(_,cb)=>cb();receiver.listening=true;
  const filename=path.resolve(__dirname,'../electron/mac/main.cjs');
  const imports={'./stream-viewer.cjs':{StreamViewer:class{snapshot(){return {available:false,phase:'idle'};}reconcile(){}stop(){}async open(){throw new Error('VIEWER_UNAVAILABLE');}}},electron,'bonjour-service':{Bonjour},'./config.cjs':{loadConfig:()=>({peer:'legacy.local',peerPort:47632,legacyEnabled:true,deviceName:'Mac',discoveryEnabled:false}),saveConfig(){}},'./relay.cjs':{sendSelection:async()=>{legacySends++;},createReceiver:()=>receiver,discoveredPeer(){}},'./paired-store.cjs':{PairedStore:Store},'./paired-controller.cjs':{PairedController:Controller,message:()=> 'fixture connection failed'},'node:child_process':{execFile(){},execFileSync:()=> 'Mac'}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{__dirname:path.dirname(filename),require:name=>imports[name] || require(name),setTimeout:()=>0,Buffer,URLSearchParams},{filename});await ready;
  return {request:handlers.get('mac:request'),open:()=>{menuItems.find(item=>item.label==='配对电脑与安全收发…').click();return windows.at(-1);},event:window=>({sender:window.webContents,senderFrame:window.webContents.mainFrame}),hotkey,get legacySends(){return legacySends;},get encryptedSends(){return encryptedSends;},controller,windows};
}
test('Mac pairing IPC is restricted to its owned top-level window and never returns key material',async()=>{
  const f=await fixture(),window=f.open(),event=f.event(window);
  const snapshot=await f.request(event,'paired-status');assert.equal(snapshot.hosts[0].name,'PC');assert.ok(!JSON.stringify(snapshot).includes('CERTIFICATE'));
  await f.request(event,'pair-start',{address:'fixture'});assert.equal(f.controller.started,1);
  await assert.rejects(f.request({...event,senderFrame:{}},'pair-start',{}),/Unknown renderer/);assert.equal(f.controller.started,1);
  const alert=f.windows.find(candidate=>candidate.webContents.mainFrame.url.includes('kind=alert'));
  await assert.rejects(f.request(f.event(alert),'pair-start',{}),/Unknown action/);assert.equal(f.controller.started,1);
});
test('Mac hotkey never falls back to enabled legacy HTTP after a paired send failure',async()=>{
  const f=await fixture();f.hotkey();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.encryptedSends,1);assert.equal(f.legacySends,0);
});
