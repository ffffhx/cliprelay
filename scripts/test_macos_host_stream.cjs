'use strict';
// Real packaged Mac capture -> encoder -> encrypted loopback -> Qt presentation.
// Disposable CI only. No frames, audio or user input are saved/injected.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {snapshot,encryptedStorage}=require('./test_macos_host_state.cjs');
assert.equal(process.platform,'darwin');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.ok(process.env.RUNNER_TEMP);
const directory=path.resolve(process.argv[2]),reportPath=path.resolve(process.argv[3]);
const {HostController}=require(path.join(directory,'host-controller.cjs'));
const {HostState,configuration}=require(path.join(directory,'host-state.cjs'));
const {HostEngine}=require(path.join(directory,'host-engine.cjs'));
const {HostCompanion}=require(path.join(directory,'host-companion.cjs'));
const {HostSession}=require(path.join(directory,'host-session.cjs'));
const {StreamViewer,envelope,executable}=require(path.join(directory,'stream-viewer.cjs'));
const {DisplayController}=require(path.join(directory,'display-controller.cjs'));
const {pairHost}=require(path.join(directory,'pairing.cjs'));
const {jsonRequest,exchange}=require(path.join(directory,'paired-transport.cjs'));
const {identities}=require('../windows/tests/mac-pairing-fixture.cjs');
const viewerDirectory=path.join(directory,'stream-viewer');
const options={width:1280,height:720,fps:30,bitrate:6000,fullscreen:false};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate,timeout=30000){
  const end=Date.now()+timeout;
  while(true){const value=await read();if(predicate(value))return value;if(Date.now()>end)throw Error('MAC_STREAM_WAIT_TIMEOUT');await pause(50);}
}
const protectedDirectories=[path.join(os.homedir(),'.config','sunshine'),path.join(os.homedir(),'Library/Application Support/ClipRelay/host')];
const before=protectedDirectories.map(snapshot),originalHome=process.env.HOME;
const base=fs.realpathSync(fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'cliprelay-native-mac-stream-')));
const nativeChildren=[],rawViewers=[],diagnostics=[],viewerExits=[];
const testStarted=Date.now();
function diagnosticLines(value){
  return value.split('\n').filter(line=>/error|fail|decoder|encoder|render|permission|invalid|abort|fatal|exception|library not loaded|reason:|screen|capture|video/i.test(line)&&
    !/rikey|pin=|uniqueid|PRIVATE KEY|certificate|authorization|credential|password|secret|token/i.test(line)).slice(-40).map(line=>line.slice(0,400));
}
function fileDiagnostics(){
  const result=[];
  for(const folder of new Set(['/tmp',os.tmpdir(),path.join(os.homedir(),'Library/Logs/DiagnosticReports')])){
    if(!fs.existsSync(folder))continue;
    for(const name of fs.readdirSync(folder)){
      if(!/^ClipRelayStream-.*\.log$|^Moonlight.*\.(ips|crash)$/.test(name))continue;
      const file=path.join(folder,name),stat=fs.lstatSync(file);
      if(stat.isFile()&&!stat.isSymbolicLink()&&stat.mtimeMs>=testStarted&&stat.size<=2*1024*1024)
        result.push({kind:name.endsWith('.log')?'viewer':'crash',lines:diagnosticLines(fs.readFileSync(file,'utf8'))});
    }
  }
  try{result.push({kind:'engine',lines:diagnosticLines(hostState.read('engine.log',2*1024*1024).toString('utf8'))});}catch{}
  return result;
}
let hostState,viewer,display,stage='prepare';
const host=new HostController({directory,stateDirectory:path.join(base,'Host'),safeStorage:encryptedStorage(),localName:'Native stream CI',
  create({stateDirectory,safeStorage,enginePin,companionPin,onUpdate}){
    hostState=new HostState({directory:stateDirectory,safeStorage});
    const prepare=hostState.prepare.bind(hostState);
    hostState.prepare=name=>{
      const result=prepare(name);
      hostState.write('sunshine.conf',configuration(name)+'bind_address = 127.0.0.1\nmouse = disabled\nkeyboard = disabled\nstream_audio = disabled\n');
      return result;
    };
    const launch=(file,args,settings)=>{const child=spawn(file,args,settings);nativeChildren.push(child);return child;};
    const engine=new HostEngine({directory:path.join(directory,'host-engine'),pin:enginePin,state:hostState,launch});
    const companion=new HostCompanion({directory:path.join(directory,'host-companion'),pin:companionPin,state:hostState,launch});
    return {session:new HostSession({engine,companion,onUpdate}),companion};
  }});
