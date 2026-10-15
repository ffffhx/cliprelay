'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {identities}=require('./mac-pairing-fixture.cjs');
const {StreamViewer,envelope,executable}=require('../electron/mac/stream-viewer.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const host=()=>({id:crypto.createHash('sha256').update(new crypto.X509Certificate(identities.host.cert).raw).digest('hex'),name:'Fixture PC',enabled:true,address:'127.0.0.1',port:48789,clientId:'a'.repeat(32),certificate:identities.host.cert});
function store(){return {data:{legacySelected:false},host:host(),selected(){return {...this.host};},async identity(){return identities.client;}};}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<300;i++){if(check())return;await delay(10);}throw new Error('test deadline');}
const fixture=`let bytes=Buffer.alloc(0),done=false;process.stdin.on('data',b=>{bytes=Buffer.concat([bytes,b]);if(!done&&bytes.length>=4&&bytes.length>=4+bytes.readUInt32BE()){done=true;let value=JSON.parse(bytes.subarray(4).toString());process.send({version:value.version,port:value.port,privateKey:value.privateKey.includes('PRIVATE KEY'),address:value.address,width:value.width,height:value.height,fps:value.fps,bitrate:value.bitrate});bytes.fill(0);if(!settings.silent)process.stdout.write(JSON.stringify({version:1,event:'connected'})+'\\n');}});process.on('message',value=>{if(value.exit!==undefined)process.exit(value.exit);else process.stdout.write(value.raw || JSON.stringify(value)+'\\n');});process.stdin.on('end',()=>setTimeout(()=>process.exit(0),settings.closeDelay || 0));setTimeout(()=>process.exit(9),7000);`;
function manager(state,config={},settings={}){
  let child,args,spawnOptions;const children=[],messages=[],timeline=[];
  const viewer=new StreamViewer({directory:'.',store:state,retryDelays:[15,25],recoveryMs:2000,stableMs:1000,resolveExecutable:()=>process.execPath,...config,spawnProcess:(file,a,options)=>{
    args=a;spawnOptions=options;child=spawn(file,['-e','const settings='+JSON.stringify(settings)+';'+fixture],{...options,env:{...options.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},stdio:['pipe','pipe','ignore','ipc']});
    children.push(child);timeline.push(['spawn',child.pid]);child.on('message',value=>messages.push(value));child.on('close',()=>timeline.push(['close',child.pid]));return child;
  }});
  return {viewer,children,messages,timeline,get child(){return child},get args(){return args},get options(){return spawnOptions}};
}
test('frame contains bounded validated identity with explicit stream options',()=>{
  const bytes=envelope(host(),identities.client,{width:1280,height:720,fps:30,bitrate:6000,fullscreen:true});
  assert.equal(bytes.readUInt32BE(),bytes.length-4);const value=JSON.parse(bytes.subarray(4));assert.equal(value.width,1280);assert.equal(value.fullscreen,true);
  for(const options of [{fps:1},{bitrate:Infinity},{fullscreen:'true'},{certificate:'injected'},{width:1.5}])assert.throws(()=>envelope(host(),identities.client,options));
  assert.throws(()=>envelope({...host(),certificate:identities.wrong.cert},identities.client));
  assert.throws(()=>envelope(host(),{...identities.client,key:identities.wrong.key}));
  bytes.fill(0);
});
test('real child receives credentials only through a pipe and exits when owner closes it',async()=>{
  const f=manager(store());try{
    const pending=f.viewer.open();await new Promise(resolve=>setImmediate(resolve));
    const message=once(f.child,'message');await pending;
    assert.deepEqual((await message)[0],{version:1,port:48789,privateKey:true,address:'127.0.0.1',width:1920,height:1080,fps:60,bitrate:12000});
    assert.deepEqual(f.args,['--cliprelay-session']);assert.equal(f.options.shell,false);assert.equal(f.options.windowsHide,true);
    assert.ok(!JSON.stringify(f.viewer.snapshot()).includes('PRIVATE KEY'));
    await until(()=>f.viewer.phase==='running');await assert.rejects(f.viewer.open(),{code:'VIEWER_BUSY'});
    const closed=once(f.child,'close');f.viewer.stop();assert.equal((await closed)[0],0);assert.equal(f.viewer.phase,'idle');
  }finally{f.viewer.stop();}
});
test('only an owned loopback route can enable embedded-network framing',()=>{
  const route={...host(),port:32000,overlay:true,overlayPort:48789,routeId:'generation-1'};
  const bytes=envelope(route,identities.client);const value=JSON.parse(bytes.subarray(4));
  assert.equal(value.overlay,true);assert.equal(value.overlayPort,48789);assert.equal(value.port,32000);assert.equal(value.routeId,undefined);bytes.fill(0);
  for(const change of [{address:'localhost'},{address:'192.168.1.1'},{port:1028},{overlayPort:65515},{overlay:false}])assert.throws(()=>envelope({...route,...change},identities.client),{code:'INVALID_STREAM_TARGET'});
  assert.throws(()=>envelope(host(),identities.client,{overlay:true}));
});
test('replacement route waits for the old viewer to close even when the local port is reused',async()=>{
  const state=store();Object.assign(state.host,{overlay:true,overlayPort:48789,routeId:'first'});const f=manager(state);
  try{await f.viewer.open();const closed=once(f.child,'close');state.host.routeId='second';f.viewer.reconcile();assert.equal((await closed)[0],0);await until(()=>f.children.length===2 && f.viewer.phase==='running');assert.deepEqual(f.timeline.slice(0,3).map(event=>event[0]),['spawn','close','spawn']);}finally{f.viewer.stop();}
});
test('selection changes while identity unlocks prevent a process from starting',async()=>{
  const state=store();let unlock;state.identity=()=>new Promise(resolve=>unlock=resolve);const f=manager(state);
  const pending=f.viewer.open();state.host.id='0'.repeat(64);unlock(identities.client);
  await assert.rejects(pending,{code:'CANCELLED'});assert.equal(f.child,undefined);
});
test('cancelling an in-flight unlock invalidates that launch',async()=>{
  const state=store();let unlock;state.identity=()=>new Promise(resolve=>unlock=resolve);const f=manager(state);
  const pending=f.viewer.open();f.viewer.stop();unlock(identities.client);
  await assert.rejects(pending,{code:'CANCELLED'});assert.equal(f.child,undefined);assert.equal(f.viewer.phase,'idle');
});
test('revoking or pausing the selected peer closes the existing viewer lease',async()=>{
  const state=store(),f=manager(state);try{await f.viewer.open();const closed=once(f.child,'close');state.host.enabled=false;f.viewer.reconcile();assert.equal((await closed)[0],0);}finally{f.viewer.stop();}
});
test('missing or modified packaged executable cannot be launched',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-viewer-test-'));
  try{
    const relative='runtime/ClipRelayStream.exe';fs.mkdirSync(path.join(directory,'runtime'));const file=path.join(directory,relative);fs.writeFileSync(file,'fixture bytes');
    const files={[relative]:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')};fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({platform:'windows',protocol:1,files}));
    assert.throws(()=>executable(directory,'win32'),{code:'VIEWER_UPDATE_REQUIRED'});
    assert.throws(()=>executable(directory,'win32',true),{code:'VIEWER_UPDATE_REQUIRED'});
    fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({platform:'windows',protocol:1,files,capabilities:['direct','embedded-network','session-events-v1']}));
    assert.equal(executable(directory,'win32',true),file);
    fs.appendFileSync(file,'modified');assert.throws(()=>executable(directory,'win32'),{code:'VIEWER_INVALID'});
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('OS spawn failure is contained without an unhandled child-process error',async()=>{
  const viewer=new StreamViewer({directory:'.',store:store(),resolveExecutable:()=>path.join(os.tmpdir(),'cliprelay-missing-'+crypto.randomUUID()+'.exe')});
  await assert.rejects(viewer.open(),{code:'VIEWER_UNAVAILABLE'});
  await new Promise(resolve=>setTimeout(resolve,25));assert.equal(viewer.child,null);viewer.stop();
});
test('network failure recovers after old-process cleanup and preserves a copy of picture settings',async t=>{
  const f=manager(store(),{}, {closeDelay:80});t.after(()=>f.viewer.stop());
  const options={width:1280,height:720,fps:30,bitrate:6000};const pending=f.viewer.open(options);options.bitrate=40000;await pending;
  await until(()=>f.viewer.phase==='running');f.child.send({version:1,event:'ended',reason:'network'});
  await until(()=>f.viewer.phase==='recovering');assert.equal(f.children.length,1);
  await until(()=>f.children.length===2 && f.viewer.phase==='running');
  assert.deepEqual(f.messages[1],f.messages[0]);assert.equal(f.messages[1].bitrate,6000);
  assert.deepEqual(f.timeline.slice(0,3).map(event=>event[0]),['spawn','close','spawn']);
});
test('explicit close, revoked pairing, host error, decoder error and lost parent never restart',async t=>{
  for(const reason of ['user','pairing','host','decoder','parent'])await t.test(reason,async t=>{
    const f=manager(store());t.after(()=>f.viewer.stop());await f.viewer.open();await until(()=>f.viewer.phase==='running');
    f.child.send({version:1,event:'ended',reason});await until(()=>!f.viewer.child);await delay(60);
    assert.equal(f.children.length,1);assert.equal(f.viewer.phase,reason==='user'?'idle':'error');
  });
});
test('a crash without a terminal event fails closed, including during a recovery attempt',async t=>{
  const f=manager(store());t.after(()=>f.viewer.stop());await f.viewer.open();await until(()=>f.viewer.phase==='running');
  f.child.send({version:1,event:'ended',reason:'network'});await until(()=>f.children.length===2);
  f.child.send({exit:3});await until(()=>f.viewer.phase==='error');await delay(60);assert.equal(f.children.length,2);
});
test('stop and authorization loss cancel retries permanently',async t=>{
  for(const action of ['stop','pause','revoke','select','certificate','receiver'])await t.test(action,async t=>{
    const state=store(),f=manager(state,{retryDelays:[100]});t.after(()=>f.viewer.stop());await f.viewer.open();await until(()=>f.viewer.phase==='running');
    f.child.send({version:1,event:'ended',reason:'network'});await until(()=>f.viewer.phase==='recovering' && !f.viewer.child);
    if(action==='stop')f.viewer.stop();
    else if(action==='pause')state.host.enabled=false;
    else if(action==='revoke')state.host.routeBlocked='NETWORK_REVOKED';
    else if(action==='select')state.data.legacySelected=true;
    else if(action==='certificate')state.host.certificate=identities.wrong.cert;
    f.viewer.reconcile(action==='receiver'?'UNPAIRED':undefined);await delay(150);
    assert.equal(f.children.length,1);assert.equal(f.viewer.intent,null);
  });
});
test('a missing route is awaited without spawning and has a bounded recovery deadline',async t=>{
  const state=store(),f=manager(state,{recoveryMs:150});t.after(()=>f.viewer.stop());await f.viewer.open();await until(()=>f.viewer.phase==='running');
  state.host.routeReady=false;f.viewer.reconcile();await until(()=>f.viewer.phase==='error');
  assert.equal(f.viewer.snapshot().error,'VIEWER_RECOVERY_EXHAUSTED');assert.equal(f.children.length,1);
});
test('flapping connections consume a bounded retry budget',async t=>{
  const f=manager(store(),{maxRetries:2});t.after(()=>f.viewer.stop());await f.viewer.open();
  for(let count=1;count<=3;count++){
    await until(()=>f.children.length===count && f.viewer.phase==='running');f.child.send({version:1,event:'ended',reason:'network'});
  }
  await until(()=>f.viewer.phase==='error');assert.equal(f.viewer.snapshot().error,'VIEWER_RECOVERY_EXHAUSTED');assert.equal(f.children.length,3);
});
test('cancellation while a retry identity unlocks prevents the delayed process',async t=>{
  const state=store(),f=manager(state);t.after(()=>f.viewer.stop());await f.viewer.open();await until(()=>f.viewer.phase==='running');
  let unlock;state.identity=()=>new Promise(resolve=>unlock=resolve);
  f.child.send({version:1,event:'ended',reason:'network'});await until(()=>unlock);f.viewer.stop();unlock(identities.client);await delay(60);
  assert.equal(f.children.length,1);assert.equal(f.viewer.phase,'idle');
});
test('malformed, oversized and duplicate lifecycle events cannot trigger a retry',async t=>{
  for(const raw of ['broken\n','x'.repeat(4097),'{}\n',JSON.stringify({version:1,event:'connected'})+'\n',JSON.stringify({version:1,event:'ended',reason:'network',secret:'unexpected'})+'\n'])await t.test(raw.slice(0,30),async t=>{
    const f=manager(store());t.after(()=>f.viewer.stop());await f.viewer.open();await until(()=>f.viewer.phase==='running');f.child.send({raw});
    await until(()=>f.viewer.phase==='error');assert.equal(f.viewer.snapshot().error,'VIEWER_PROTOCOL_ERROR');assert.equal(f.children.length,1);
  });
});
test('startup does not report running without a native connected event and expires safely',async t=>{
  const f=manager(store(),{startupMs:100},{silent:true});t.after(()=>f.viewer.stop());await f.viewer.open();assert.equal(f.viewer.phase,'starting');
  await until(()=>f.viewer.phase==='error');assert.equal(f.viewer.snapshot().error,'VIEWER_START_TIMEOUT');assert.equal(f.children.length,1);
});
test('a stable restored session earns a fresh retry budget',async t=>{
  const f=manager(store(),{maxRetries:1,stableMs:80});t.after(()=>f.viewer.stop());await f.viewer.open();await until(()=>f.viewer.phase==='running');
  f.child.send({version:1,event:'ended',reason:'network'});await until(()=>f.children.length===2 && f.viewer.phase==='running');
  await delay(100);f.child.send({version:1,event:'ended',reason:'network'});await until(()=>f.children.length===3 && f.viewer.phase==='running');
});
test('explicit stop during old-child drain prevents a new viewer on replacement route',async t=>{
  const state=store(),f=manager(state,{}, {closeDelay:150});t.after(()=>f.viewer.stop());await f.viewer.open();await until(()=>f.viewer.phase==='running');
  state.host.routeId='new-route';f.viewer.reconcile();assert.equal(f.viewer.phase,'recovering');f.viewer.stop();
  await until(()=>!f.viewer.child);await delay(60);assert.equal(f.children.length,1);assert.equal(f.viewer.phase,'idle');
});
