'use strict';
const {BrowserWindow, ipcMain, screen, Menu} = require('electron');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const dimensions = {
  'control-center': [1160,754], 'peer-editor':[960,720],
  'preview-remote':[480,400], 'updates':[560,520], 'remote-home':[620,570], 'remote-desktop':[700,660], 'remote-network':[620,620]
};
const actions = new Set(['snapshot','patch','normalize-peer','discover','merge','probe','paired-peers','summary','copy','preview-state','preview-navigate','remote','update-check','update-download','update-open','update-notify']);

class DesktopWindows {
  constructor(host, root) {
    this.host = host;
    this.root = root;
    this.windows = new Map();
    const {DeviceDirectory}=require('./device-directory.cjs');
    this.directory=new DeviceDirectory({request:(action,data)=>this.host.request(action,data)});
    const {AiController}=require('./ai-controller.cjs');
    const {AiServer}=require('./ai-server.cjs');
    this.ai=new AiController({getClient:()=>this.getClient(),directory:this.directory});
    this.aiServer=new AiServer({directory:root,controller:this.ai});
    this.page = path.join(__dirname,'renderer','index.html');
    this.url = pathToFileURL(this.page).href;
    const owner = event => {
      const window = [...this.windows.values()].find(win => win.webContents === event.sender);
      if (!window || event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith(this.url + '?')) throw new Error('Unknown renderer.');
      return window;
    };
    ipcMain.handle('relay:request', async (event, action, data) => {
      owner(event);
      if (!actions.has(action) || Buffer.byteLength(JSON.stringify(data ?? {})) > 262144) throw new Error('Invalid desktop action.');
      const result = await this.host.request(action, data);
      if (action === 'patch') this.refresh();
      return result;
    });
    ipcMain.handle('relay:window', (event, action, data) => {
      const window = owner(event);
      if(Buffer.byteLength(JSON.stringify(data ?? {}))>262144)throw new Error('Invalid window request');
      if (action === 'ready') { if (!window.isVisible()) window.show(); }
      else if (action === 'close') { window.relayCanClose = true; window.close(); }
      else if (action === 'minimize') window.minimize();
      else if (action === 'maximize') { if(window.isMaximized())window.unmaximize();else window.maximize(); }
      else if (action === 'pin') { window.setAlwaysOnTop(!window.isAlwaysOnTop()); return window.isAlwaysOnTop(); }
      else if (action === 'desktop-probe') {
        if(!Array.isArray(data?.peers)||data.peers.length>16)throw new Error('Invalid devices');
        const {probeComputer}=require('./desktop-connection.cjs');
        return Promise.all(data.peers.map(peer=>probeComputer(peer)));
      }
      else if (action === 'desktop-status') return this.client?.direct.status() || {phase:'idle',peerId:'',error:''};
      else if (action === 'desktop-directory') return this.directory.snapshot();
      else if (action === 'desktop-stop') return this.client?.direct.stop() || {phase:'idle',peerId:'',error:''};
      else if (action === 'desktop-client') {
        if(data?.peer?.directoryId&&!this.directory.snapshot().devices.some(device=>device.id===data.peer.directoryId&&device.connectable))throw new Error('电脑已离线或停止接收连接，请刷新列表');
        return this.getClient().open(data?.peer);
      }
      else if (action === 'open' && data && dimensions[data.name]) this.open(data.name, data.peerId);
      else if (action === 'peer-mode' && window === this.windows.get('peer-editor') && ['paired','legacy'].includes(data?.mode)) {
        window.loadFile(this.page,{query:{view:'peer-editor',peerId:window.relayPeerId,paired:data.mode==='paired'?'1':'',legacy:data.mode==='legacy'?'1':''}});
      }
      else if (action === 'peer-menu' && typeof data?.id === 'string') {
        Menu.buildFromTemplate([
          {label:'编辑设备',click:()=>this.open('peer-editor',data.id)},
          {label:'移除设备',click:async()=>{
            try {
              const {config,revision} = await this.host.request('snapshot');
              await this.host.request('patch',{peers:config.peers.filter(peer=>peer.id!==data.id),expectedRevision:revision});
              this.refresh();
            } catch(error) { window.webContents.send('relay:error',error.message); }
          }}
        ]).popup({window});
      } else throw new Error('Invalid window action.');
    });
  }

  open(name = 'control-center', peerId = '') {
    if (['remote-home','remote-desktop','remote-network'].includes(name)) {
      const center=this.open('control-center');
      const navigate=()=>center.webContents.send('relay:navigate','remote');
      if(center.webContents.isLoading())center.webContents.once('did-finish-load',navigate);else navigate();
      return center;
    }
    if (!dimensions[name]) return;
    const existing = this.windows.get(name);
    if (existing && !existing.isDestroyed()) { existing.restore(); existing.show(); existing.focus(); return existing; }
    const [width,height] = dimensions[name];
    const area = screen.getPrimaryDisplay().workAreaSize;
    const parent = name === 'remote-network' ? this.windows.get('remote-desktop')
      : ['remote-desktop','screen-share-picker'].includes(name) ? this.windows.get('remote-home') || this.windows.get('control-center')
      : this.windows.get('control-center');
    const nativeFrame = name === 'remote-desktop' || name === 'remote-network';
    const window = new BrowserWindow({
      width:Math.min(width,area.width),height:Math.min(height,area.height),useContentSize:!nativeFrame,
      title:'ClipRelay',frame:nativeFrame,show:false,resizable:name==='control-center',minWidth:520,minHeight:500,backgroundColor:name==='preview-remote'?'#111318':'#ffffff',
      icon:path.join(this.root,'cliprelay.ico'),parent,modal:!!parent && ['peer-editor','remote-desktop','remote-network'].includes(name),autoHideMenuBar:true,
      webPreferences:{preload:path.join(__dirname,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true}
    });
    this.windows.set(name,window);
    window.relayPeerId = peerId || '';
    window.setMenu(null);
    window.on('page-title-updated',event=>event.preventDefault());
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.on('close',event=>{
      if (name === 'control-center' && !window.relayCanClose) {
        event.preventDefault();window.webContents.send('relay:closing');
      }
    });
    window.on('closed',()=>this.windows.delete(name));
    window.loadFile(this.page,{query:{view:name,peerId:peerId || ''}});
    return window;
  }

  getClient(){if(!this.client){const {DesktopClient}=require('./desktop-client.cjs');this.client=new DesktopClient(this.root);}return this.client;}
  refresh() { for (const window of this.windows.values()) if (!window.isDestroyed()) window.webContents.send('relay:refresh'); }
  close() {
    if(this.closePromise)return this.closePromise;
    this.directory.stop();for(const window of this.windows.values())window.destroy();
    this.closePromise=(async()=>{
      let timer;
      try{await Promise.race([this.aiServer.close(),new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);}
      finally{clearTimeout(timer);this.client?.close();}
    })();return this.closePromise;
  }
}
module.exports = {DesktopWindows};
