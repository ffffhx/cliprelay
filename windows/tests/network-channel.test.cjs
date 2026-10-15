'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {NetworkChannel,initialization,executable}=require('../electron/mac/network-channel.cjs');
const enrollment=()=>({controlUrl:'https://127.0.0.1:9',hostname:'cr-012345678901234567890123',authKey:'private-fixture-enrollment',peerIP:'100.64.0.2'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<200;i++){if(check())return;await delay(10);}throw new Error('fixture deadline');}
const fixture=String.raw`
const mode=process.argv[1];let bytes='',started=false;
const status=(ready,port=32000,path='connecting')=>JSON.stringify({type:'status',ready,port,path})+'\n';
process.stdin.on('data',chunk=>{
  bytes+=chunk;
  while(bytes.includes('\n')){
    const at=bytes.indexOf('\n'),line=bytes.slice(0,at);bytes=bytes.slice(at+1);
    const value=JSON.parse(line);
    if(!started){
      started=true;process.send({credential:value.authKey==='private-fixture-enrollment',version:value.version});
      if(mode==='invalid'){process.stdout.write('private-fixture-enrollment\n');continue;}
      if(mode==='oversize'){process.stdout.write('x'.repeat(2048));continue;}
      if(mode==='unknown-error'){process.stdout.write(JSON.stringify({type:'error',code:'private-fixture-enrollment'})+'\n');continue;}
      if(mode==='known-error'){process.stdout.write(JSON.stringify({type:'error',code:'CONNECTION_FAILED'})+'\n');continue;}
      if(mode==='invalid-utf8'){process.stdout.write(Buffer.from([255,10]));continue;}
      if(mode==='silent')continue;
      process.stdout.write(status(false,0));
      if(mode==='pending')continue;
      const reply=status(true);process.stdout.write(reply.slice(0,7));setTimeout(()=>process.stdout.write(reply.slice(7)),10);
    }else if(value.action==='status'){
      if(mode==='no-heartbeat' || mode==='stubborn')continue;
      if(mode==='port-change')process.stdout.write(status(true,32001));
      else if(mode==='route-loss')process.stdout.write(status(false,32000));
      else process.stdout.write(status(true,32000,'relay'));
    }
  }
});
process.stdin.on('end',()=>{if(mode!=='stubborn')process.exit(0);});
setInterval(()=>{},1000);
setTimeout(()=>process.exit(9),10000);
`;
function setup(t,mode='normal',overrides={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-network-channel-'));
  const children=[],updates=[],calls=[];
  const manager=new NetworkChannel({directory:root,stateDirectory:path.join(root,'node'),startupMs:5000,pollMs:50,responseMs:300,shutdownMs:500,
    onUpdate:value=>updates.push(value),resolveExecutable:()=>process.execPath,
    spawnProcess:(file,args,options)=>{calls.push({args,options});const child=spawn(file,['-e',fixture,mode],{...options,stdio:['pipe','pipe','ignore','ipc']});children.push(child);return child;},...overrides});
  t.after(async()=>{await manager.stop();assert.ok(children.every(child=>child.exitCode!==null || child.signalCode!==null));fs.rmSync(root,{recursive:true,force:true});});
  return {manager,children,updates,calls,root};
}

test('enrollment is bounded, HTTPS-origin-only and restricted to an approved overlay peer',()=>{
  const encoded=initialization(enrollment());assert.equal(JSON.parse(encoded).version,1);assert.ok(encoded.length<16384);encoded.fill(0);
  for(const change of [{controlUrl:'http://127.0.0.1'},{controlUrl:'https://user:pass@example.com'},
      {controlUrl:'https://example.com/path'},{controlUrl:'https://example.com/?key=secret'},
      {controlUrl:' https://example.com'},{peerIP:'127.0.0.1'},{peerIP:'100.128.0.1'},
      {peerIP:'::ffff:100.64.0.1'},{peerIP:'100.064.0.1'},{hostname:'cr-../../escape'},
      {authKey:'x'.repeat(4097)},{authKey:'文'.repeat(1400)},{extra:'unexpected'}])
    assert.throws(()=>initialization({...enrollment(),...change}),{code:'INVALID_NETWORK_INITIALIZATION'});
});

test('packaged helper role, protocol and actual executable hash are checked before launch',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-network-manifest-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'runtime'));const name='runtime/cliprelay-client-network.exe',file=path.join(root,name);fs.writeFileSync(file,'fixture');
  const manifest={role:'desktop-network',protocol:1,platform:'windows',files:{[name]:crypto.createHash('sha256').update('fixture').digest('hex')}};
  const write=value=>fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(value));
  write(manifest);assert.equal(executable(root,'win32'),file);
  write({...manifest,role:'host-network'});assert.throws(()=>executable(root,'win32'),{code:'NETWORK_INVALID'});
  write({...manifest,protocol:2});assert.throws(()=>executable(root,'win32'),{code:'NETWORK_INVALID'});
  write(manifest);fs.appendFileSync(file,'modified');assert.throws(()=>executable(root,'win32'),{code:'NETWORK_INVALID'});
});

