'use strict';
const {app,Tray,Menu,nativeImage,globalShortcut,clipboard,Notification,BrowserWindow,ipcMain,screen,systemPreferences,safeStorage}=require('electron');
const {Bonjour}=require('bonjour-service');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {execFile,execFileSync}=require('node:child_process');
const {promisify}=require('node:util');
const {loadConfig,saveConfig}=require('./config.cjs');
const {sendSelection,createReceiver,discoveredPeer}=require('./relay.cjs');
const {PairedStore}=require('./paired-store.cjs');
const {PairedController,message:pairedMessage}=require('./paired-controller.cjs');
const {StreamViewer}=require('./stream-viewer.cjs');
app.setName('ClipRelay');
app.setPath('userData',path.join(app.getPath('appData'),'ClipRelay'));
let tray,bonjour,service,receiver,chooser,scanning=0,config,legacyChanging=false,paired,viewer;
const windows=new Map();
const page=path.join(__dirname,'ui.html');const pageURL=pathToFileURL(page).href;
const pairedSnapshot=()=>({...paired.snapshot(),viewer:viewer.snapshot()});
if(!app.requestSingleInstanceLock())app.quit();
else{
  app.on('window-all-closed',()=>{});
  app.whenReady().then(start).catch(error=>{require('electron').dialog.showErrorBox('ClipRelay',error.code==='EADDRINUSE'?'ClipRelay 端口已被占用。请先停用 Hammerspoon 中的 ClipRelay，再重新打开。':error.message);app.quit();});
  app.on('will-quit',()=>{scanning++;viewer?.stop();paired?.close();globalShortcut.unregisterAll();receiver?.close();service?.stop();bonjour?.destroy();tray?.destroy();});
}
function openWindow(kind,data,options){
  const window=new BrowserWindow({frame:false,show:false,resizable:false,skipTaskbar:true,backgroundColor:'#00000000',transparent:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true},...options});
  const id=window.webContents.id;
  windows.set(id,{window,kind,data});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
  window.on('closed',()=>{windows.delete(id);if(kind==='paired')paired?.cancelPair();});
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
  service?.stop();service=null;if(!config.discoveryEnabled || config.legacyEnabled!==true || !receiver?.listening)return;
  service=bonjour.publish({name:config.deviceName,type:'cliprelay',protocol:'tcp',port:config.localPort || 47632,txt:{id:config.deviceId,version:'1',platform:'macos',auth:config.accessToken?'required':'none'}});
  service.on('error',error=>alert('ClipRelay 局域网声明失败：'+error.message));
}
function menu(){
  const selected=paired?.store.selected(),status=({connected:'已连接',connecting:'连接中',paused:'已暂停',offline:'等待重连'})[paired?.status] || '需重新配对';
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:selected?`配对电脑：${selected.name} · ${status}`:'尚未选择配对电脑',enabled:false},
    {label:'配对电脑与安全收发…',click:()=>{const existing=[...windows.values()].find(entry=>entry.kind==='paired');if(existing){existing.window.show();existing.window.focus();}else openWindow('paired',{}, {width:620,height:640,alwaysOnTop:true,vibrancy:'popover'});}},
    {label:'发送当前剪贴板到配对电脑',enabled:!!selected?.enabled,click:()=>paired.sendCurrent().then(sent=>{if(sent)alert('已加密发送到 '+selected.name);}).catch(error=>alert(pairedMessage(error)))},
    {type:'separator'},
    {label:`旧版目标：${config.peer}:${config.peerPort}`,enabled:false},
    {label:'使用旧版目标收发（未加密）',type:'checkbox',checked:paired?.store.data.legacySelected===true,click:item=>item.checked?paired.selectLegacy():paired.select(null)},
    {label:'旧版局域网收发（未加密）',type:'checkbox',checked:config.legacyEnabled===true,enabled:!legacyChanging,click:item=>setLegacy(item.checked)},
    {label:'设置本机旧版接收密钥…',click:()=>openWindow('receiver-token',{token:config.accessToken || ''},{width:420,height:230,alwaysOnTop:true,vibrancy:'popover'})},
    {label:'扫描局域网设备…',click:scan},
    {label:'允许局域网发现',type:'checkbox',checked:config.discoveryEnabled,click:()=>{config.discoveryEnabled=!config.discoveryEnabled;saveConfig(app.getPath('userData'),config);publish();menu();}},
    {type:'separator'},{label:'退出 ClipRelay',role:'quit'}
  ]));
}
async function startReceiver(){
  if(config.legacyEnabled!==true || receiver?.listening)return;
  receiver=createReceiver({clipboard,getConfig:()=>config,notify:(title,body)=>new Notification({title,body}).show()});
  const current=receiver;
  await new Promise((resolve,reject)=>{
    current.once('error',reject);
    current.listen(config.localPort || 47632,()=>{current.removeListener('error',reject);current.on('error',error=>alert('旧版接收失败：'+error.message));resolve();});
  });
}
async function setLegacy(enabled){
  if(legacyChanging)return;legacyChanging=true;menu();
  try{
    config.legacyEnabled=enabled===true;saveConfig(app.getPath('userData'),config);
    if(config.legacyEnabled)await startReceiver();
    else if(receiver){const previous=receiver;receiver=null;previous.closeAllConnections();await new Promise(resolve=>previous.close(resolve));}
    alert(config.legacyEnabled?'旧版收发已开启：文本和密钥以明文传输':'旧版收发已关闭');
  }catch(error){config.legacyEnabled=false;receiver?.close();receiver=null;saveConfig(app.getPath('userData'),config);alert('旧版接收无法开启：'+error.message);}
  finally{legacyChanging=false;publish();menu();}
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
  saveConfig(app.getPath('userData'),config);paired.selectLegacy();menu();alert('已选择旧版目标：'+peer.text);
}
async function start(){
  app.dock?.hide();
  config=loadConfig(app.getPath('userData'),{hostname:()=>{
    try{return execFileSync('/usr/sbin/scutil',['--get','ComputerName'],{encoding:'utf8'}).trim();}catch{return 'Mac';}
  }});
  const localName=Array.from(String(config.deviceName || 'Mac').replace(/[\r\n\0]/g,'')).slice(0,32).join('') || 'Mac';
  const store=new PairedStore(path.join(app.getPath('userData'),'paired'),safeStorage,{legacySelected:config.legacyEnabled===true});
  viewer=new StreamViewer({directory:path.join(__dirname,'stream-viewer'),store});
  paired=new PairedController({store,clipboard,nativeImage,localName,copySelection:()=>promisify(execFile)(path.join(__dirname,'copy-selection'),[]),notify:(title,body)=>new Notification({title,body}).show(),onUpdate:()=>{viewer?.reconcile();if(tray)menu();}});
  await startReceiver();
  bonjour=new Bonjour({},error=>alert('ClipRelay 局域网声明失败：'+error.message));
  tray=new Tray(nativeImage.createEmpty());tray.setTitle('ClipRelay');menu();publish();
  paired.start();
  ipcMain.handle('mac:request',async(event,action,data)=>{
    const entry=windows.get(event.sender.id);
    if(!entry || event.senderFrame!==event.sender.mainFrame || !event.senderFrame.url.startsWith(pageURL+'?'))throw new Error('Unknown renderer');
    if(action==='initial')return entry.kind==='paired'?pairedSnapshot():entry.data;
    if(action==='cancel'){entry.window.close();return;}
    if(entry.kind==='paired'){
      try{
        if(action==='paired-status')return pairedSnapshot();
        if(action==='pair-start'){paired.startPair(data);return pairedSnapshot();}
        if(action==='pair-cancel')paired.cancelPair();
        else if(action==='paired-select')paired.select(data?.id);
        else if(action==='paired-enable')paired.enable(data?.id,data?.enabled);
        else if(action==='paired-remove')paired.remove(data?.id);
        else if(action==='viewer-open')await viewer.open(data);
        else if(action==='viewer-stop')viewer.stop();
        else if(action==='paired-send'){const sent=await paired.sendCurrent();return {message:sent?'已加密发送':'没有可发送的内容'};}
        else throw new Error('Unknown action');
        viewer.reconcile();return pairedSnapshot();
      }catch(error){throw new Error(pairedMessage(error));}
    }
    if(action==='select' && entry.kind==='chooser'){
      const peer=entry.data.peers.find(value=>value.id===data.id);if(!peer)throw new Error('Unknown device');
      entry.window.close();
      if(peer.requiresAuth)openWindow('token',{peer,token:config.peerToken},{width:420,height:210,alwaysOnTop:true,vibrancy:'popover'});
      else select(peer,'');
      return;
    }
    if(action==='save' && ['token','receiver-token'].includes(entry.kind) && typeof data.token==='string'){
      if(data.token.length>4096 || /[\r\n]/.test(data.token))throw new Error('Invalid token');
      if(entry.kind==='receiver-token'){config.accessToken=data.token.trim();saveConfig(app.getPath('userData'),config);publish();menu();entry.window.close();return;}
      select(entry.data.peer,data.token);entry.window.close();return;
    }
    throw new Error('Unknown action');
  });
  systemPreferences.isTrustedAccessibilityClient(true);
  globalShortcut.register(config.hotkey || 'Control+Alt+G',()=>{
    if(paired.store.data.legacySelected!==true){paired.sendCurrent(true).catch(error=>alert(pairedMessage(error)));return;}
    if(config.legacyEnabled!==true){alert('旧版收发已关闭，请选择配对电脑或明确开启兼容');return;}
    sendSelection({clipboard,config,copySelection:()=>promisify(execFile)(path.join(__dirname,'copy-selection'),[])}).catch(()=>{});
  });
  alert('ClipRelay 已启动');
}
