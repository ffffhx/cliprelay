'use strict';
// A disposable action-owned host/viewer pair. Only fixed operations cross the
// authenticated fixture channel; host credentials and private identities do not.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {snapshot,encryptedStorage}=require('../test_macos_host_state.cjs');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,accept,timeout=15000){const end=Date.now()+timeout;while(true){const value=await read();if(accept(value))return value;assert.ok(Date.now()<end,'AUDIO_WAIT_TIMEOUT');await pause(80);}}
const safeLines=text=>text.split('\n').filter(line=>/audio|opus|error|fail/i.test(line)&&
  !/rikey|uniqueid|private key|certificate|authorization|credential|password|secret|token/i.test(line)).slice(-20).map(line=>line.slice(0,300));

function create({role,root,runner,env,machine,peerMachine}){
  assert.equal(process.platform,'darwin');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.notEqual(machine,peerMachine);
  const directory=fs.realpathSync(path.join(root,'.tools/audio-stream-mac'));
  assert.equal(directory,path.join(root,'.tools/audio-stream-mac'));
  const moduleAt=name=>require(path.join(directory,name+'.cjs'));
  const {HostController}=moduleAt('host-controller'),{HostState,configuration}=moduleAt('host-state');
  const {HostEngine}=moduleAt('host-engine'),{HostCompanion}=moduleAt('host-companion'),{HostSession}=moduleAt('host-session');
  const {pairHost}=moduleAt('pairing'),{jsonRequest}=moduleAt('paired-transport'),{envelope,executable}=moduleAt('stream-viewer');
  const ownedFile=name=>{const file=fs.realpathSync(process.env[name]);assert.ok(file.startsWith(runner+path.sep));assert.equal(file,process.env[name]);return file;};
  const toneFile=ownedFile('CLIPRELAY_AUDIO_TONE_FIXTURE'),observerFile=ownedFile('CLIPRELAY_AUDIO_OBSERVER');
  const faultFile=ownedFile('CLIPRELAY_AUDIO_FAULT_FIXTURE');
  const pairingFile=ownedFile('CLIPRELAY_PAIRING_TEST_FIXTURE');
  const toneFixture=JSON.parse(fs.readFileSync(ownedFile('CLIPRELAY_AUDIO_FIXTURE_RECEIPT'),'utf8'));
  assert.equal(toneFixture.testCommit,process.env.GITHUB_SHA);assert.equal(toneFixture.files.tone.path,toneFile);
  assert.equal(toneFixture.files.tone.sha256,hash(toneFile));
  assert.equal(toneFixture.files.fault.path,faultFile);assert.equal(toneFixture.files.fault.sha256,hash(faultFile));
  for(const [name,digest] of Object.entries(toneFixture.sources))assert.equal(hash(path.join(root,name)),digest);
  const observerFixture=JSON.parse(fs.readFileSync(ownedFile('CLIPRELAY_AUDIO_OBSERVER_RECEIPT'),'utf8'));
  assert.equal(observerFixture.testCommit,process.env.GITHUB_SHA);assert.equal(observerFixture.path,observerFile);
  assert.equal(observerFixture.binarySha256,hash(observerFile));
  assert.equal(observerFixture.sourceSha256,hash(path.join(root,'scripts/audio_fixture/observe.mm')));
  assert.equal(observerFixture.builderSha256,hash(path.join(root,'scripts/build_macos_audio_observer.py')));
  const viewerDirectory=path.join(directory,'stream-viewer'),viewerFile=executable(viewerDirectory);
  const viewerPin=JSON.parse(fs.readFileSync(path.join(directory,'stream-viewer-pin.json'),'utf8'));
  assert.equal(viewerPin.binarySha256,hash(viewerFile));assert.equal(viewerPin.manifestSha256,hash(path.join(viewerDirectory,'manifest.json')));
  const sdlFile=path.join(viewerDirectory,'runtime/ClipRelayStream.app/Contents/Frameworks/libSDL2.dylib');
  assert.equal(toneFixture.sdlSha256,hash(sdlFile));
  const sources={};
  for(const name of fs.readdirSync(directory).filter(name=>name.endsWith('.cjs'))){
    const file='windows/electron/mac/'+name;assert.equal(hash(path.join(directory,name)),hash(path.join(root,file)));sources[file]=hash(path.join(root,file));
  }
  const nativeEnv={...env,GITHUB_WORKSPACE:root,CLIPRELAY_AUDIO_OBSERVER:observerFile,CLIPRELAY_AUDIO_TONE_FIXTURE:toneFile};
  // Generate a fresh local identity without forwarding action credentials.
  const {execFileSync}=require('node:child_process');
  const identity=JSON.parse(execFileSync(pairingFile,[],{env:nativeEnv,timeout:10000,maxBuffer:32768,encoding:'utf8'})).client;
  const originalHome=process.env.HOME,protectedPaths=[path.join(os.homedir(),'.config/sunshine'),
    path.join(os.homedir(),'Library/Application Support/ClipRelay/host'),path.join(os.homedir(),'.config/ClipRelay'),
    path.join(os.homedir(),'Library/Preferences/local.cliprelay.ClipRelay Stream.plist')];
  const before=protectedPaths.map(snapshot),base=fs.mkdtempSync(path.join(runner,'cliprelay-isolated-audio-'));
  const children=[],nativeChildren=[];
  let hostState,engineChild,host,tone,viewer,tap,started=false,finished=false,stage='prepare';
  const report={protocol:1,testCommit:process.env.GITHUB_SHA,role,architecture:process.arch,machine,peerMachine,passed:false,
    sourceAndViewerShareAudioEnvironment:false,feedbackIsolationVerified:false,actualQtOutputObserved:false,
    physicalPlaybackVerified:false,productionPermissionUIVerified:false,videoPresentationVerified:false,
    microphoneInjectionVerified:false,automaticRecoveryVerified:false,productionRelayVerified:false,audioSamplesSaved:false,
    runtimeInstrumentation:role==='viewer'?'owned-viewer-only-dyld-one-real-SDL-queue-error':'none',
    observer:{...observerFixture,path:undefined},tone:{...toneFixture,files:Object.fromEntries(
      Object.entries(toneFixture.files).map(([name,value])=>[name,{sha256:value.sha256}]))},
    viewer:{run:viewerPin.run,commit:viewerPin.commit,outerSha256:viewerPin.outerSha256,archiveSha256:viewerPin.archiveSha256,
      manifestSha256:viewerPin.manifestSha256,binarySha256:viewerPin.binarySha256},
    components:JSON.parse(fs.readFileSync(path.join(root,'.tools/audio-stream-components.json'),'utf8')),
    testSha256:hash(__filename),sources,cases:[],observations:[],ciAudioConsent:[]};
  function launch(file,args=[]){
    const instrument=file===viewerFile;
    const child=spawn(file,args,{env:instrument?{...nativeEnv,DYLD_INSERT_LIBRARIES:faultFile,
      CLIPRELAY_AUDIO_FAULT_OWNER:String(process.pid),CLIPRELAY_AUDIO_FAULT_VIEWER:viewerFile}:nativeEnv,
      stdio:instrument?['pipe','pipe','pipe','pipe','pipe']:['pipe','pipe','pipe'],cwd:directory});nativeChildren.push(child);
    const item={child,exit:null,error:null,buffer:'',events:[],stderr:''};children.push(item);
    child.stdin.on('error',()=>{});child.once('error',()=>{item.error='AUDIO_CHILD_SPAWN'});child.once('close',(code,signal)=>{item.exit={code,signal}});
    child.stderr.on('data',data=>{item.stderr=(item.stderr+data.toString('utf8')).slice(-16384)});
    if(instrument){
      item.faultEvents=[];item.faultBuffer='';child.stdio[3].on('error',()=>{});child.stdio[4].on('error',()=>{});
      child.stdio[4].on('data',data=>{
        item.faultBuffer+=data.toString('utf8');
        if(item.faultBuffer.length>8192){item.error='AUDIO_FAULT_OUTPUT_LIMIT';child.kill('SIGKILL');return}
        while(item.faultBuffer.includes('\n')){
          const index=item.faultBuffer.indexOf('\n'),line=item.faultBuffer.slice(0,index);item.faultBuffer=item.faultBuffer.slice(index+1);
          try{
            const value=JSON.parse(line);assert.ok(item.faultEvents.length<64);assert.equal(value.pid,child.pid);
            assert.ok(['ready','opened','closed','queued','injected'].includes(value.event));item.faultEvents.push(value);
          }catch{item.error='AUDIO_FAULT_OUTPUT_INVALID';child.kill('SIGKILL');return}
        }
      });
    }
    child.stdout.on('data',data=>{
      item.buffer+=data.toString('utf8');if(item.buffer.length>65536){item.error='AUDIO_OUTPUT_LIMIT';child.kill('SIGKILL');return}
      while(item.buffer.includes('\n')){
        const index=item.buffer.indexOf('\n'),line=item.buffer.slice(0,index);item.buffer=item.buffer.slice(index+1);
        try{assert.ok(item.events.length<3000);item.events.push(JSON.parse(line))}catch{item.error='AUDIO_OUTPUT_INVALID';child.kill('SIGKILL');return}
      }
    });return item;
  }
  function alive(item){assert.equal(item.error,null);assert.equal(item.exit,null,'AUDIO_CHILD_EXIT');return item.events.at(-1)}
  async function command(item,text='state',event='state'){
    alive(item);const after=item.events.length;item.child.stdin.write(text+'\n');
    return until(()=>{alive(item);return item.events.slice(after).find(value=>value.event===event)},Boolean,4000);
  }
  async function closeChild(item){
    if(!item||item.exit)return;item.child.stdin.end();
    try{await until(()=>item.exit,Boolean,6000)}finally{if(!item.exit){item.child.kill('SIGKILL');await until(()=>item.exit,Boolean,3000)}}
  }
  const progress=()=>{alive(viewer);return viewer.events.filter(value=>value.event==='progress').at(-1)};
  const logsBefore=new Set(fs.readdirSync('/tmp').filter(name=>/^ClipRelayStream-[0-9]+\.log$/.test(name)));
  function diagnostic(error){
    report.failure={stage,code:/^[A-Z_0-9]{1,80}$/.test(error.code||'')?error.code:error.message?.slice(0,120),
      location:error.stack?.match(/mac_audio\.cjs:\d+:\d+/)?.[0],observer:tap?.events.at(-1),source:tone?.events.at(-1),
      video:viewer?.events.filter(v=>v.event==='progress').at(-1),viewerExit:viewer?.exit,viewerAudio:safeLines(viewer?.stderr||'')};
    report.faultEvents=viewer?.faultEvents;
    try{report.failure.engine=safeLines(hostState.read('engine.log',4*1024*1024).toString('utf8'))}catch{}
    try{report.failure.viewerAudioFile=fs.readdirSync('/tmp').filter(name=>/^ClipRelayStream-[0-9]+\.log$/.test(name)&&!logsBefore.has(name)).slice(0,2).flatMap(name=>{
      const file=path.join('/tmp',name),s=fs.lstatSync(file);return s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&s.size<4*1024*1024?safeLines(fs.readFileSync(file,'utf8')):[];
    })}catch{}
  }
  async function startTone(){tone=launch(toneFile);await until(()=>alive(tone),v=>v?.event==='ready');report.routeBefore=(await command(tone)).route}
  const admin=()=>jsonRequest({address:'127.0.0.1',port:48790,path:'/api/cliprelay/displays',method:'GET',identity,
    trust:{cert:hostState.read('cacert.pem',16384).toString('utf8')},headers:{Authorization:hostState.authorization()},timeout:3000,limit:65536});
  async function startHost(){
    assert.equal(role,'host');assert.equal(started,false);started=true;stage='host-start';await startTone();
    host=new HostController({directory,stateDirectory:path.join(base,'Host'),safeStorage:encryptedStorage(),localName:'Isolated audio CI',
      create({stateDirectory,safeStorage,enginePin,companionPin,onUpdate}){
        hostState=new HostState({directory:stateDirectory,safeStorage});const prepare=hostState.prepare.bind(hostState);
        hostState.prepare=name=>{const result=prepare(name);hostState.write('sunshine.conf',configuration(name)+
          'bind_address = 127.0.0.1\nmouse = disabled\nkeyboard = disabled\nstream_audio = enabled\n');return result};
        const launchNative=(file,args,settings)=>{
          const child=spawn(file,args,{...settings,env:{...nativeEnv,...Object.fromEntries(Object.entries(settings.env).filter(([key])=>['CLIPRELAY_HOST_STATE_DIR','CLIPRELAY_HOST_OWNER_PID'].includes(key)))}});
          nativeChildren.push(child);if(path.basename(file)==='Sunshine')engineChild=child;return child;
        };
        const engine=new HostEngine({directory:path.join(directory,'host-engine'),pin:enginePin,state:hostState,launch:launchNative});
        const companion=new HostCompanion({directory:path.join(directory,'host-companion'),pin:companionPin,state:hostState,launch:launchNative});
        return {session:new HostSession({engine,companion,onUpdate}),companion};
      }});
    await host.action('host-start');await host.startTask;assert.equal(host.snapshot().phase,'running');
    const config=hostState.read('sunshine.conf',65536).toString('utf8');
    assert.match(config,/^lan_encryption_mode = 2$/m);assert.match(config,/^wan_encryption_mode = 2$/m);
    report.hostRequiresEncryption=true;return {started:true,hostRequiresEncryption:true,machine};
  }
  let consentPressed=false,approvalUsed=false;
  async function operation(name,data){
    assert.equal(role,'host');assert.ok(data&&typeof data==='object'&&!Array.isArray(data));
    const keys=Object.keys(data).sort().join(',');
    if(name==='start'){assert.equal(keys,'');return startHost()}
    assert.ok(started&&!finished,'HOST_NOT_RUNNING');
    if(name==='approve'){
      assert.equal(keys,'owner,verification');assert.equal(approvalUsed,false);
      assert.match(data.verification,/^[A-F0-9]{4} [A-F0-9]{4} [A-F0-9]{4}$/);assert.match(data.owner,/^[a-f0-9]{64}$/);
      const status=await host.action('host-status'),request=status.requests.find(v=>v.verification===data.verification);assert.ok(request);
      await host.action('host-pair-approve',{id:request.id,generation:request.generation,verification:request.verification});
      approvalUsed=true;report.pairedOwner=data.owner;return {approved:true};
    }
    if(name==='consent'){
      assert.equal(keys,'');assert.ok(engineChild&&engineChild.exitCode===null&&engineChild.signalCode===null);
      if(!consentPressed&&report.ciAudioConsent.length<8){
        const decision=await command(tone,'allow-audio '+engineChild.pid,'audio-consent');assert.equal(decision.ownedEngineVerified,true);
        report.ciAudioConsent.push(decision);consentPressed=decision.pressed;
      }return {pressed:consentPressed};
    }
    if(name==='source'){
      assert.equal(keys,'tone');assert.ok(['quiet','low','high','state'].includes(data.tone));
      const value=await command(tone,data.tone);assert.equal(value.errors,0);report.observations.push({frequency:value.frequency,callbacks:value.callbacks});return value;
    }
    if(name==='streams'){
      assert.equal(keys,'');const value=await admin();assert.ok(Array.isArray(value.streams));
      assert.ok(value.streams.every(v=>v.owner===report.pairedOwner));return {streams:value.streams.map(v=>({owner:v.owner}))};
    }
    if(name==='finish'){
      assert.equal(keys,'');assert.equal((await admin()).streams.length,0);
      report.cases.push('viewer-EOF-releases-native-stream');await finish();finished=true;
      report.feedbackIsolationVerified=true;report.passed=true;return {finished:true,routePreserved:true,ownedChildrenReaped:true};
    }
    throw Error('AUDIO_OPERATION_INVALID');
  }
  let busy=false;
  async function handle(req,res){
    if(!/^\/audio\/(start|approve|consent|source|streams|finish)$/.test(req.url)||req.method!=='POST')return false;
    assert.equal(busy,false);busy=true;
    try{
      assert.equal(req.headers['transfer-encoding'],undefined);const length=Number(req.headers['content-length']);
      assert.ok(Number.isSafeInteger(length)&&length>=2&&length<=4096);let bytes=0,chunks=[];
      for await(const chunk of req){bytes+=chunk.length;assert.ok(bytes<=4096);chunks.push(chunk)}assert.equal(bytes,length);
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.end(JSON.stringify(await operation(req.url.slice(7),data)));return true;
    }catch(error){diagnostic(error);throw error}finally{busy=false}
  }
  async function rpc(name,data={}){
    const response=await fetch('http://127.0.0.1:48830/audio/'+name,{method:'POST',headers:{'Content-Type':'application/json',Connection:'close'},
      body:JSON.stringify(data),signal:AbortSignal.timeout(20000)});assert.equal(response.status,200,'AUDIO_HOST_OPERATION_FAILED');return response.json();
  }
  async function finish(){
    await host?.close();
    if(tone&&!tone.exit){await command(tone,'quiet');report.routeAfter=(await command(tone)).route;assert.deepEqual(report.routeAfter,report.routeBefore)}
    await closeChild(tone);assert.deepEqual(tone?.exit,{code:0,signal:null});
    for(const child of nativeChildren)assert.ok(child.exitCode!==null||child.signalCode!==null);
    assert.deepEqual(protectedPaths.map(snapshot),before);assert.equal(process.env.HOME,originalHome);
    report.ownedChildrenReaped=true;report.defaultProfilePreserved=true;report.cases.push('route-rate-buffer-and-default-profile-preserved-with-owned-processes-reaped');
  }
  async function run(){
    assert.equal(role,'viewer');
    try{
      stage='remote-host-start';const start=await rpc('start');assert.equal(start.machine,peerMachine);assert.equal(start.hostRequiresEncryption,true);report.hostRequiresEncryption=true;
      stage='viewer-route';await startTone();
      stage='pair';const owner=new crypto.X509Certificate(identity.cert).fingerprint256.replaceAll(':','').toLowerCase();report.pairedOwner=owner;
      const peer=await pairHost({address:'127.0.0.1',port:48789,identity,name:'Separate audio CI',onVerification:async value=>{
        assert.deepEqual(await rpc('approve',{verification:value.verification,owner}),{approved:true});
      }});
      stage='viewer-start';viewer=launch(viewerFile,['--cliprelay-session']);
      await until(()=>{alive(viewer);return viewer.faultEvents[0]},v=>v?.event==='ready',5000);
      viewer.child.stdin.write(envelope({...peer,clientId:crypto.randomBytes(16).toString('hex')},identity,{width:1280,height:720,fps:30,bitrate:6000,fullscreen:false},true,false));
      await until(progress,v=>v?.received>=5&&v.receivedAgeMs<2000,60000);
      assert.deepEqual((await rpc('streams')).streams,[{owner}]);
      stage='observer-start';tap=launch(observerFile,['--viewer',String(viewer.child.pid)]);
      let nextConsent=0,observerAllowed=false;
      async function consent(){
        if(Date.now()<nextConsent)return;nextConsent=Date.now()+2000;
        await rpc('consent');
        if(!observerAllowed&&report.ciAudioConsent.length<8){
          const value=await command(tone,'allow-observer '+tap.child.pid,'audio-consent');assert.equal(value.ownedObserverVerified,true);
          report.ciAudioConsent.push(value);observerAllowed=value.pressed;
        }
      }
      await until(async()=>{await consent();return alive(tap)},v=>v?.event==='ready',15000);
      async function outputPhase(name,hz){
        const previous=await command(tap),video=progress(),source=await rpc('source',{tone:name});assert.equal(source.frequency,hz);
        let last=previous.windows,matched=[];const deadline=Date.now()+15000;
        while(matched.length<2){
          assert.ok(Date.now()<deadline,'QT_AUDIO_PHASE_TIMEOUT');await consent();
          const value=await command(tap);assert.equal(value.invalid,0);const fresh=progress();assert.ok(fresh&&fresh.receivedAgeMs<2000,'QT_VIDEO_NOT_FLOWING');
          if(value.windows>last){
            last=value.windows;const target=hz===1000?value.low:value.high,other=hz===1000?value.high:value.low;
            const match=hz===0?Math.max(value.low,value.high,value.rms)<.001:target>.005&&target<.06&&other<target*.15&&value.rms>.003&&value.rms<.06;
            if(value.callbacks===0||value.windows<previous.windows+2||fresh.received<=video.received||!match)matched=[];else matched.push({audio:value,video:fresh});
          }await pause(80);
        }
        const after=await rpc('source',{tone:'state'});assert.equal(after.errors,0);assert.ok(after.callbacks>source.callbacks);
        return {frequency:hz,afterWindow:previous.windows,sourceCallbacks:after.callbacks,windows:matched};
      }
      for(const [index,[name,hz]] of [['quiet',0],['low',1000],['high',1600],['quiet',0]].entries()){
        stage='output-'+index+'-'+name;report.observations.push(await outputPhase(name,hz));
      }
      report.actualQtOutputObserved=true;report.feedbackIsolationVerified=true;
      report.cases.push('separate-Mac-shipped-Qt-output-silence-1000Hz-1600Hz-silence');
      stage='recovery-before-fault';
      const beforeOutput=await outputPhase('low',1000),beforeVideo=progress(),originalPid=viewer.child.pid;
      const initial=viewer.faultEvents.filter(v=>v.event==='queued').at(-1);assert.ok(initial&&initial.generation>0);
      assert.equal(viewer.faultEvents.filter(v=>v.event==='injected').length,0);
      assert.deepEqual((await rpc('streams')).streams,[{owner}]);
      stage='recovery-inject';viewer.child.stdio[3].write('F');
      const recovered=await until(()=>{alive(viewer);return viewer.faultEvents.find(v=>v.event==='queued'&&v.generation>initial.generation)},Boolean,15000);
      const injected=viewer.faultEvents.filter(v=>v.event==='injected');assert.equal(injected.length,1);
      assert.ok(injected[0].result<0&&injected[0].errorPresent);assert.equal(injected[0].generation,initial.generation);
      const lifecycle=viewer.faultEvents.slice(viewer.faultEvents.indexOf(injected[0]),viewer.faultEvents.indexOf(recovered)+1);
      assert.deepEqual(lifecycle.map(v=>v.event),['injected','closed','opened','queued']);
      assert.equal(lifecycle[1].device,initial.device);assert.equal(lifecycle[1].generation,initial.generation);
      assert.equal(lifecycle[2].generation,initial.generation+1);assert.equal(recovered.generation,initial.generation+1);
      assert.equal(lifecycle[2].device,recovered.device);assert.ok(recovered.device>0);
      report.recovery={beforeOutput,pid:originalPid,owner,beforeVideo,lifecycle,observations:[]};
      for(const [name,hz] of [['low',1000],['high',1600],['quiet',0]]){
        stage='recovery-output-'+name;report.recovery.observations.push(await outputPhase(name,hz));
      }
      alive(viewer);assert.equal(viewer.child.pid,originalPid);assert.deepEqual((await rpc('streams')).streams,[{owner}]);
      report.recovery.afterVideo=progress();assert.ok(report.recovery.afterVideo.received>beforeVideo.received);
      assert.equal(hash(viewerFile),viewerPin.binarySha256);assert.equal(hash(sdlFile),toneFixture.sdlSha256);
      report.recovery.sameProcessAndPair=true;report.recovery.viewerAndSDLBytesUnchanged=true;
      report.automaticRecoveryVerified=true;report.cases.push('same-native-Session-recovers-one-real-SDL-queue-error-and-fresh-audio-output');
      stage='observer-eof';await closeChild(tap);assert.deepEqual(tap.exit,{code:0,signal:null});
      assert.deepEqual(tap.events.at(-1),{event:'closed',stopped:true,ioDestroyed:true,aggregateDestroyed:true,tapDestroyed:true});
      report.observerClosed=tap.events.at(-1);report.cases.push('observer-EOF-releases-private-tap-and-aggregate');
      stage='viewer-eof';await closeChild(viewer);assert.deepEqual(viewer.exit,{code:0,signal:null});
      report.faultEvents=viewer.faultEvents;
      assert.equal(viewer.faultEvents.at(-1).event,'closed');assert.equal(viewer.faultEvents.at(-1).generation,recovered.generation);
      await until(()=>rpc('streams'),v=>v.streams.length===0);report.cases.push('viewer-EOF-releases-native-stream');
      stage='host-finish';assert.deepEqual(await rpc('finish'),{finished:true,routePreserved:true,ownedChildrenReaped:true});
      stage='viewer-finish';await finish();finished=true;report.passed=true;
    }catch(error){diagnostic(error);throw error}
  }
  async function close(){
    const errors=[];
    for(const item of [tap,viewer])try{await closeChild(item)}catch{errors.push('viewer-or-tap')}
    try{await host?.close()}catch{errors.push('host')}
    if(tone&&!tone.exit)try{await command(tone,'quiet')}catch{errors.push('quiet')}
    try{await closeChild(tone)}catch{errors.push('tone')}
    report.exits=children.map(v=>v.exit);report.nativeExits=nativeChildren.map(v=>({code:v.exitCode,signal:v.signalCode}));
    if(errors.length||report.nativeExits.some(v=>v.code===null&&v.signal===null)){report.cleanupErrors=errors;report.passed=false;throw Error('AUDIO_CLEANUP_FAILED')}
  }
  return {report,run,handle,close,complete:()=>finished};
}
module.exports={create};
