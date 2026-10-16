'use strict';
// Deliberately unavailable on a developer desktop. This app opens no windows
// and only writes synthetic data to a disposable CI runner's system clipboard.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),{EventEmitter}=require('node:events'),{pathToFileURL}=require('node:url');
const {app,clipboard,ClipboardItem,nativeImage}=require('electron');
if(process.env.CI!=='true' || process.env.GITHUB_ACTIONS!=='true' || process.env.CLIPRELAY_NATIVE_CLIPBOARD_FIXTURE!=='1')throw Error('Disposable CI only');
const options=JSON.parse(process.env.CLIPRELAY_NATIVE_CLIPBOARD_OPTIONS);
app.setPath('userData',options.userData);app.disableHardwareAcceleration();
const source=name=>require(path.join(options.modules,name));
const {clipboardAccess,captureSelection}=source('clipboard-access.cjs'),{PairedController}=source('paired-controller.cjs'),{DesktopTerminal}=source('terminal-window.cjs');
const access=clipboardAccess({clipboard,ClipboardItem,nativeImage});const cases=[];
function nativeText(){
  if(process.platform==='darwin')return execFileSync('/usr/bin/pbpaste',[],{encoding:'utf8',timeout:10000});
  const script='Add-Type -AssemblyName System.Windows.Forms; [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Windows.Forms.Clipboard]::GetText())))';
  const result=execFileSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-STA','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:10000});
  return Buffer.from(result.trim(),'base64').toString('utf8');
}
app.whenReady().then(async()=>{
  assert.equal(process.versions.electron,'44.4.3');assert.equal(typeof ClipboardItem,'function');assert.equal(typeof clipboard.readImage,'undefined');
  const text='ClipRelay CI 中文 👋\nline two';await access.writeText(text);assert.equal(nativeText(),text);assert.equal(await access.readText(),text);assert.equal((await access.readPayload()).text,text);cases.push('electron-async-text-native-read');
  const png=Buffer.from(options.png,'base64'),image=nativeImage.createFromBuffer(png);assert.deepEqual(image.getSize(),{width:2,height:3});
  await access.writeImage(image);const captured=await access.readPayload();assert.equal(captured.kind,'png');const copied=nativeImage.createFromBuffer(captured.bytes);assert.deepEqual(copied.getSize(),image.getSize());assert.deepEqual(copied.toBitmap(),image.toBitmap());cases.push('electron-async-png-pixels-and-alpha');
  await access.writeText('before selection');const selected=await captureSelection(access,()=>access.writeText('selection 中文'),{delay:async()=>{}});assert.equal(selected.text,'selection 中文');assert.equal(nativeText(),'before selection');cases.push('electron-selection-restore');
  const host={id:'h',clientId:'c',certificate:'synthetic pin',address:'127.0.0.1',port:1,enabled:true};let current=host;const sent=[];
  class Receiver{constructor(options){this.apply=options.apply;}refresh(){}close(){}}
  const controller=new PairedController({store:{data:{},selected:()=>current,identity:async()=>({})},clipboard,ClipboardItem,nativeImage,Receiver,send:async(_host,_identity,payload)=>sent.push(payload)});
  try{
    await access.writeText(text);assert.equal(await controller.sendCurrent(),true);assert.equal(sent.at(-1).text,text);
    await access.writeImage(image);assert.equal(await controller.sendCurrent(),true);assert.equal(sent.at(-1).kind,'png');assert.deepEqual(nativeImage.createFromBuffer(sent.at(-1).bytes).toBitmap(),image.toBitmap());cases.push('production-paired-text-png-send');
    await controller.receiver.apply({kind:'json',text},()=>true);assert.equal(nativeText(),text);cases.push('production-paired-text-receive');
    const jpeg=image.toJPEG(90);await controller.receiver.apply({kind:'jpeg',body:jpeg},()=>true);assert.equal((await access.readPayload()).kind,'png');cases.push('production-paired-jpeg-receive');
    const old=await access.readPayload();await assert.rejects(controller.receiver.apply({kind:'json',text:'cancelled'},()=>false),{code:'CANCELLED'});assert.deepEqual((await access.readPayload()).bytes,old.bytes);cases.push('production-receive-cancel-preserves-clipboard');
    // Exercise the real IPC dispatcher with owned synthetic window/frame objects;
    // no BrowserWindow is constructed and no remote terminal is contacted.
    class Window extends EventEmitter{constructor(){super();this.webContents=new EventEmitter();this.webContents.mainFrame={};this.webContents.setWindowOpenHandler=()=>{};}loadFile(file){this.webContents.mainFrame.url=pathToFileURL(file).href;}isDestroyed(){return !!this.destroyed;}destroy(){this.destroyed=true;this.emit('closed');}}
    class Terminal{bind(){}close(){}checkPaste(){}beginPaste(_data,text){assert.equal(typeof text,'string');return {text};}}
    const terminal=new DesktopTerminal({store:{selected:()=>host},BrowserWindow:Window,ipcMain:{handle(){},removeHandler(){}},clipboard,withClipboard:operation=>controller.withClipboard(operation),Controller:Terminal});terminal.open();
    try{const event={sender:terminal.window.webContents,senderFrame:terminal.window.webContents.mainFrame};await terminal.request(event,'copy',{text});assert.equal(nativeText(),text);assert.equal((await terminal.request(event,'paste',{})).text,text);cases.push('production-terminal-async-copy-paste');}finally{terminal.close();}
    current=null;await assert.rejects(controller.sendCurrent(),{code:'PAIRING_REQUIRED'});cases.push('production-disconnected-send-refused');
  }finally{controller.close();}
  if(process.platform==='darwin'){
    const {receive,sendSelection}=source('relay.cjs');const config={legacyEnabled:true};await access.writeText('legacy before');
    assert.equal(await sendSelection({clipboard,config,copySelection:()=>access.writeText('legacy selection'),delay:async()=>{},post:async(_c,text)=>assert.equal(text,'legacy selection')}),true);assert.equal(nativeText(),'legacy before');
    assert.equal((await receive('POST','/push',JSON.stringify({text}),{clipboard,getConfig:()=>config,notify:()=>{}},{remoteAddress:'127.0.0.1'})).status,200);assert.equal(nativeText(),text);cases.push('production-legacy-async-selection-receive');
  }
  const files=['clipboard-access.cjs','paired-controller.cjs','terminal-window.cjs',...(process.platform==='darwin'?['relay.cjs']:[])];
  fs.writeFileSync(options.report,JSON.stringify({schema:1,platform:process.platform,arch:process.arch,electron:process.versions.electron,head:process.env.GITHUB_SHA,cases,windowsCreated:0,syntheticOnly:true,sources:Object.fromEntries(files.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(options.modules,name))).digest('hex')]))},null,2));app.exit(0);
}).catch(error=>{console.error(error.stack);app.exit(1);});
