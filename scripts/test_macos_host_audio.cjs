'use strict';
// Actual packaged host engine -> encrypted Moonlight transport -> Opus decode.
// Owned synthetic source only, disposable CI. No audio samples are retained.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const {snapshot,encryptedStorage}=require('./test_macos_host_state.cjs');
const {validate:validateReceipt,SOURCES}=require('./audio_fixture/receipt.cjs');
assert.equal(process.platform,'darwin');assert.equal(process.env.GITHUB_ACTIONS,'true');
const directory=path.resolve(process.argv[2]),reportPath=path.resolve(process.argv[3]);
const complete=process.env.CLIPRELAY_COMPLETE_AUDIO_TEST==='1';
const expectedDirectory=path.join(process.env.GITHUB_WORKSPACE,complete?
  `.tools/mac-electron/ClipRelay-darwin-${process.arch}/ClipRelay.app/Contents/Resources/app/mac`:'.tools/audio-stream-mac');
assert.equal(fs.realpathSync(directory),expectedDirectory);
if(complete)assert.equal(process.env.APP_SOURCE_COMMIT,process.env.GITHUB_SHA);
const {HostController}=require(path.join(directory,'host-controller.cjs'));
const {HostState,configuration}=require(path.join(directory,'host-state.cjs'));
const {HostEngine}=require(path.join(directory,'host-engine.cjs'));
const {HostCompanion}=require(path.join(directory,'host-companion.cjs'));
const {HostSession}=require(path.join(directory,'host-session.cjs'));
const {pairHost}=require(path.join(directory,'pairing.cjs'));
const {exchange,jsonRequest}=require(path.join(directory,'paired-transport.cjs'));
const {xmlValue}=require(path.join(directory,'paired-crypto.cjs'));
const {identities}=require('../windows/tests/mac-pairing-fixture.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate,timeout=15000){
  const end=Date.now()+timeout;
  while(true){const value=await read();if(predicate(value))return value;if(Date.now()>end)throw Error('AUDIO_WAIT_TIMEOUT');await pause(50);}
}
const protectedDirectories=[path.join(os.homedir(),'.config/sunshine'),path.join(os.homedir(),'Library/Application Support/ClipRelay/host')];
const before=protectedDirectories.map(snapshot),originalHome=process.env.HOME;
const base=fs.realpathSync(fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'cliprelay-native-audio-')));
const nativeChildren=[],fixtures=[];
let hostState,stage='prepare',tone,decoder,engineChild;
const host=new HostController({directory,stateDirectory:path.join(base,'Host'),safeStorage:encryptedStorage(),localName:'Native audio CI',
  create({stateDirectory,safeStorage,enginePin,companionPin,onUpdate}){
    hostState=new HostState({directory:stateDirectory,safeStorage});
    const prepare=hostState.prepare.bind(hostState);
    hostState.prepare=name=>{
      const result=prepare(name);
      hostState.write('sunshine.conf',configuration(name).replace('min_log_level = 2','min_log_level = 0')+
        'bind_address = 127.0.0.1\nmouse = disabled\nkeyboard = disabled\nstream_audio = enabled\n');
      return result;
    };
    const launch=(file,args,settings)=>{
      const child=spawn(file,args,settings);nativeChildren.push(child);
      if(file===path.join(directory,'host-engine',require(path.join(directory,'host-engine-artifact.cjs')).EXECUTABLE))engineChild=child;
      return child;
    };
    const engine=new HostEngine({directory:path.join(directory,'host-engine'),pin:enginePin,state:hostState,launch});
    const companion=new HostCompanion({directory:path.join(directory,'host-companion'),pin:companionPin,state:hostState,launch});
    return {session:new HostSession({engine,companion,onUpdate}),companion};
  }});