test('real child receives pipe-only credentials, fragmented replies work and owner EOF exits normally',async t=>{
  const f=setup(t),opening=f.manager.start(enrollment()),message=once(f.children[0],'message');
  assert.deepEqual((await message)[0],{credential:true,version:1});
  const route=await opening;assert.equal(route.address,'127.0.0.1');assert.equal(route.port,32000);assert.equal(route.overlayPort,48789);
  assert.equal(route.overlay,true);assert.ok(route.routeId);assert.equal(f.manager.snapshot().phase,'ready');
  await until(()=>f.manager.snapshot().path==='relay');assert.equal(f.manager.snapshot().route.routeId,route.routeId);
  assert.deepEqual(f.calls[0].args,['--state-dir',path.join(f.root,'node')]);
  assert.equal(f.calls[0].options.env,undefined);assert.equal(f.calls[0].options.shell,false);assert.equal(f.calls[0].options.windowsHide,true);
  assert.ok(!JSON.stringify(f.updates).includes(enrollment().authKey));assert.deepEqual(fs.readdirSync(path.join(f.root,'node')),[]);
  const closing=f.manager.stop();assert.equal(f.manager.snapshot().route,null);await closing;
  assert.equal(f.children[0].exitCode,0);assert.equal(f.manager.snapshot().phase,'idle');
});

test('cancellation during pending registration closes the real child and rejects its pending start',async t=>{
  const f=setup(t,'pending'),controller=new AbortController(),opening=f.manager.start(enrollment(),{signal:controller.signal});
  const rejected=assert.rejects(opening,{code:'CANCELLED'});await once(f.children[0],'message');controller.abort();
  await rejected;await f.manager.stop();assert.equal(f.children[0].exitCode,0);assert.equal(f.manager.snapshot().route,null);
});

test('a channel waits for its old child to close and never reuses the route generation',async t=>{
  const f=setup(t),first=await f.manager.start(enrollment());
  await assert.rejects(f.manager.start(enrollment()),{code:'NETWORK_BUSY'});
  const closing=f.manager.stop();await assert.rejects(f.manager.start(enrollment()),{code:'NETWORK_BUSY'});await closing;
  const second=await f.manager.start(enrollment());assert.equal(second.port,first.port);assert.notEqual(second.routeId,first.routeId);
  assert.equal(f.children[0].exitCode,0);
});

test('invalid, oversized and credential-bearing replies fail with fixed public errors',async t=>{
  for(const mode of ['invalid','oversize','unknown-error','invalid-utf8','known-error']){
    const f=setup(t,mode);
    await assert.rejects(f.manager.start(enrollment()),{code:mode==='known-error'?'NETWORK_CONNECTION_FAILED':'NETWORK_BAD_REPLY'});
    await f.manager.stop();assert.ok(!JSON.stringify(f.updates).includes(enrollment().authKey));assert.equal(f.manager.snapshot().route,null);
    assert.equal(f.children[0].exitCode,0);
  }
});

test('port replacement and lost listeners withdraw the old route and close the child',async t=>{
  for(const mode of ['port-change','route-loss']){
    const f=setup(t,mode);await f.manager.start(enrollment());await until(()=>f.manager.snapshot().error==='NETWORK_ROUTE_LOST');
    assert.equal(f.manager.snapshot().route,null);await f.manager.stop();assert.equal(f.children[0].exitCode,0);
  }
});

test('missing heartbeat terminates an unresponsive helper without leaving a route',async t=>{
  const f=setup(t,'stubborn');await f.manager.start(enrollment());
  await until(()=>f.manager.snapshot().error==='NETWORK_TIMEOUT');assert.equal(f.manager.snapshot().route,null);
  await f.manager.stop();assert.ok(f.children[0].signalCode || f.children[0].exitCode!==0);
});

test('startup deadline bounds a helper that never reports readiness',async t=>{
  const f=setup(t,'silent',{startupMs:1000});await assert.rejects(f.manager.start(enrollment()),{code:'NETWORK_TIMEOUT'});
  await f.manager.stop();assert.equal(f.children[0].exitCode,0);
});

test('pre-cancelled launches and invalid storage cannot start a child',async t=>{
  const f=setup(t);const controller=new AbortController();controller.abort();
  await assert.rejects(f.manager.start(enrollment(),{signal:controller.signal}),{code:'CANCELLED'});assert.equal(f.children.length,0);
  f.manager.stateDirectory='relative-path';await assert.rejects(f.manager.start(enrollment()),{code:'INVALID_NETWORK_STORAGE'});assert.equal(f.children.length,0);
});

test('OS spawn failure is contained and its child is reconciled before retry',async t=>{
  const f=setup(t,'normal',{resolveExecutable:()=>path.join(os.tmpdir(),crypto.randomUUID()+'.exe'),spawnProcess:spawn});
  await assert.rejects(f.manager.start(enrollment()),{code:'NETWORK_UNAVAILABLE'});await f.manager.stop();assert.equal(f.manager.current,null);
});

test('actual packaged Go helper cancels pending registration on manager shutdown',{
  skip:!process.env.CLIPRELAY_NETWORK_HELPER_ARTIFACT
},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-real-network-manager-'));let child,initial;
  const status=new Promise(resolve=>{initial=resolve;});
  const manager=new NetworkChannel({directory:process.env.CLIPRELAY_NETWORK_HELPER_ARTIFACT,stateDirectory:path.join(root,'node'),
    spawnProcess:(...args)=>{child=spawn(...args);child.stdout.once('data',bytes=>initial(bytes));return child;}});
  t.after(async()=>{await manager.stop();fs.rmSync(root,{recursive:true,force:true});});
  const opening=manager.start(enrollment()),rejected=assert.rejects(opening,{code:'CANCELLED'});
  let timer,bytes;
  try{bytes=await Promise.race([status,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('native helper startup deadline')),8000);})]);}
  finally{clearTimeout(timer);}
  assert.equal(JSON.parse(bytes).ready,false);assert.equal(manager.snapshot().route,null);
  await manager.stop();await rejected;assert.equal(child.exitCode,0);
});
