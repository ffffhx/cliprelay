'use strict';
// Actual shipped Qt/SDL output, observed by a private tap on only the owned
// viewer. The tap mutes this CI viewer to avoid same-machine audio feedback.
// This does not prove physical speakers, GUI permissions or video presentation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {snapshot,encryptedStorage}=require('./test_macos_host_state.cjs');
assert.equal(process.platform,'darwin');assert.equal(process.env.GITHUB_ACTIONS,'true');
const directory=fs.realpathSync(process.argv[2]),reportPath=path.resolve(process.argv[3]);
assert.equal(directory,path.join(fs.realpathSync(process.env.GITHUB_WORKSPACE),'.tools/audio-stream-mac'));
const moduleAt=name=>require(path.join(directory,name+'.cjs'));
const {HostController}=moduleAt('host-controller'),{HostState,configuration}=moduleAt('host-state');
const {HostEngine}=moduleAt('host-engine'),{HostCompanion}=moduleAt('host-companion'),{HostSession}=moduleAt('host-session');
const {pairHost}=moduleAt('pairing'),{jsonRequest}=moduleAt('paired-transport'),{envelope,executable}=moduleAt('stream-viewer');
const {identities}=require('../windows/tests/mac-pairing-fixture.cjs');
const runner=fs.realpathSync(process.env.RUNNER_TEMP)+path.sep,hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ownedFile=variable=>{const file=fs.realpathSync(process.env[variable]);assert.ok(file.startsWith(runner));return file;};
const observerFile=ownedFile('CLIPRELAY_AUDIO_OBSERVER'),toneFile=ownedFile('CLIPRELAY_AUDIO_TONE_FIXTURE');
const observerFixture=JSON.parse(fs.readFileSync(ownedFile('CLIPRELAY_AUDIO_OBSERVER_RECEIPT'),'utf8'));
assert.equal(observerFixture.testCommit,process.env.GITHUB_SHA);assert.equal(observerFixture.path,observerFile);
assert.equal(observerFixture.binarySha256,hash(observerFile));
assert.equal(observerFixture.sourceSha256,hash(path.join(__dirname,'audio_fixture/observe.mm')));
assert.equal(observerFixture.builderSha256,hash(path.join(__dirname,'build_macos_audio_observer.py')));
const toneFixture=JSON.parse(fs.readFileSync(ownedFile('CLIPRELAY_AUDIO_FIXTURE_RECEIPT'),'utf8'));
assert.equal(toneFixture.testCommit,process.env.GITHUB_SHA);assert.equal(toneFixture.files.tone.path,toneFile);
assert.equal(toneFixture.files.tone.sha256,hash(toneFile));
assert.equal(toneFixture.sources['scripts/audio_fixture/tone.mm'],hash(path.join(__dirname,'audio_fixture/tone.mm')));
const viewerDirectory=path.join(directory,'stream-viewer'),viewerFile=executable(viewerDirectory);
const viewerPin=JSON.parse(fs.readFileSync(path.join(directory,'stream-viewer-pin.json'),'utf8'));
assert.match(viewerPin.commit,/^[a-f0-9]{40}$/);assert.equal(viewerPin.binarySha256,hash(viewerFile));
assert.equal(viewerPin.manifestSha256,hash(path.join(viewerDirectory,'manifest.json')));
const originalHome=process.env.HOME,protectedPaths=[path.join(os.homedir(),'.config/sunshine'),
  path.join(os.homedir(),'Library/Application Support/ClipRelay/host'),path.join(os.homedir(),'.config/ClipRelay'),
  path.join(os.homedir(),'Library/Preferences/local.cliprelay.ClipRelay Stream.plist')];
const before=protectedPaths.map(snapshot),base=fs.mkdtempSync(path.join(runner,'cliprelay-qt-audio-'));
const nativeChildren=[],children=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate,timeout=15000){
  const end=Date.now()+timeout;
  while(true){const value=await read();if(predicate(value))return value;if(Date.now()>end)throw Error('PLAYBACK_WAIT_TIMEOUT');await pause(50);}
}
let hostState,tone,viewer,tap,stage='prepare';
const host=new HostController({directory,stateDirectory:path.join(base,'Host'),safeStorage:encryptedStorage(),localName:'Qt audio CI',
  create({stateDirectory,safeStorage,enginePin,companionPin,onUpdate}){
    hostState=new HostState({directory:stateDirectory,safeStorage});const prepare=hostState.prepare.bind(hostState);
    hostState.prepare=name=>{const result=prepare(name);hostState.write('sunshine.conf',configuration(name)+
      'bind_address = 127.0.0.1\nmouse = disabled\nkeyboard = disabled\nstream_audio = enabled\n');return result;};
    const launch=(file,args,settings)=>{const child=spawn(file,args,settings);nativeChildren.push(child);return child;};
    const engine=new HostEngine({directory:path.join(directory,'host-engine'),pin:enginePin,state:hostState,launch});
    const companion=new HostCompanion({directory:path.join(directory,'host-companion'),pin:companionPin,state:hostState,launch});
    return {session:new HostSession({engine,companion,onUpdate}),companion};
  }});
