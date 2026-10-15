'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {identities}=require('./mac-pairing-fixture.cjs');
const {StreamViewer,envelope,executable}=require('../electron/mac/stream-viewer.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const host=()=>({id:crypto.createHash('sha256').update(new crypto.X509Certificate(identities.host.cert).raw).digest('hex'),name:'Fixture PC',enabled:true,address:'127.0.0.1',port:48789,clientId:'a'.repeat(32),certificate:identities.host.cert});
function store(){return {data:{legacySelected:false},host:host(),selected(){return {...this.host};},async identity(){return identities.client;}};}
const fixture=`let bytes=Buffer.alloc(0),done=false;process.stdin.on('data',b=>{bytes=Buffer.concat([bytes,b]);if(!done&&bytes.length>=4&&bytes.length>=4+bytes.readUInt32BE()){done=true;let value=JSON.parse(bytes.subarray(4).toString());process.send({version:value.version,port:value.port,privateKey:value.privateKey.includes('PRIVATE KEY'),address:value.address});bytes.fill(0);}});process.stdin.on('end',()=>process.exit(0));setTimeout(()=>process.exit(9),7000);`;
function manager(state){
  let child,args,spawnOptions;const viewer=new StreamViewer({directory:'.',store:state,resolveExecutable:()=>process.execPath,spawnProcess:(file,a,options)=>{args=a;spawnOptions=options;child=spawn(file,['-e',fixture],{...options,stdio:['pipe','ignore','ignore','ipc']});return child;}});
  return {viewer,get child(){return child},get args(){return args},get options(){return spawnOptions}};
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
    assert.deepEqual((await message)[0],{version:1,port:48789,privateKey:true,address:'127.0.0.1'});
    assert.deepEqual(f.args,['--cliprelay-session']);assert.equal(f.options.shell,false);assert.equal(f.options.windowsHide,true);
    assert.ok(!JSON.stringify(f.viewer.snapshot()).includes('PRIVATE KEY'));
    assert.equal(f.viewer.phase,'running');await assert.rejects(f.viewer.open(),{code:'VIEWER_BUSY'});
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
test('replacing a network route closes its viewer even when the local port is reused',async()=>{
  const state=store();Object.assign(state.host,{overlay:true,overlayPort:48789,routeId:'first'});const f=manager(state);
  try{await f.viewer.open();const closed=once(f.child,'close');state.host.routeId='second';f.viewer.reconcile();assert.equal((await closed)[0],0);assert.equal(f.viewer.phase,'idle');}finally{f.viewer.stop();}
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
    assert.equal(executable(directory,'win32'),file);
    assert.throws(()=>executable(directory,'win32',true),{code:'VIEWER_UPDATE_REQUIRED'});
    fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({platform:'windows',protocol:1,files,capabilities:['direct','embedded-network']}));
    assert.equal(executable(directory,'win32',true),file);
    fs.appendFileSync(file,'modified');assert.throws(()=>executable(directory,'win32'),{code:'VIEWER_INVALID'});
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('OS spawn failure is contained without an unhandled child-process error',async()=>{
  const viewer=new StreamViewer({directory:'.',store:store(),resolveExecutable:()=>path.join(os.tmpdir(),'cliprelay-missing-'+crypto.randomUUID()+'.exe')});
  await assert.rejects(viewer.open(),{code:'VIEWER_UNAVAILABLE'});
  await new Promise(resolve=>setTimeout(resolve,25));assert.equal(viewer.child,null);viewer.stop();
});
