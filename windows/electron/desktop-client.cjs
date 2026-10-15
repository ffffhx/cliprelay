'use strict';
const {app,BrowserWindow,ipcMain,clipboard,nativeImage,safeStorage}=require('electron');
const path=require('node:path'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const {PairedStore}=require('./mac/paired-store.cjs');
const {PairedController,message}=require('./mac/paired-controller.cjs');
const {createClientIdentity}=require('./mac/client-identity.cjs');
const {StreamViewer}=require('./mac/stream-viewer.cjs');

class DesktopClient {
  constructor(root){
    this.page=path.join(__dirname,'mac','ui.html');this.url=pathToFileURL(this.page).href;
    const store=new PairedStore(path.join(app.getPath('userData'),'remote-clients'),safeStorage,{generate:createClientIdentity});
    this.viewer=new StreamViewer({directory:path.join(root,'remote-viewer'),store});
    this.paired=new PairedController({store,clipboard,nativeImage,localName:os.hostname().replace(/[\r\n\0]/g,'').slice(0,32) || 'Windows',copySelection:async()=>{},onUpdate:()=>this.viewer.reconcile()});
    this.paired.start();
    ipcMain.handle('mac:request',(event,action,data)=>this.request(event,action,data));
  }
  snapshot(){return {...this.paired.snapshot(),viewer:this.viewer.snapshot(),desktopOnly:true};}
  async request(event,action,data){
    if(!this.window || event.sender!==this.window.webContents || event.senderFrame!==event.sender.mainFrame || event.senderFrame.url!==this.url+'?kind=paired')throw new Error('Unknown renderer');
    if(Buffer.byteLength(JSON.stringify(data ?? {}))>32768)throw new Error('Invalid request');
    try{
      if(action==='initial' || action==='paired-status')return this.snapshot();
      if(action==='cancel'){this.window.close();return;}
      if(action==='pair-start'){this.paired.startPair(data);return this.snapshot();}
      if(action==='pair-cancel')this.paired.cancelPair();
      else if(action==='paired-select')this.paired.select(data?.id);
      else if(action==='paired-enable')this.paired.enable(data?.id,data?.enabled);
      else if(action==='paired-remove')this.paired.remove(data?.id);
      else if(action==='viewer-open')await this.viewer.open(data);
      else if(action==='viewer-stop')this.viewer.stop();
      else if(action==='paired-send'){const sent=await this.paired.sendCurrent();return {message:sent?'已加密发送':'没有可发送的内容'};}
      else throw new Error('Unknown action');
      this.viewer.reconcile();return this.snapshot();
    }catch(error){throw new Error(message(error));}
  }
  open(){
    if(this.window && !this.window.isDestroyed()){this.window.show();this.window.focus();return;}
    const window=this.window=new BrowserWindow({width:680,height:720,title:'ClipRelay · 控制其他电脑',show:false,resizable:true,autoHideMenuBar:true,backgroundColor:'#f5f7fa',webPreferences:{preload:path.join(__dirname,'mac','preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
    window.once('ready-to-show',()=>window.show());window.on('closed',()=>{if(this.window===window)this.window=null;this.paired.cancelPair();});
    window.loadFile(this.page,{query:{kind:'paired'}});
  }
  close(){this.viewer.stop();this.paired.close();this.window?.destroy();ipcMain.removeHandler('mac:request');}
}
module.exports={DesktopClient};
