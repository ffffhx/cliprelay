'use strict';
// Deliberately unavailable on a developer desktop. This app opens no windows
// and only writes synthetic data to a disposable CI runner's system clipboard.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync,spawn}=require('node:child_process'),{EventEmitter}=require('node:events'),{pathToFileURL}=require('node:url'),{createInterface}=require('node:readline');
const {app,clipboard,ClipboardItem,nativeImage}=require('electron');
if(process.env.CI!=='true' || process.env.GITHUB_ACTIONS!=='true' || process.env.CLIPRELAY_NATIVE_CLIPBOARD_FIXTURE!=='1')throw Error('Disposable CI only');
const options=JSON.parse(process.env.CLIPRELAY_NATIVE_CLIPBOARD_OPTIONS);
app.setPath('userData',options.userData);app.disableHardwareAcceleration();
const source=name=>require(path.join(options.modules,name));
const {clipboardAccess,captureSelection}=source('clipboard-access.cjs'),{PairedController}=source('paired-controller.cjs'),{DesktopTerminal}=source('terminal-window.cjs');
const access=clipboardAccess({clipboard,ClipboardItem,nativeImage});const cases=[];
const {ClipboardSync,fingerprint}=source('clipboard-sync.cjs');
async function nativeWorkerRoundtrip(png,image){
  const state=path.join(options.userData,'worker');fs.mkdirSync(state,{mode:0o700});
  const args=process.platform==='win32'?['--native-clipboard-probe']:['--managed-clipboard','--owner-pid',String(process.pid),'--state-dir',state];
  const child=spawn(options.nativeWorker,args,{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let pending,ended=false,diagnostic='';child.stderr.on('data',bytes=>{diagnostic=(diagnostic+bytes).slice(-2000);});
  const lines=createInterface({input:child.stdout});
  const finish=error=>{ended=true;if(pending){pending.reject(error);pending=null;}};
  child.on('error',finish);const closed=new Promise(resolve=>child.once('close',(code,signal)=>{finish(Error(`Native worker exited ${code}/${signal}: ${diagnostic}`));resolve(code);}));
  lines.on('line',line=>{if(!pending)return;const p=pending;pending=null;try{p.resolve(JSON.parse(line));}catch(error){p.reject(error);}});
  const call=body=>new Promise((resolve,reject)=>{
    if(ended)return reject(Error('Native worker unavailable: '+diagnostic));assert.ok(!pending);
    const timer=setTimeout(()=>{pending=null;reject(Error('Native worker request timed out: '+diagnostic));},10000);
    pending={resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}};
    child.stdin.write('clipboard:'+JSON.stringify({owner:'a'.repeat(64),...body})+'\n',error=>{if(error && pending){pending.reject(error);pending=null;}});
  });
  try{
    await access.writeText('native worker baseline');let baseline=await call({op:'observe'});assert.equal(baseline.ok,true);assert.equal(baseline.text,'native worker baseline');
    assert.equal((await call({op:'write',id:'1'.repeat(32),expect:baseline.revision,kind:'text',text:'Native worker 中文 👋'})).ok,true);
    assert.equal(await access.readText(),'Native worker 中文 👋');baseline=await call({op:'observe'});
    const write={op:'write',id:'2'.repeat(32),expect:baseline.revision,kind:'png',data:png.toString('base64')};assert.equal((await call(write)).ok,true);
    const received=await access.readPayload();assert.equal(received.kind,'png');assert.deepEqual(nativeImage.createFromBuffer(received.bytes).toBitmap(),image.toBitmap());
    await access.writeText('Electron later copy');assert.equal((await call(write)).ok,true);assert.equal(await access.readText(),'Electron later copy');
    assert.equal((await call({...write,id:'3'.repeat(32)})).code,'CLIPBOARD_CHANGED');assert.equal(await access.readText(),'Electron later copy');
    await access.writeImage(image);const native=await call({op:'read'});assert.equal(native.ok,true);assert.equal(native.kind,'png');assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(native.data,'base64')).toBitmap(),image.toBitmap());
    cases.push('native-worker-conditional-text-png-cross-process');
  }finally{
    child.stdin.end();const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{assert.equal(await closed,0);}finally{clearTimeout(timer);lines.close();}
  }
}
async function automaticRoundtrip(png,image){
  const host={id:'auto',clientId:'c',certificate:'synthetic pin',address:'127.0.0.1',port:1,enabled:true,clipboardSync:true};
  const session={host:{...host},telemetry:true};const monitor=new EventEmitter();monitor.getSystemIdleState=()=> 'active';
  const text=value=>({kind:'text',text:value});let remote=text('remote baseline'),version=1,requests=0,writes=0,queue=Promise.resolve(),gate;
  const revision=()=>version.toString(16).padStart(64,'0'),remoteCopy=value=>{remote=value;version++;};
  const store={data:{},selected:()=>host,identity:async()=>({}),setClipboardSync:(_id,value)=>{host.clipboardSync=value;}};
  const viewer={currentSession:()=>session,inputPaused:()=>false,snapshot:()=>({progress:{received:1,rendered:1,receivedAgeMs:0,renderedAgeMs:0}})};
  const paired={clipboard:access,withClipboard:operation=>{const task=queue.catch(()=>{}).then(operation);queue=task;return task;}};
  const request=async(_host,_identity,body)=>{
    requests++;if(body.op==='observe'){const response=body.revision===revision()?{changed:false,revision:revision()}:{changed:true,revision:revision(),payload:remote};if(gate){gate.began();await gate.wait;}return response;}
    assert.equal(body.op,'write');assert.equal(body.expect,revision());writes++;remoteCopy(body.kind==='text'?text(body.text):{kind:'png',bytes:Buffer.from(body.data,'base64')});return {ok:true};
  };
  const sync=new ClipboardSync({store,viewer,paired,nativeImage,powerMonitor:monitor,request,pollMs:60000});
  const tick=async()=>{const before=sync.record;sync.reconcile();const r=sync.record;if(r){clearTimeout(r.timer);await(r===before?sync.poll(r):r.task);}};
  try{
    await access.writeText('local baseline');await tick();assert.equal(await access.readText(),'local baseline');assert.equal(remote.text,'remote baseline');assert.equal(writes,0);cases.push('production-auto-native-baselines');
    await access.writeText('automatic local 中文');await tick();assert.equal(remote.text,'automatic local 中文');await tick();assert.equal(writes,1);
    remoteCopy(text('automatic remote 👋'));await tick();assert.equal(nativeText(),'automatic remote 👋');await tick();assert.equal(writes,1);cases.push('production-auto-native-text-bidirectional-no-echo');
    await access.writeImage(image);await tick();assert.equal(remote.kind,'png');assert.equal(fingerprint(remote,nativeImage),fingerprint({kind:'png',bytes:png},nativeImage));await tick();assert.equal(writes,2);
    const pixels=Buffer.from(image.toBitmap());for(let i=0;i<pixels.length;i+=4){pixels[i]=128;pixels[i+1]=0;pixels[i+2]=0;pixels[i+3]=128;}
    const other=nativeImage.createFromBitmap(pixels,{width:2,height:3});remoteCopy({kind:'png',bytes:other.toPNG()});await tick();const result=await access.readPayload();assert.equal(result.kind,'png');assert.deepEqual(nativeImage.createFromBuffer(result.bytes).toBitmap(),other.toBitmap());await tick();assert.equal(writes,2);cases.push('production-auto-native-png-bidirectional-no-echo');
    await access.writeText('conflict local');remoteCopy(text('conflict remote'));await tick();assert.equal(sync.snapshot().phase,'conflict');assert.equal(nativeText(),'conflict local');assert.equal(remote.text,'conflict remote');
    sync.resume({viewId:sync.viewId});await sync.record.task;assert.equal(nativeText(),'conflict local');assert.equal(writes,2);cases.push('production-auto-native-conflict-rebaseline');
    let began,release;const started=new Promise(resolve=>{began=resolve;});gate={began,wait:new Promise(resolve=>{release=resolve;})};remoteCopy(text('late locked remote'));const pending=tick();await started;
    monitor.emit('lock-screen');release();await pending;gate=null;const count=requests;await tick();assert.equal(requests,count);assert.equal(nativeText(),'conflict local');
    monitor.emit('unlock-screen');await sync.record.task;assert.equal(nativeText(),'conflict local');assert.equal(remote.text,'late locked remote');cases.push('production-auto-native-lock-and-late-response');
  }finally{sync.close();}
}
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
  if(options.nativeWorker)await nativeWorkerRoundtrip(png,image);
  await automaticRoundtrip(png,image);
  const files=['clipboard-access.cjs','paired-controller.cjs','terminal-window.cjs','clipboard-sync.cjs','clipboard-protocol.cjs',...(process.platform==='darwin'?['relay.cjs']:[])];
  fs.writeFileSync(options.report,JSON.stringify({schema:1,platform:process.platform,arch:process.arch,electron:process.versions.electron,head:process.env.GITHUB_SHA,cases,windowsCreated:0,syntheticOnly:true,sources:Object.fromEntries(files.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(options.modules,name))).digest('hex')]))},null,2));app.exit(0);
}).catch(error=>{console.error(error.stack);app.exit(1);});
