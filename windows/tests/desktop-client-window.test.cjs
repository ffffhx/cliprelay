'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {pathToFileURL}=require('node:url');
function fixture(){
  const handlers=new Map();let viewer,controller;
  class Window extends EventEmitter{
    constructor(options){super();this.options=options;this.webContents=new EventEmitter();this.webContents.mainFrame={url:''};this.webContents.setWindowOpenHandler=()=>{};}
    loadFile(page){this.webContents.mainFrame.url=pathToFileURL(page).href+'?kind=paired';}
    isDestroyed(){return false;}show(){}focus(){}destroy(){this.emit('closed');}close(){this.emit('closed');}
  }
  const electron={app:{getPath:()=>'.'},BrowserWindow:Window,ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},clipboard:{},nativeImage:{},safeStorage:{}};
  class Controller{constructor(){controller=this;this.pairs=0;}start(){}snapshot(){return {hosts:[],pairing:{state:'idle'}};}startPair(){this.pairs++;}cancelPair(){}close(){} }
  class Viewer{constructor(){viewer=this;this.opens=0;}snapshot(){return {available:true,phase:'idle'};}async open(){this.opens++;}stop(){}reconcile(){}}
  const filename=path.resolve(__dirname,'../electron/desktop-client.cjs'),module={exports:{}};
  const imports={electron,'./mac/paired-store.cjs':{PairedStore:class{}},'./mac/paired-controller.cjs':{PairedController:Controller,message:()=> 'Operation failed'},'./mac/client-identity.cjs':{createClientIdentity:()=>{}},'./mac/stream-viewer.cjs':{StreamViewer:Viewer}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{__dirname:path.dirname(filename),module,require:name=>imports[name] || require(name),Buffer},{filename});
  const client=new module.exports.DesktopClient('.');client.open();const event={sender:client.window.webContents,senderFrame:client.window.webContents.mainFrame};
  return {client,event,viewer,controller,handlers};
}
test('only the owned top-level pairing page can open a viewer or change pairings',async()=>{
  const f=fixture();const state=await f.client.request(f.event,'initial');assert.equal(state.desktopOnly,true);assert.ok(!JSON.stringify(state).includes('PRIVATE'));
  await f.client.request(f.event,'viewer-open');assert.equal(f.viewer.opens,1);
  await assert.rejects(f.client.request({...f.event,senderFrame:{}},'viewer-open'),/Unknown renderer/);
  await assert.rejects(f.client.request({...f.event,sender:{}},'pair-start',{}),/Unknown renderer/);assert.equal(f.controller.pairs,0);
  assert.equal(f.client.window.options.webPreferences.sandbox,true);assert.equal(f.client.window.options.webPreferences.nodeIntegration,false);
  f.client.close();assert.equal(f.handlers.size,0);
});