function launchViewer(file,args,settings){
  const env={...settings.env};
  for(const key of ['ELECTRON_RUN_AS_NODE','QT_QPA_PLATFORM','QT_PLUGIN_PATH','QML2_IMPORT_PATH'])delete env[key];
  const child=spawn(file,args,{...settings,env,stdio:['pipe','pipe','pipe']});nativeChildren.push(child);
  let count=0,tail='';
  child.stderr.on('data',data=>{
    count+=data.length;if(count>4*1024*1024){child.kill('SIGKILL');return;}
    tail+=data.toString('utf8');if(tail.length>16384)tail=tail.slice(-8192);
  });
  child.once('close',(code,signal)=>{viewerExits.push({code,signal});diagnostics.push(...diagnosticLines(tail));});
  return child;
}
async function pair(identity,name){
  return pairHost({address:'127.0.0.1',port:48789,identity,name,onVerification:async verification=>{
    const status=await host.action('host-status'),request=status.requests.find(item=>item.verification===verification.verification);
    assert.ok(request);await host.action('host-pair-approve',{id:request.id,generation:request.generation,verification:request.verification});
  }});
}
function selected(host){return {...host,clientId:crypto.randomBytes(16).toString('hex'),enabled:true};}
function rawViewer(host,identity){
  // No HTTP polling/controller can close this child on revocation. It must
  // receive the host's native termination while its owner pipe stays open.
  const child=launchViewer(executable(viewerDirectory),['--cliprelay-session'],{cwd:viewerDirectory,env:process.env});
  const item={child,events:[],exit:null,buffer:'',error:null};rawViewers.push(item);
  child.on('error',error=>{item.error=error.code||'VIEWER_SPAWN_FAILED';});
  child.stdout.on('data',data=>{
    item.buffer+=data.toString('utf8');
    if(item.buffer.length>65536){item.error='VIEWER_OUTPUT_LIMIT';child.kill('SIGKILL');return;}
    while(item.buffer.includes('\n')){
      const index=item.buffer.indexOf('\n'),line=item.buffer.slice(0,index);item.buffer=item.buffer.slice(index+1);
      try{const event=JSON.parse(line);assert.equal(event.version,1);assert.ok(item.events.length<2000);item.events.push(event);}
      catch{item.error='VIEWER_PROTOCOL_ERROR';child.kill('SIGKILL');return;}
    }
  });
  child.once('close',(code,signal)=>{item.exit={code,signal};});child.stdin.on('error',()=>{});
  child.stdin.write(envelope(host,identity,options,true,false));
  return item;
}
async function presented(item){
  return until(()=>{assert.equal(item.error,null);assert.equal(item.exit,null);return item.events.filter(e=>e.event==='progress').at(-1);},
    value=>value?.rendered>=60&&value.received>=value.rendered&&value.renderedAgeMs<2000&&value.width===1280&&value.height===720,60000);
}
async function closeRaw(item){
  if(item.exit)return;
  item.child.stdin.end();
  try{await until(()=>item.exit,value=>value!==null,8000);}
  finally{if(!item.exit){item.child.kill('SIGKILL');await until(()=>item.exit,value=>value!==null,5000);}}
}
async function main(){
  const report={protocol:1,passed:false,testCommit:process.env.GITHUB_SHA,applicationCommit:process.env.APP_SOURCE_COMMIT,
    architecture:process.arch,cases:[],physicalInputInjected:false,audioEnabled:false,screenContentSaved:false,keychainValidated:false};
  try{
    stage='host-start';await host.action('host-start');await host.startTask;assert.equal(host.snapshot().phase,'running');
    stage='pair-two';const first=selected(await pair(identities.client,'Mac stream A')),second=selected(await pair(identities.wrong,'Mac stream B'));
    const admin=()=>jsonRequest({address:'127.0.0.1',port:48790,path:'/api/cliprelay/displays',method:'GET',identity:identities.wrong,
      trust:{cert:second.certificate},headers:{Authorization:hostState.authorization()},timeout:3000,limit:65536});
    const store={data:{legacySelected:false},selected:()=>first,identity:async()=>identities.client};
    viewer=new StreamViewer({directory:viewerDirectory,store,spawnProcess:launchViewer,onUpdate:()=>display?.reconcile()});
    display=new DisplayController({store,viewer});
    stage='production-video';await viewer.open(options);
    const visible=await until(()=>{
      const value=viewer.snapshot();assert.notEqual(value.phase,'error',value.error);return value;
    },value=>value.phase==='running'&&value.progress?.rendered>=60&&value.progress.renderedAgeMs<2000&&value.input.phase==='active',60000);
    const native=await admin();assert.equal(native.phase,'active');assert.equal(native.streams.length,1);
    const binding=native.streams[0];assert.ok(binding.firstFrame>0&&visible.progress.rendered>=binding.firstFrame);
    assert.equal(binding.owner,new crypto.X509Certificate(identities.client.cert).fingerprint256.replaceAll(':','').toLowerCase());
    assert.equal(visible.progress.width,1280);assert.equal(visible.progress.height,720);
    report.presentation={first:visible.progress,hostFirstFrame:binding.firstFrame};
    report.cases.push('packaged-Mac-capture-encode-encrypted-transport-and-Qt-present');
    stage='pause-and-reconstruct';await until(()=>display.snapshot(),value=>value.input.canPause&&value.canSelect);
    const record=viewer.currentSession();display.setInput({viewId:display.snapshot().viewId,paused:true});
    await until(()=>display.snapshot(),value=>value.input.canResume&&value.input.manualPaused);
    const epoch=record.input.epoch,pausedFrame=viewer.snapshot().progress.rendered;
    display.apply({viewId:display.snapshot().viewId,display:display.snapshot().capture});
    await until(()=>display.snapshot(),value=>value.result?.kind==='applied'&&value.input.canResume);
    const switched=await admin();assert.ok(switched.generation>native.generation);assert.equal(switched.streams[0].id,binding.id);
    assert.equal(record.input.epoch,epoch);assert.equal(viewer.inputPaused(record),true);
    await until(()=>viewer.snapshot().progress,value=>value?.rendered>pausedFrame&&value.rendered>=switched.streams[0].firstFrame);
    display.setInput({viewId:display.snapshot().viewId,paused:false});
    await until(()=>display.snapshot(),value=>value.input.canPause&&!value.input.manualPaused);
    assert.equal(viewer.currentSession(),record);assert.ok(record.input.epoch>epoch);
    report.presentation.last=viewer.snapshot().progress;
    report.cases.push('production-input-ACK-pause-display-reconstruction-and-fresh-frame-resume');
    stage='owner-eof';display.close();viewer.stop();await until(()=>viewer.child,value=>!value,10000);
    await until(admin,value=>value.streams.length===0);
    report.cases.push('desktop-owner-EOF-releases-native-stream');
    stage='raw-video';const receiver=rawViewer(first,identities.client);report.rawPresentation=await presented(receiver);
    await until(admin,value=>value.phase==='active'&&value.streams.length===1&&value.streams[0].firstFrame>0);
    stage='revoke-active';const current=(await host.action('host-status')).clients;
    const target=current.devices.find(device=>device.name==='Mac stream A');assert.ok(target?.enabled);
    const started=Date.now();await host.action('host-client-revoke',{viewId:current.viewId,uuid:target.uuid});
    await until(()=>receiver.exit,value=>value!==null,10000);
    assert.equal(receiver.child.stdin.writableEnded,false,'owner EOF caused termination');
    assert.equal(receiver.exit.signal,null);assert.notEqual(receiver.exit.code,0);
    const ended=receiver.events.filter(event=>event.event==='ended');assert.equal(ended.length,1);assert.equal(ended[0].reason,'host');
    await until(admin,value=>value.streams.length===0);
    await assert.rejects(exchange({address:'127.0.0.1',port:48784,path:'/serverinfo',method:'GET',identity:identities.client,trust:{cert:first.certificate},timeout:3000,limit:16384}));
    report.revocation={elapsedMs:Date.now()-started,exit:receiver.exit,event:ended[0],ownerPipeStayedOpen:true};
    report.cases.push('native-host-termination-after-revocation-without-client-control-polling');
    stage='preserved-client';const preserved=rawViewer(second,identities.wrong);report.preservedPresentation=await presented(preserved);
    await closeRaw(preserved);assert.deepEqual(preserved.exit,{code:0,signal:null});
    await until(admin,value=>value.streams.length===0);
    report.cases.push('other-paired-client-still-renders-and-EOF-releases-stream');
    stage='close-host';await host.close();
    for(const child of nativeChildren)assert.ok(child.exitCode!==null||child.signalCode!==null);
    assert.deepEqual(protectedDirectories.map(snapshot),before);assert.equal(process.env.HOME,originalHome);
    report.cases.push('all-owned-native-processes-reaped-and-default-state-preserved');
    report.ownedChildrenReaped=true;report.passed=true;
  }catch(error){
    report.failure={stage,code:error.code||error.message,host:host.snapshot().phase,viewer:viewer?.snapshot(),viewerExits,
      diagnostics:diagnostics.slice(-24),files:fileDiagnostics()};
    process.exitCode=1;
  }finally{
    display?.close();viewer?.stop();
    if(viewer)await until(()=>viewer.child,value=>!value,10000);
    for(const item of rawViewers)await closeRaw(item);
    await host.close();
    assert.deepEqual(protectedDirectories.map(snapshot),before);
    assert.ok(base.startsWith(fs.realpathSync(process.env.RUNNER_TEMP)+path.sep)&&path.basename(base).startsWith('cliprelay-native-mac-stream-'));
    fs.rmSync(base,{recursive:true,force:true});
    fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  }
  process.stdout.write(JSON.stringify(report)+'\n');
}
main().catch(error=>{console.error(JSON.stringify({stage,code:error.code||error.message}));process.exitCode=1;});