function verifyFixture(){
  const root=fs.realpathSync(process.env.RUNNER_TEMP)+path.sep;
  const file=fs.realpathSync(process.env.CLIPRELAY_AUDIO_FIXTURE_RECEIPT);
  assert.ok(file.startsWith(root)&&fs.statSync(file).size<16384);
  const receipt=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(receipt.protocol,1);assert.equal(receipt.testCommit,process.env.GITHUB_SHA);assert.equal(receipt.architecture,process.arch);
  const sources=[...SOURCES];
  assert.deepEqual(Object.keys(receipt.sources).sort(),sources.sort());
  const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for(const name of sources)assert.equal(hash(path.join(__dirname,'..',name)),receipt.sources[name]);
  assert.equal(receipt.commonCommit,JSON.parse(fs.readFileSync(path.join(__dirname,'../engine/desktop-client/upstream.json'),'utf8')).commonCommit);
  const binarySha256={};
  for(const [name,variable] of [['decoder','CLIPRELAY_AUDIO_DECODE_FIXTURE'],['tone','CLIPRELAY_AUDIO_TONE_FIXTURE']]){
    const binary=fs.realpathSync(process.env[variable]);assert.ok(binary.startsWith(root));
    assert.equal(binary,receipt.files[name].path);assert.equal(hash(binary),receipt.files[name].sha256);
    binarySha256[name]=receipt.files[name].sha256;
  }
  const {files,...metadata}=receipt;return {...metadata,binarySha256};
}
function launchFixture(variable){
  const child=spawn(fs.realpathSync(process.env[variable]),[],{stdio:['pipe','pipe','pipe']});nativeChildren.push(child);
  const item={child,events:[],buffer:'',stderr:'',error:null,exit:null};fixtures.push(item);
  child.stdin.on('error',()=>{});child.once('error',()=>{item.error='AUDIO_FIXTURE_SPAWN';});
  child.once('close',(code,signal)=>{item.exit={code,signal};});
  child.stderr.on('data',data=>{item.stderr=(item.stderr+data.toString('utf8')).slice(-4096);});
  child.stdout.on('data',data=>{
    item.buffer+=data.toString('utf8');
    if(item.buffer.length>16384){item.error='AUDIO_FIXTURE_OUTPUT_LIMIT';child.kill('SIGKILL');return;}
    while(item.buffer.includes('\n')){
      const end=item.buffer.indexOf('\n'),line=item.buffer.slice(0,end);item.buffer=item.buffer.slice(end+1);
      try{assert.ok(item.events.length<2000);item.events.push(JSON.parse(line));}
      catch{item.error='AUDIO_FIXTURE_PROTOCOL';child.kill('SIGKILL');return;}
    }
  });return item;
}
const alive=item=>{assert.equal(item.error,null);assert.equal(item.exit,null,'AUDIO_FIXTURE_EXIT');return item.events.at(-1);};
async function command(value,event='state'){
  alive(tone);const after=tone.events.length;tone.child.stdin.write(value+'\n');
  const state=await until(()=>{alive(tone);return tone.events.slice(after).find(item=>item.event===event);},Boolean,5000);
  if(event==='state')assert.equal(state.errors,0);return state;
}
async function close(item){
  if(!item||item.exit)return;
  item.child.stdin.end();
  try{await until(()=>item.exit,Boolean,5000);}
  finally{if(!item.exit){item.child.kill('SIGKILL');await until(()=>item.exit,Boolean,5000);}}
}
function diagnostics(){
  let text='';try{text=hostState.read('engine.log',8*1024*1024).toString('utf8');}catch{}
  return text.split('\n').filter(line=>/audio|tap|aggregate|permission|microphone|error|fail|capture/i.test(line)&&
    !/rikey|pin=|uniqueid|PRIVATE KEY|certificate|authorization|credential|password|secret|token/i.test(line)).slice(-45).map(line=>line.slice(0,400));
}
function audioStack(){
  if(!engineChild||engineChild.exitCode!==null||engineChild.signalCode!==null)return {available:false,lines:[]};
  // Sample only the engine child this fixture owns; no process discovery or
  // memory dump. Keep audio/TCC stack symbols, never keys, arguments or frames.
  const sampled=spawnSync('/usr/bin/sudo',['-n','/usr/bin/sample',String(engineChild.pid),'1','1','-mayDie'],
    {encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
  return {available:true,status:sampled.status,error:sampled.error?.code||null,
    lines:String(sampled.stdout||'').split('\n').filter(line=>/Audio|audio|TCC|tcc|microphone|setupSystemTap|createProcessTap/.test(line)&&
      !/PRIVATE KEY|authorization|credential|password|secret|token/i.test(line)).slice(0,50).map(line=>line.slice(0,400))};
}
function audioConsentLog(){
  // Read only. The disposable runner's system consent decision is not changed.
  const query=spawnSync('/usr/bin/log',['show','--last','2m','--style','compact','--info','--debug','--predicate',
    'process == "tccd" AND (eventMessage CONTAINS[c] "AudioCapture" OR eventMessage CONTAINS[c] "SystemAudio" OR eventMessage CONTAINS[c] "Microphone")'],
    {encoding:'utf8',timeout:7000,maxBuffer:512*1024});
  return {status:query.status,error:query.error?.code||null,lines:String(query.stdout||'').split('\n')
    .filter(line=>/AudioCapture|SystemAudio|Microphone/.test(line)).slice(-30).map(line=>line.slice(0,700))};
}
const report={protocol:1,testCommit:process.env.GITHUB_SHA,applicationCommit:complete?process.env.APP_SOURCE_COMMIT:null,
  architecture:process.arch,passed:false,componentOnly:!complete,hostScope:complete?'complete-app-host':'development-components',
  source:'owned-synthetic-tone',receiver:'standalone-opus-and-software-h264',productionPlaybackVerified:false,
  productionPermissionUIVerified:false,microphoneInjectionVerified:false,keychainValidated:false,audioSamplesSaved:false,cases:[],observations:[]};
async function main(){
  try{
    report.fixture=verifyFixture();
    stage='tone-start';tone=launchFixture('CLIPRELAY_AUDIO_TONE_FIXTURE');
    await until(()=>alive(tone),value=>value?.event==='ready',10000);
    const initial=await until(()=>command('state'),value=>value.callbacks>10,5000);assert.equal(initial.frequency,0);
    report.routeBefore=initial.route;
    stage='host-start';await host.action('host-start');await host.startTask;assert.equal(host.snapshot().phase,'running');
    const config=hostState.read('sunshine.conf',65536).toString('utf8');
    assert.match(config,/^lan_encryption_mode = 2$/m);assert.match(config,/^wan_encryption_mode = 2$/m);
    stage='pair';const identity=identities.client;
    const peer=await pairHost({address:'127.0.0.1',port:48789,identity,name:'Audio CI',onVerification:async verification=>{
      const status=await host.action('host-status'),request=status.requests.find(item=>item.verification===verification.verification);
      assert.ok(request);await host.action('host-pair-approve',{id:request.id,generation:request.generation,verification:request.verification});
    }});
    async function nvhttp(endpoint,parameters={}){
      const query=new URLSearchParams({...parameters,uniqueid:'cliprelay-audio-ci',uuid:crypto.randomUUID()});
      const xml=await exchange({address:'127.0.0.1',port:48784,path:`/${endpoint}?${query}`,method:'GET',identity,
        trust:{cert:peer.certificate},timeout:10000,limit:65536});
      assert.ok(!/<!/.test(xml));assert.match(xml,/<root\b[^>]*\bstatus_code="200"(?:\s|\/|>)/);return xml;
    }
    const admin=()=>jsonRequest({address:'127.0.0.1',port:48790,path:'/api/cliprelay/displays',method:'GET',identity,
      trust:{cert:peer.certificate},headers:{Authorization:hostState.authorization()},timeout:3000,limit:65536});
    stage='stream-start';const info=await nvhttp('serverinfo'),appid=xmlValue(await nvhttp('applist'),'ID');
    assert.match(appid,/^[1-9][0-9]*$/);const current=xmlValue(info,'currentgame');
    assert.ok(current==='0'||current===appid,'UNEXPECTED_RUNNING_FIXTURE_APP');
    const operation=current==='0'?'launch':'resume',key=crypto.randomBytes(16).toString('hex'),keyID=1060,iv=Buffer.alloc(16);iv.writeUInt32BE(keyID);
    const launched=await nvhttp(operation,{appid,mode:'1280x720x30',sops:0,rikey:key,rikeyid:keyID,localAudioPlayMode:1,
      continuousAudio:1,surroundAudioInfo:196610,remoteControllersBitmap:0,gcmap:0,gcpersist:0,corever:1});
    assert.equal(xmlValue(launched,operation==='launch'?'gamesession':'resume'),'1');
    const url=xmlValue(launched,'sessionUrl0');assert.match(url,/^rtspenc:\/\/127\.0\.0\.1:[0-9]{1,5}$/);
    report.encryptedRTSP=true;report.hostRequiresEncryption=true;report.hostAudioRequested=true;
    decoder=launchFixture('CLIPRELAY_AUDIO_DECODE_FIXTURE');
    decoder.child.stdin.write([xmlValue(info,'appversion'),xmlValue(info,'GfeVersion')||'3.23.0.74',url,key,iv.toString('hex'),''].join('\n'));
    stage='quiet-baseline';
    report.ciAudioConsent=[];let consentPressed=false,nextConsent=Date.now()+2000;
    const baseline=await until(async()=>{
      const value=alive(decoder);
      if(!value?.audio?.packets&&!consentPressed&&Date.now()>=nextConsent&&report.ciAudioConsent.length<8){
        assert.ok(engineChild&&engineChild.exitCode===null&&engineChild.signalCode===null);
        const decision=await command('allow-audio '+engineChild.pid,'audio-consent');
        assert.equal(decision.ownedEngineVerified,true);report.ciAudioConsent.push(decision);
        consentPressed=decision.pressed;nextConsent=Date.now()+2000;
      }
      return value;
    },value=>value?.decoded>=5&&value.audio?.windows>=2&&value.audio.packets>0,30000);
    const active=await admin();assert.equal(active.streams.length,1);
    assert.equal(active.streams[0].owner,new crypto.X509Certificate(identity.cert).fingerprint256.replaceAll(':','').toLowerCase());
    assert.equal(baseline.errors,0);assert.equal(baseline.audio.errors,0);
    report.cases.push('paired-host-actual-encrypted-video-and-opus-packets');
    async function phase(name,hz){
      stage=name;const previous=alive(decoder),source=await command(name==='quiet-baseline'?'quiet':name);
      assert.equal(source.frequency,hz);let lastWindow=previous.audio.windows,consecutive=[];
      await until(()=>{
        const value=alive(decoder);if(!value?.audio)return false;
        assert.equal(value.errors,0);assert.equal(value.audio.errors,0);
        if(value.audio.windows<=lastWindow)return false;lastWindow=value.audio.windows;
        const a=value.audio,target=hz===1000?a.low:a.high,other=hz===1000?a.high:a.low;
        const match=hz===0?a.rms<.001&&a.low<.001&&a.high<.001:target>.005&&other<target*.15&&a.rms>.003;
        if(a.windows<previous.audio.windows+2||a.ageMs>=1000||value.ageMs>=2000||value.decoded<=previous.decoded||!match)consecutive=[];
        else {consecutive.push(value);if(consecutive.length>2)consecutive.shift();}
        return consecutive.length===2;
      },Boolean,20000);
      const after=await command('state');assert.equal(after.errors,0);assert.ok(after.callbacks>source.callbacks);
      report.observations.push({stage:name,frequency:hz,afterWindow:previous.audio.windows,sourceCallbacks:after.callbacks,windows:consecutive});
    }
    await phase('quiet-baseline',0);await phase('low',1000);await phase('high',1600);await phase('quiet',0);
    report.cases.push('fresh-decoded-silence-1000Hz-1600Hz-silence');
    stage='receiver-eof';await close(decoder);assert.deepEqual(decoder.exit,{code:0,signal:null});
    await until(admin,value=>value.streams.length===0);report.cases.push('receiver-EOF-releases-native-stream');
    stage='host-close';await host.close();
    const restored=await command('state');report.routeAfter=restored.route;
    assert.deepEqual(report.routeAfter,report.routeBefore);report.cases.push('default-audio-devices-rate-and-buffer-preserved');
    await close(tone);assert.deepEqual(tone.exit,{code:0,signal:null});
    for(const child of nativeChildren)assert.ok(child.exitCode!==null||child.signalCode!==null);
    assert.deepEqual(protectedDirectories.map(snapshot),before);assert.equal(process.env.HOME,originalHome);
    report.ownedChildrenReaped=true;report.cases.push('owned-processes-reaped-and-default-profile-preserved');report.passed=true;
  }catch(error){
    let source=tone?.events.at(-1);if(tone&&!tone.exit)try{source=await command('state');}catch{}
    let consentWindows;if(tone&&!tone.exit)try{consentWindows=await command('consent-windows','consent-windows');}catch{}
    report.failure={stage,code:error.code||error.message,location:error.stack?.match(/test_macos_host_audio\.cjs:\d+:\d+/)?.[0],
      host:host.snapshot(),tone:source,decoder:decoder?.events.at(-1),engine:diagnostics(),audioStack:audioStack(),
      audioConsent:audioConsentLog(),consentWindows};process.exitCode=1;
  }finally{
    const cleanup=[];
    for(const item of [decoder])try{await close(item);}catch{cleanup.push('receiver');}
    try{await host.close();}catch{cleanup.push('host');}
    if(tone&&!tone.exit)try{report.routeAfter= (await command('quiet')).route;}catch{cleanup.push('tone-state');}
    try{await close(tone);}catch{cleanup.push('tone');}
    report.exits=fixtures.map(item=>({exit:item.exit,error:item.error}));
    if(cleanup.length){report.cleanupErrors=cleanup;report.passed=false;process.exitCode=1;}
    if(report.passed)try{validateReceipt(report,{testCommit:process.env.GITHUB_SHA,architecture:process.arch,
      hostScope:report.hostScope,applicationCommit:report.applicationCommit});}
    catch(error){report.passed=false;report.failure={stage:'receipt',code:error.code||'AUDIO_RECEIPT_INVALID'};process.exitCode=1;}
    fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({passed:report.passed,stage,cases:report.cases,architecture:process.arch}));
  }
}
main().catch(()=>{process.exitCode=1;});
