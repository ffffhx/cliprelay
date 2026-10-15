'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {pathToFileURL}=require('node:url');
function fixture(){
  const handlers=new Map();let viewer,controller,network,files;
  class Window extends EventEmitter{
    constructor(options){super();this.options=options;this.webContents=new EventEmitter();this.webContents.mainFrame={url:''};this.webContents.setWindowOpenHandler=()=>{};}
    loadFile(page){this.webContents.mainFrame.url=pathToFileURL(page).href+'?kind=paired';}
    isDestroyed(){return false;}show(){}focus(){}destroy(){this.emit('closed');}close(){this.emit('closed');}
  }
  const electron={app:{getPath:()=>'.'},BrowserWindow:Window,ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},clipboard:{},nativeImage:{},safeStorage:{}};
  class Controller{constructor(options){controller=this;this.store=options.store;this.pairs=0;}start(){}snapshot(){return {hosts:[],pairing:{state:'idle'}};}startPair(){this.pairs++;}cancelPair(){}close(){}reconcileRoutes(){} }
  class Network{constructor(){network=this;this.claims=0;this.cancelled=0;}snapshot(){return {available:true,computers:[],pairing:{state:'idle'}};}claim(){this.claims++;}reconcile(){}route(){return null;}cancelPair(){this.cancelled++;}close(){this.closed=true;}}
  class Viewer{constructor(){viewer=this;this.opens=0;}snapshot(){return {available:true,phase:'idle'};}async open(){this.opens++;}stop(){}reconcile(){}}
  class Files{constructor(){files=this;this.actions=[];}snapshot(){return {tasks:[]};}reconcile(){}releaseWindow(){}close(){this.closed=true;}async action(action,data,window){this.actions.push({action,data,window});}}
  const filename=path.resolve(__dirname,'../electron/desktop-client.cjs'),module={exports:{}};
  const imports={electron,'./mac/paired-store.cjs':{PairedStore:class{hosts(){return [];}}},'./mac/paired-controller.cjs':{PairedController:Controller,message:()=> 'Operation failed'},'./mac/client-identity.cjs':{createClientIdentity:()=>{}},'./mac/stream-viewer.cjs':{StreamViewer:Viewer},'./mac/network-catalog.cjs':{NetworkCatalog:class{}},'./mac/network-controller.cjs':{NetworkController:Network},'./mac/routed-store.cjs':{RoutedStore:class{constructor(base){return base;}}}};
  imports['./mac/file-controller.cjs']={FileController:Files,message:()=> 'File operation failed'};
  imports['./mac/terminal-window.cjs']={DesktopTerminal:class{open(){this.opened=true;}reconcile(){}close(){}}};
  imports['./mac/bitrate-controller.cjs']={BitrateController:class{constructor(){this.actions=[];}snapshot(){return {phase:'idle'};}reconcile(){}close(){this.closed=true;}apply(data){this.actions.push(data);}},message:()=> 'Bitrate operation failed'};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{__dirname:path.dirname(filename),module,require:name=>imports[name] || require(name),Buffer},{filename});
  const client=new module.exports.DesktopClient('.');client.open();const event={sender:client.window.webContents,senderFrame:client.window.webContents.mainFrame};
  return {client,event,viewer,controller,network,files,handlers};
}
test('only the owned top-level pairing page can open a viewer or change pairings',async()=>{
  const f=fixture();const state=await f.client.request(f.event,'initial');assert.equal(state.desktopOnly,true);assert.ok(!JSON.stringify(state).includes('PRIVATE'));
  await f.client.request(f.event,'viewer-open');assert.equal(f.viewer.opens,1);
  await assert.rejects(f.client.request({...f.event,senderFrame:{}},'viewer-open'),/Unknown renderer/);
  await assert.rejects(f.client.request({...f.event,sender:{}},'pair-start',{}),/Unknown renderer/);assert.equal(f.controller.pairs,0);
  await f.client.request(f.event,'network-claim',{code:'12345678'});assert.equal(f.network.claims,1);
  await assert.rejects(f.client.request({...f.event,senderFrame:{}},'network-claim',{code:'12345678'}),/Unknown renderer/);assert.equal(f.network.claims,1);
  f.network.pairAbort={};await assert.rejects(f.client.request(f.event,'pair-start',{}),/Operation failed/);assert.equal(f.controller.pairs,0);
  await assert.rejects(f.client.request(f.event,'network-claim',{code:'x'.repeat(33000)}),/Invalid request/);
  await f.client.request(f.event,'files-upload');assert.equal(f.files.actions.length,1);assert.equal(f.files.actions[0].window,f.client.window);
  await assert.rejects(f.client.request({...f.event,senderFrame:{}},'files-upload'),/Unknown renderer/);assert.equal(f.files.actions.length,1);
  await assert.rejects(f.client.request({...f.event,sender:{}},'files-cancel',{id:'x'}),/Unknown renderer/);assert.equal(f.files.actions.length,1);
  await f.client.request(f.event,'terminal-open');assert.equal(f.client.terminal.opened,true);
  await f.client.request(f.event,'bitrate-apply',{budgetKbps:6000});assert.equal(f.client.bitrate.actions.length,1);
  await assert.rejects(f.client.request({...f.event,senderFrame:{}},'bitrate-apply',{budgetKbps:6000}),/Unknown renderer/);assert.equal(f.client.bitrate.actions.length,1);
  await assert.rejects(f.client.request({...f.event,senderFrame:{}},'terminal-open'),/Unknown renderer/);
  assert.equal(f.client.window.options.webPreferences.sandbox,true);assert.equal(f.client.window.options.webPreferences.nodeIntegration,false);
  f.client.close();assert.equal(f.handlers.size,0);assert.equal(f.network.closed,true);assert.equal(f.network.cancelled,1);assert.equal(f.files.closed,true);
});
