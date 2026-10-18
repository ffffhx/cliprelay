'use strict';
const path=require('node:path'),{pathToFileURL}=require('node:url');
const {TerminalController,message}=require('./terminal-controller.cjs');
class DesktopTerminal{
  constructor({store,BrowserWindow,ipcMain,clipboard,withClipboard=operation=>operation(),Controller=TerminalController}){
    Object.assign(this,{store,BrowserWindow,ipcMain,clipboard,withClipboard,Controller});this.page=path.join(__dirname,'terminal.html');this.url=pathToFileURL(this.page).href;
    ipcMain.handle('terminal:request',(event,action,data)=>this.request(event,action,data));
  }
  open(){
    const selected=this.store.selected();if(this.window && !this.window.isDestroyed() && selected && ['id','clientId','certificate','networkId'].every(key=>this.controller.bound?.[key]===selected[key])){this.window.show();this.window.focus();return;}
    this.window?.destroy();this.controller?.close();const controller=this.controller=new this.Controller({store:this.store});controller.bind();
    const window=this.window=new this.BrowserWindow({width:1040,height:760,minWidth:640,minHeight:420,title:'ClipRelay · 终端',show:false,resizable:true,autoHideMenuBar:true,backgroundColor:'#141820',webPreferences:{preload:path.join(__dirname,'terminal-preload.cjs'),sandbox:true,nodeIntegration:false,contextIsolation:true}});
    window.removeMenu?.();window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
    let loaded=false;window.webContents.on('did-start-loading',()=>{if(loaded)controller.pause();});window.webContents.on('did-finish-load',()=>{loaded=true;});
    window.webContents.on('render-process-gone',()=>controller.pause());
    window.on('blur',()=>controller.pause());window.on('minimize',()=>controller.pause());
    window.on('closed',()=>{controller.close();if(this.window===window){this.window=null;this.controller=null;}});
    window.once('ready-to-show',()=>window.show());window.loadFile(this.page);
  }
  async request(event,action,data){
    const window=this.window,controller=this.controller;
    if(!window || window.isDestroyed() || !controller || event.sender!==window.webContents || event.senderFrame!==event.sender.mainFrame || event.senderFrame.url!==this.url)throw new Error('Unknown renderer');
    if(Buffer.byteLength(JSON.stringify(data ?? {}))>(action==='copy'?1048700:65536))throw new Error('Invalid request');
    try{
      if(action==='initial')return controller.initializeView();
      if(action==='poll')return await controller.poll();
      if(action==='input')return controller.input(data);
      if(action==='mouse')return controller.mouse(data);
      if(action==='parsed')return controller.parsed(data);
      if(action==='resize')return controller.resize(data);
      if(action==='select')return controller.select(data?.id);
      if(action==='open')return controller.open(data?.shell);
      if(action==='end')return controller.end(data);
      if(action==='pause'){controller.pause();return controller.snapshot();}
      if(action==='resume')return controller.resume();
      if(action==='refresh'){controller.needList=true;return controller.snapshot();}
      if(action==='copy' || action==='paste')return await this.withClipboard(async()=>{
        const current=()=>{if(this.window!==window || this.controller!==controller || window.isDestroyed() || event.senderFrame!==window.webContents.mainFrame || event.senderFrame.url!==this.url)throw new Error();};
        current();
        if(action==='copy'){if(typeof data?.text!=='string' || Buffer.byteLength(data.text)>1024*1024)throw new Error();await this.clipboard.writeText(data.text);current();return;}
        controller.checkPaste(data);const text=await this.clipboard.readText();current();
        return controller.beginPaste(data,text);
      });
      if(action==='paste-preview')return controller.beginPaste(data,data?.text);
      if(action==='paste-submit')return controller.submitPaste(data);
      if(action==='paste-cancel'){controller.cancelPaste(data);return;}
      if(action==='close'){window.close();return;}
      throw new Error('Unknown action');
    }catch(error){throw new Error(message(error));}
  }
  reconcile(status){this.controller?.reconcile(status);}
  close(){this.controller?.close();this.window?.destroy();this.ipcMain.removeHandler('terminal:request');}
}
module.exports={DesktopTerminal};
