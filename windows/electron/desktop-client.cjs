'use strict';
const {app,BrowserWindow,ipcMain,clipboard,nativeImage,safeStorage,dialog,shell}=require('electron');
const path=require('node:path'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const {PairedStore}=require('./mac/paired-store.cjs');
const {PairedController,message}=require('./mac/paired-controller.cjs');
const {createClientIdentity}=require('./mac/client-identity.cjs');
const {StreamViewer}=require('./mac/stream-viewer.cjs');
const {NetworkCatalog}=require('./mac/network-catalog.cjs');
const {NetworkController}=require('./mac/network-controller.cjs');
const {RoutedStore}=require('./mac/routed-store.cjs');
const {FileController,message:fileMessage}=require('./mac/file-controller.cjs');
const {DesktopTerminal}=require('./mac/terminal-window.cjs');
const {BitrateController,message:bitrateMessage}=require('./mac/bitrate-controller.cjs');
const {DisplayController,message:displayMessage}=require('./mac/display-controller.cjs');

class DesktopClient {
  constructor(root){
    this.page=path.join(__dirname,'mac','ui.html');this.url=pathToFileURL(this.page).href;
    const directory=path.join(app.getPath('userData'),'remote-clients');
    const base=new PairedStore(directory,safeStorage,{generate:createClientIdentity});
    const localName=Array.from(os.hostname().replace(/[\r\n\0]/g,'')).slice(0,32).join('') || 'Windows';
    this.network=new NetworkController({catalog:new NetworkCatalog(path.join(directory,'network'),safeStorage),store:base,directory:path.join(root,'desktop-network'),localName,
      canPair:()=>!this.paired?.pairController,onUpdate:()=>{this.paired?.reconcileRoutes();this.viewer?.reconcile();this.files?.reconcile();this.terminal?.reconcile();}});
    const store=new RoutedStore(base,id=>this.network.route(id),id=>this.network.streamPolicy(id));
    this.viewer=new StreamViewer({directory:path.join(root,'remote-viewer'),store,onUpdate:()=>{this.bitrate?.reconcile();this.displays?.reconcile();}});
    this.bitrate=new BitrateController({store,viewer:this.viewer});
    this.displays=new DisplayController({store,viewer:this.viewer});
    this.files=new FileController({store,directory:path.join(directory,'files'),dialog,shell});
    this.terminal=new DesktopTerminal({store,BrowserWindow,ipcMain,clipboard});
    this.paired=new PairedController({store,clipboard,nativeImage,localName,copySelection:async()=>{},onUpdate:()=>{this.viewer.reconcile(this.paired?.status);this.files.reconcile(this.paired?.status);this.terminal.reconcile(this.paired?.status);}});
    this.paired.start();
    this.network.reconcile();
    ipcMain.handle('mac:request',(event,action,data)=>this.request(event,action,data));
  }
  snapshot(){this.bitrate.reconcile();this.displays.reconcile();return {...this.paired.snapshot(),viewer:this.viewer.snapshot(),network:this.network.snapshot(),files:this.files.snapshot(),bitrate:this.bitrate.snapshot(),displays:this.displays.snapshot(),desktopOnly:true};}
  async request(event,action,data){
    if(!this.window || event.sender!==this.window.webContents || event.senderFrame!==event.sender.mainFrame || event.senderFrame.url!==this.url+'?kind=paired')throw new Error('Unknown renderer');
    if(Buffer.byteLength(JSON.stringify(data ?? {}))>32768)throw new Error('Invalid request');
    try{
      if(action==='initial' || action==='paired-status')return this.snapshot();
      if(action==='cancel'){this.window.close();return;}
      if(action==='bitrate-apply'){try{this.bitrate.apply(data);}catch(error){throw Object.assign(new Error(bitrateMessage(error)),{bitrateMessage:true});}return this.snapshot();}
      if(action==='display-select'){try{this.displays.apply(data);}catch(error){throw Object.assign(new Error(displayMessage(error)),{displayMessage:true});}return this.snapshot();}
      if(typeof action==='string' && action.startsWith('files-')){try{await this.files.action(action,data,this.window);}catch(error){throw Object.assign(new Error(fileMessage(error)),{fileMessage:true});}return this.snapshot();}
      if(action==='pair-start'){if(this.network.pairAbort)throw Object.assign(new Error(),{code:'PAIRING_BUSY'});this.paired.startPair(data);return this.snapshot();}
      if(action==='pair-cancel')this.paired.cancelPair();
      else if(action==='paired-select')this.paired.select(data?.id);
      else if(action==='paired-enable')this.paired.enable(data?.id,data?.enabled);
      else if(action==='paired-remove'){const host=this.paired.store.hosts().find(host=>host.id===data?.id);if(host?.networkId)this.network.remove(host.networkId);else this.paired.remove(data?.id);}
      else if(action==='network-claim')this.network.claim(data?.code);
      else if(action==='network-cancel')this.network.cancelPair();
      else if(action==='network-pair')this.network.pairSaved(data?.id);
      else if(action==='network-enable')this.network.enable(data?.id,data?.enabled);
      else if(action==='network-remove')this.network.remove(data?.id);
      else if(action==='viewer-open')await this.viewer.open(data);
      else if(action==='viewer-stop')this.viewer.stop();
      else if(action==='terminal-open')this.terminal.open();
      else if(action==='paired-send'){const sent=await this.paired.sendCurrent();return {message:sent?'已加密发送':'没有可发送的内容'};}
      else throw new Error('Unknown action');
      this.network.reconcile();this.paired.reconcileRoutes();this.viewer.reconcile();this.files.reconcile();this.terminal.reconcile();return this.snapshot();
    }catch(error){throw new Error(error.fileMessage||error.bitrateMessage||error.displayMessage?error.message:message(error));}
  }
  open(){
    if(this.window && !this.window.isDestroyed()){this.window.show();this.window.focus();return;}
    const window=this.window=new BrowserWindow({width:680,height:720,title:'ClipRelay · 控制其他电脑',show:false,resizable:true,autoHideMenuBar:true,backgroundColor:'#f5f7fa',webPreferences:{preload:path.join(__dirname,'mac','preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
    window.once('ready-to-show',()=>window.show());window.on('closed',()=>{if(this.window===window)this.window=null;this.paired.cancelPair();this.network.cancelPair();this.files.releaseWindow();});
    window.loadFile(this.page,{query:{kind:'paired'}});
  }
  close(){this.displays.close();this.bitrate.close();this.terminal.close();this.files.close();this.viewer.stop();this.paired.close();this.network.close();this.window?.destroy();ipcMain.removeHandler('mac:request');}
}
module.exports={DesktopClient};