function launch(file,args=[]){
  const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','QT_QPA_PLATFORM','QT_PLUGIN_PATH','QML2_IMPORT_PATH'])delete env[key];
  const child=spawn(file,args,{env,stdio:['pipe','pipe','pipe'],cwd:directory});nativeChildren.push(child);
  const item={child,exit:null,error:null,buffer:'',events:[],stderr:''};children.push(item);
  child.stdin.on('error',()=>{});child.once('error',()=>{item.error='PLAYBACK_CHILD_SPAWN';});
  child.once('close',(code,signal)=>{item.exit={code,signal};});
  child.stderr.on('data',data=>{item.stderr=(item.stderr+data.toString('utf8')).slice(-16384);});
  child.stdout.on('data',data=>{
    item.buffer+=data.toString('utf8');
    if(item.buffer.length>65536){item.error='PLAYBACK_OUTPUT_LIMIT';child.kill('SIGKILL');return;}
    while(item.buffer.includes('\n')){
      const end=item.buffer.indexOf('\n'),line=item.buffer.slice(0,end);item.buffer=item.buffer.slice(end+1);
      try{assert.ok(item.events.length<3000);item.events.push(JSON.parse(line));}
      catch{item.error='PLAYBACK_OUTPUT_INVALID';child.kill('SIGKILL');return;}
    }
  });return item;
}
function alive(item){assert.equal(item.error,null);assert.equal(item.exit,null,'PLAYBACK_CHILD_EXIT');return item.events.at(-1);}
function progress(){alive(viewer);return viewer.events.filter(value=>value.event==='progress').at(-1);}
async function command(item,text='state'){
  alive(item);const after=item.events.length;item.child.stdin.write(text+'\n');
  return until(()=>{alive(item);return item.events.slice(after).find(value=>value.event==='state');},Boolean,3000);
}
async function close(item){
  if(!item||item.exit)return;
  item.child.stdin.end();
  try{await until(()=>item.exit,Boolean,6000);}
  finally{if(!item.exit){item.child.kill('SIGKILL');await until(()=>item.exit,Boolean,6000);}}
}
const safeLines=text=>text.split('\n').filter(line=>/audio|opus|error|fail/i.test(line)&&
  !/rikey|uniqueid|private key|certificate|authorization|credential|password|secret|token/i.test(line)).slice(-20).map(line=>line.slice(0,300));
const report={protocol:1,testCommit:process.env.GITHUB_SHA,architecture:process.arch,passed:false,
  scope:'Development packaged engine and pinned shipped Qt viewer, loopback; private muted process tap observes actual Qt output. No physical speakers, product permission UI, video presentation or automatic error recovery claim.',
  actualQtOutputObserved:false,physicalPlaybackVerified:false,productionPermissionUIVerified:false,videoPresentationVerified:false,
  microphoneInjectionVerified:false,automaticRecoveryVerified:false,audioSamplesSaved:false,
  observer:{...observerFixture,path:undefined},toneSha256:toneFixture.files.tone.sha256,
  viewer:{run:viewerPin.run,commit:viewerPin.commit,outerSha256:viewerPin.outerSha256,archiveSha256:viewerPin.archiveSha256,
    manifestSha256:viewerPin.manifestSha256,binarySha256:viewerPin.binarySha256},
  testSha256:hash(__filename),cases:[],observations:[]};
