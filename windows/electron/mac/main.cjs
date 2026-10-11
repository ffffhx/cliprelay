'use strict';
const {app,Tray,Menu,nativeImage,globalShortcut,clipboard,Notification,BrowserWindow,ipcMain,screen,systemPreferences}=require('electron');
const {Bonjour}=require('bonjour-service');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {execFile,execFileSync}=require('node:child_process');
const {promisify}=require('node:util');
const {loadConfig,saveConfig}=require('./config.cjs');
const {sendSelection,createReceiver,discoveredPeer}=require('./relay.cjs');
app.setName('ClipRelay');
app.setPath('userData',path.join(app.getPath('appData'),'ClipRelay'));
let tray,bonjour,service,receiver,chooser,scanning=0,config;
const windows=new Map();
const page=path.join(__dirname,'ui.html');const pageURL=pathToFileURL(page).href;
if(!app.requestSingleInstanceLock())app.quit();
else{
  app.on('window-all-closed',()=>{});
  app.whenReady().then(start).catch(error=>{require('electron').dialog.showErrorBox('ClipRelay',error.code==='EADDRINUSE'?'ClipRelay 端口已被占用。请先停用 Hammerspoon 中的 ClipRelay，再重新打开。':error.message);app.quit();});
  app.on('will-quit',()=>{scanning++;globalShortcut.unregisterAll();receiver?.close();service?.stop();bonjour?.destroy();tray?.destroy();});
}
function openWindow(kind,data,options){
  const window=new BrowserWindow({frame:false,show:false,resizable:false,skipTaskbar:true,backgroundColor:'#00000000',transparent:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true},...options});
  const id=window.webContents.id;
  windows.set(id,{window,kind,data});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
  window.on('closed',()=>windows.delete(id));
  window.once('ready-to-show',()=>{if(kind==='alert')window.showInactive();else window.show();});
  window.loadFile(page,{query:{kind}});return window;
}
function alert(message){
  if(!app.isReady())return;
  const area=screen.getPrimaryDisplay().workArea;
  const width=Math.min(area.width-60,Math.max(300,message.length*27+48));
  const window=openWindow('alert',{message},{width,height:82,x:Math.round(area.x+(area.width-width)/2),y:Math.round(area.y+area.height/2-41),alwaysOnTop:true,focusable:false});
  setTimeout(()=>{if(!window.isDestroyed())window.close();},2000);
}
function publish(){
  service?.stop();service=null;if(!config.discoveryEnabled)return;
  service=bonjour.publish({name:config.deviceName,type:'cliprelay',protocol:'tcp',port:config.localPort || 47632,txt:{id:config.deviceId,version:'1',platform:'macos',auth:'none'}});
  service.on('error',error=>alert('ClipRelay 局域网声明失败：'+error.message));
}
function menu(){
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:`发送到：${config.peer}:${config.peerPort}`,enabled:false},
    {label:'扫描局域网设备…',click:scan},
    {label:'允许局域网发现',type:'checkbox',checked:config.discoveryEnabled,click:()=>{config.discoveryEnabled=!config.discoveryEnabled;saveConfig(app.getPath('userData'),config);publish();menu();}}
  ]));
}
async function scan(){
  const current=++scanning;const choices=new Map();
  const browser=bonjour.find({type:'cliprelay',protocol:'tcp'},service=>{const peer=discoveredPeer(service,config.deviceId);if(peer)choices.set(peer.id,peer);});
  await new Promise(resolve=>setTimeout(resolve,2600));browser.stop();if(current!==scanning)return;
  const peers=[...choices.values()].sort((a,b)=>Buffer.compare(Buffer.from(a.text),Buffer.from(b.text)));
  if(!peers.length){alert('未发现其他 ClipRelay 设备');return;}
  if(chooser && !chooser.isDestroyed())chooser.close();
  const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width=Math.round(area.width*0.4);
  const window=openWindow('chooser',{peers},{width,height:514,x:Math.round(area.x+(area.width-width)/2),y:Math.round(area.y+(area.height-514)/2),vibrancy:'sidebar',alwaysOnTop:true});
  chooser=window;window.setAlwaysOnTop(true,'main-menu',3);
  window.on('blur',()=>{if(!window.isDestroyed())window.close();});
}
function select(peer,token){
  config.peer=peer.address;config.peerPort=peer.port;config.peerToken=token;
  saveConfig(app.getPath('userData'),config);menu();alert('ClipRelay 已选择：'+peer.text);
}
async function start(){
  app.dock?.hide();
  config=loadConfig(app.getPath('userData'),{hostname:()=>{
    try{return execFileSync('/usr/sbin/scutil',['--get','ComputerName'],{encoding:'utf8'}).trim();}catch{return 'Mac';}
  }});
  receiver=createReceiver({clipboard,notify:(title,body)=>new Notification({title,body}).show()});
  await new Promise((resolve,reject)=>{receiver.once('error',reject);receiver.listen(config.localPort || 47632,resolve);});
  bonjour=new Bonjour({},error=>alert('ClipRelay 局域网声明失败：'+error.message));
  tray=new Tray(nativeImage.createEmpty());tray.setTitle('ClipRelay');menu();publish();
  ipcMain.handle('mac:request',(event,action,data)=>{
    const entry=windows.get(event.sender.id);
    if(!entry || event.senderFrame!==event.sender.mainFrame || !event.senderFrame.url.startsWith(pageURL+'?'))throw new Error('Unknown renderer');
    if(action==='initial')return entry.data;
    if(action==='cancel'){entry.window.close();return;}
    if(action==='select' && entry.kind==='chooser'){
      const peer=entry.data.peers.find(value=>value.id===data.id);if(!peer)throw new Error('Unknown device');
      entry.window.close();
      if(peer.requiresAuth)openWindow('token',{peer,token:config.peerToken},{width:420,height:210,alwaysOnTop:true,vibrancy:'popover'});
      else select(peer,'');
      return;
    }
    if(action==='save' && entry.kind==='token' && typeof data.token==='string'){
      select(entry.data.peer,data.token);entry.window.close();return;
    }
    throw new Error('Unknown action');
  });
  systemPreferences.isTrustedAccessibilityClient(true);
  globalShortcut.register(config.hotkey || 'Control+Alt+G',()=>{
    sendSelection({clipboard,config,copySelection:()=>promisify(execFile)(path.join(__dirname,'copy-selection'),[])}).catch(()=>{});
  });
  alert('ClipRelay 已启动');
}
