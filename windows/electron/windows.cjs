'use strict';
const {BrowserWindow, ipcMain, screen, Menu} = require('electron');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const dimensions = {
  'control-center': [760,720], 'peer-editor':[500,454], 'screen-share-picker':[560,540],
  'preview-remote':[480,400], 'updates':[560,520], 'remote-desktop':[700,660], 'remote-network':[620,620]
};
const actions = new Set(['snapshot','patch','normalize-peer','discover','merge','probe','summary','copy','share','stop-sharing','preview-state','preview-navigate','remote','update-check','update-download','update-open','update-notify']);

class DesktopWindows {
  constructor(host, root) {
    this.host = host;
    this.root = root;
    this.windows = new Map();
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
      if (action === 'ready') { if (!window.isVisible()) window.show(); }
      else if (action === 'close') { window.relayCanClose = true; window.close(); }
      else if (action === 'minimize') window.minimize();
      else if (action === 'pin') { window.setAlwaysOnTop(!window.isAlwaysOnTop()); return window.isAlwaysOnTop(); }
      else if (action === 'resize' && this.windows.get('screen-share-picker') === window && data.width === 560 && [372,456,540].includes(data.height)) window.setContentSize(data.width,data.height);
      else if (action === 'open' && data && dimensions[data.name]) this.open(data.name, data.peerId);
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
    if (!dimensions[name]) return;
    const existing = this.windows.get(name);
    if (existing && !existing.isDestroyed()) { existing.restore(); existing.show(); existing.focus(); return existing; }
    const [width,height] = dimensions[name];
    const area = screen.getPrimaryDisplay().workAreaSize;
    const parent = name === 'remote-network' ? this.windows.get('remote-desktop') : this.windows.get('control-center');
    const nativeFrame = name === 'remote-desktop' || name === 'remote-network';
    const window = new BrowserWindow({
      width:Math.min(width,area.width),height:Math.min(height,area.height),useContentSize:!nativeFrame,
      title:nativeFrame?(name==='remote-desktop'?'ClipRelay · 手机远控':'ClipRelay · 外网连接'):'ClipRelay',frame:nativeFrame,show:false,resizable:false,backgroundColor:nativeFrame?'#f5f7fa':'#111318',
      icon:path.join(this.root,'cliprelay.ico'),parent,modal:!!parent && ['peer-editor','remote-desktop','remote-network'].includes(name),autoHideMenuBar:true,
      webPreferences:{preload:path.join(__dirname,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true}
    });
    this.windows.set(name,window);
    window.setMenu(null);
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

  refresh() { for (const window of this.windows.values()) if (!window.isDestroyed()) window.webContents.send('relay:refresh'); }
  close() { for (const window of this.windows.values()) window.destroy(); }
}
module.exports = {DesktopWindows};