async function main(){
  try{
    stage='tone-start';tone=launch(toneFile);await until(()=>alive(tone),value=>value?.event==='ready');
    report.routeBefore=(await command(tone)).route;
    stage='host-start';await host.action('host-start');await host.startTask;assert.equal(host.snapshot().phase,'running');
    const config=hostState.read('sunshine.conf',65536).toString('utf8');
    assert.match(config,/^lan_encryption_mode = 2$/m);assert.match(config,/^wan_encryption_mode = 2$/m);
    report.hostRequiresEncryption=true;
    stage='pair';const identity=identities.client;
    const peer=await pairHost({address:'127.0.0.1',port:48789,identity,name:'Qt audio CI',onVerification:async verification=>{
      const status=await host.action('host-status'),request=status.requests.find(item=>item.verification===verification.verification);
      assert.ok(request);await host.action('host-pair-approve',{id:request.id,generation:request.generation,verification:request.verification});
    }});
    const admin=()=>jsonRequest({address:'127.0.0.1',port:48790,path:'/api/cliprelay/displays',method:'GET',identity,
      trust:{cert:peer.certificate},headers:{Authorization:hostState.authorization()},timeout:3000,limit:65536});
    stage='viewer-start';viewer=launch(viewerFile,['--cliprelay-session']);
    viewer.child.stdin.write(envelope({...peer,clientId:crypto.randomBytes(16).toString('hex')},identity,
      {width:1280,height:720,fps:30,bitrate:6000,fullscreen:false},true,false));
    await until(progress,value=>value?.received>=5&&value.receivedAgeMs<2000,60000);
    const stream=await admin();assert.equal(stream.streams.length,1);
    assert.equal(stream.streams[0].owner,new crypto.X509Certificate(identity.cert).fingerprint256.replaceAll(':','').toLowerCase());
    stage='observe-viewer';tap=launch(observerFile,['--viewer',String(viewer.child.pid)]);
    await until(()=>alive(tap),value=>value?.event==='ready',15000);
    for(const [name,hz] of [['quiet',0],['low',1000],['high',1600],['quiet',0]]){
      stage='output-'+name;
      const before=await command(tap),video=progress(),source=await command(tone,name);assert.equal(source.frequency,hz);
      let last=before.windows,matched=[];const deadline=Date.now()+15000;
      while(matched.length<2){
        assert.ok(Date.now()<deadline,'QT_AUDIO_PHASE_TIMEOUT');
        const value=await command(tap);assert.equal(value.invalid,0);assert.ok(value.callbacks>0);
        const fresh=progress();assert.ok(fresh&&fresh.receivedAgeMs<2000,'QT_VIDEO_NOT_FLOWING');
        if(value.windows>last){
          last=value.windows;
          const target=hz===1000?value.low:value.high,other=hz===1000?value.high:value.low;
          const match=hz===0?Math.max(value.low,value.high,value.rms)<.001:
            target>.005&&target<.06&&other<target*.15&&value.rms>.003&&value.rms<.06;
          if(value.windows<before.windows+2||fresh.received<=video.received||!match)matched=[];
          else matched.push({audio:value,video:fresh});
        }
        await pause(80);
      }
      const after=await command(tone);assert.equal(after.errors,0);assert.ok(after.callbacks>source.callbacks);
      report.observations.push({frequency:hz,afterWindow:before.windows,sourceCallbacks:after.callbacks,windows:matched});
    }
    report.actualQtOutputObserved=true;
    report.cases.push('shipped-Qt-output-silence-1000Hz-1600Hz-silence-through-owned-process-tap');
    stage='observer-eof';await close(tap);assert.deepEqual(tap.exit,{code:0,signal:null});
    assert.deepEqual(tap.events.at(-1),{event:'closed',stopped:true,ioDestroyed:true,aggregateDestroyed:true,tapDestroyed:true});
    report.cases.push('observer-EOF-releases-private-tap-and-aggregate');
    stage='viewer-eof';await close(viewer);assert.deepEqual(viewer.exit,{code:0,signal:null});
    await until(admin,value=>value.streams.length===0);report.cases.push('viewer-EOF-releases-native-stream');
    stage='host-close';await host.close();report.routeAfter=(await command(tone)).route;
    assert.deepEqual(report.routeAfter,report.routeBefore);await close(tone);assert.deepEqual(tone.exit,{code:0,signal:null});
    for(const child of nativeChildren)assert.ok(child.exitCode!==null||child.signalCode!==null);
    assert.deepEqual(protectedPaths.map(snapshot),before);assert.equal(process.env.HOME,originalHome);
    report.ownedChildrenReaped=true;report.defaultProfilePreserved=true;
    report.cases.push('route-rate-buffer-and-default-profile-preserved-with-owned-processes-reaped');report.passed=true;
  }catch(error){
    report.failure={stage,code:error.code||error.message,location:error.stack?.match(/test_macos_audio_playback\.cjs:\d+:\d+/)?.[0],
      observer:tap?.events.at(-1),source:tone?.events.at(-1),viewerExit:viewer?.exit,
      video:viewer?.events.filter(value=>value.event==='progress').at(-1),viewerAudio:safeLines(viewer?.stderr||'')};
    try{report.failure.engine=safeLines(hostState.read('engine.log',4*1024*1024).toString('utf8'));}catch{}
    process.exitCode=1;
  }finally{
    const cleanup=[];
    for(const item of [tap,viewer])try{await close(item);}catch{cleanup.push('viewer-or-tap');}
    try{await host.close();}catch{cleanup.push('host');}
    if(tone&&!tone.exit)try{await command(tone,'quiet');}catch{cleanup.push('quiet');}
    try{await close(tone);}catch{cleanup.push('tone');}
    if(cleanup.length){report.cleanupErrors=cleanup;report.passed=false;process.exitCode=1;}
    report.exits=children.map(item=>item.exit);fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({passed:report.passed,stage,cases:report.cases,architecture:process.arch}));
  }
}
main().catch(()=>{process.exitCode=1;});
