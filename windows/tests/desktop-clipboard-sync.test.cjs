'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {ClipboardSync,fingerprint}=require('../electron/mac/clipboard-sync.cjs');
const {fault}=require('../electron/mac/paired-transport.cjs');
const text=value=>({kind:'text',text:value});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture(options={}){
  const f={host:{id:'h',clientId:'client',certificate:'synthetic certificate',address:'host',port:1,enabled:true,clipboardSync:options.enabled!==false},local:text('local baseline'),remote:text('remote baseline'),version:1,reads:0,writes:[],calls:[],paused:false,locked:false};
  f.session=options.connected===false?null:{host:{...f.host},telemetry:true};f.progress={received:1,rendered:1,receivedAgeMs:0,renderedAgeMs:0};
  const store={data:{},selected:()=>f.host?{...f.host}:null,identity:async()=>({cert:'synthetic identity'}),setClipboardSync:(id,value)=>{assert.equal(id,f.host.id);f.host.clipboardSync=value;}};
  const viewer={currentSession:()=>f.session,snapshot:()=>({progress:f.progress}),inputPaused:()=>f.paused,reconcile:code=>{f.viewerError=code;}};
  const monitor=new EventEmitter();monitor.getSystemIdleState=()=>f.locked?'locked':'active';
  let queue=Promise.resolve();
  const paired={withClipboard:operation=>{const task=queue.catch(()=>{}).then(operation);queue=task;return task;},clipboard:{readPayload:async active=>{assert.ok(active());f.reads++;return f.local;},writePayload:async(value,active)=>{assert.ok(active());f.writes.push(value);f.local=value;}}};
  const rev=()=>f.version.toString(16).padStart(64,'0');
  f.handle=async body=>{
    if(body.op==='observe')return body.revision===rev()?{revision:rev(),changed:false}:{revision:rev(),changed:true,payload:f.remote};
    if(body.op==='read')return f.remote;
    assert.equal(body.op,'write');if(body.expect!==rev())throw fault('CLIPBOARD_CHANGED');
    f.remote=body.kind==='text'?text(body.text):{kind:'png',bytes:Buffer.from(body.data,'base64')};f.version++;return {ok:true};
  };
  const request=async(host,identity,body,signal)=>{assert.equal(identity.cert,'synthetic identity');f.calls.push({host,body,signal});return f.handle(body);};
  const nativeImage={createFromBuffer:bytes=>({getSize:()=>({width:1,height:1}),isEmpty:()=>false,toBitmap:()=>Buffer.from([bytes[33],0,0,255])})};
  const sync=f.sync=new ClipboardSync({store,viewer,paired,powerMonitor:monitor,nativeImage,request,pollMs:60000});
  Object.assign(f,{store,viewer,paired,monitor,nativeImage,remoteCopy:value=>{f.remote=value;f.version++;},tick:async()=>{const before=sync.record;sync.reconcile();const r=sync.record;if(r){clearTimeout(r.timer);await(r===before?sync.poll(r):r.task);}},close:()=>sync.close()});
  return f;
}
test('off, disconnected, stale presentation, input pause and system lock never read clipboards',async()=>{
  for(const setup of [f=>{f.host.clipboardSync=false;},f=>{f.session=null;},f=>{f.progress.renderedAgeMs=5000;},f=>{f.paused=true;},f=>{f.locked=true;},f=>{f.store.data.legacySelected=true;},f=>{f.host.enabled=false;f.session.host.enabled=false;}]){
    const f=fixture();try{setup(f);await f.tick();assert.equal(f.reads,0);assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);}finally{f.close();}
  }
});
test('connection baselines preserve both existing clipboards; subsequent text changes flow in both directions without echo',async()=>{
  const f=fixture();try{
    await f.tick();assert.equal(f.sync.snapshot().phase,'active');assert.equal(f.local.text,'local baseline');assert.equal(f.remote.text,'remote baseline');assert.equal(f.writes.length,0);
    f.local=text('new local');await f.tick();assert.equal(f.remote.text,'new local');await f.tick();assert.equal(f.calls.filter(c=>c.body.op==='write').length,1);
    f.remoteCopy(text('new remote'));await f.tick();assert.equal(f.local.text,'new remote');assert.equal(f.writes.length,1);await f.tick();assert.equal(f.writes.length,1);assert.equal(f.calls.filter(c=>c.body.op==='write').length,1);
    const visible=JSON.stringify(f.sync.snapshot());for(const secret of ['new remote','baseline','synthetic certificate','synthetic identity'])assert.ok(!visible.includes(secret));
  }finally{f.close();}
});
test('divergent concurrent changes pause without replacing either copy; resume creates new baselines',async()=>{
  const f=fixture();try{
    await f.tick();f.local=text('local newer');f.remoteCopy(text('remote newer'));await f.tick();assert.equal(f.sync.snapshot().phase,'conflict');assert.equal(f.local.text,'local newer');assert.equal(f.remote.text,'remote newer');
    const reads=f.reads,calls=f.calls.length;await f.tick();assert.equal(f.reads,reads);assert.equal(f.calls.length,calls);
    f.sync.resume({viewId:f.sync.viewId});await f.sync.record.task;assert.equal(f.sync.snapshot().phase,'active');assert.equal(f.local.text,'local newer');assert.equal(f.remote.text,'remote newer');
  }finally{f.close();}
});
test('equal simultaneous copies converge; clearing either side never clears the other',async()=>{
  const f=fixture();try{
    await f.tick();f.local=text('same');f.remoteCopy(text('same'));await f.tick();assert.equal(f.writes.length,0);assert.equal(f.calls.filter(c=>c.body.op==='write').length,0);
    f.local={kind:'empty'};await f.tick();assert.equal(f.remote.text,'same');f.local=text('retained');await f.tick();f.remoteCopy({kind:'empty'});await f.tick();assert.equal(f.local.text,'retained');
  }finally{f.close();}
});
test('a local copy during remote observation cannot be overwritten by the late response',async()=>{
  const f=fixture();try{
    await f.tick();f.remoteCopy(text('remote change'));const began=deferred(),gate=deferred(),handle=f.handle;
    f.handle=async body=>{const response=await handle(body);began.resolve();await gate.promise;return response;};const task=f.tick();await began.promise;f.local=text('new local while waiting');gate.resolve();await task;
    assert.equal(f.local.text,'new local while waiting');assert.equal(f.writes.length,0);assert.equal(f.sync.snapshot().phase,'conflict');
  }finally{f.close();}
});
test('conditional write rejects remote changes after observation and never falls back to an unconditional write',async()=>{
  const f=fixture();try{
    await f.tick();f.local=text('local copied');const handle=f.handle;f.handle=async body=>{if(body.op==='write')f.remoteCopy(text('remote race'));return handle(body);};await f.tick();
    assert.equal(f.remote.text,'remote race');assert.equal(f.local.text,'local copied');assert.equal(f.sync.snapshot().phase,'conflict');assert.equal(f.calls.filter(c=>c.body.op==='write').length,1);
    assert.ok(f.calls.find(c=>c.body.op==='write').body.expect);
  }finally{f.close();}
});
test('lost write acknowledgment pauses without replay and a newer local copy is sent after a confirmed earlier write',async()=>{
  const f=fixture();try{
    await f.tick();f.local=text('sent before loss');const handle=f.handle;f.handle=async body=>{const result=await handle(body);if(body.op==='write')throw fault('TIMEOUT');return result;};await f.tick();
    assert.equal(f.sync.snapshot().error,'CLIPBOARD_WRITE_UNCERTAIN');f.remoteCopy(text('remote after lost acknowledgment'));await f.tick();assert.equal(f.remote.text,'remote after lost acknowledgment');assert.equal(f.calls.filter(c=>c.body.op==='write').length,1);
    f.handle=handle;f.sync.resume({viewId:f.sync.viewId});await f.sync.record.task;f.local=text('first');
    f.handle=async body=>{const result=await handle(body);if(body.op==='write')f.local=text('second');return result;};await f.tick();assert.equal(f.remote.text,'first');f.handle=handle;await f.tick();assert.equal(f.remote.text,'second');
  }finally{f.close();}
});
test('disconnect and reused-port route replacement abort old responses and start new baselines',async()=>{
  for(const change of [f=>{f.session=null;},f=>{f.host={...f.host,certificate:'new certificate',routeId:'new route'};f.session={host:{...f.host},telemetry:true};},f=>{f.host.clipboardSync=false;}]){
    const f=fixture();try{
      await f.tick();f.remoteCopy(text('late remote'));const began=deferred(),gate=deferred(),handle=f.handle;
      f.handle=async body=>{const response=await handle(body);began.resolve();await gate.promise;return response;};const task=f.tick();await began.promise;const old=f.sync.record;change(f);f.sync.reconcile();assert.equal(old.abort.signal.aborted,true);gate.resolve();await task;await f.sync.record?.task;
      assert.equal(f.local.text,'local baseline');assert.equal(f.writes.length,0);
    }finally{f.close();}
  }
});
test('suspend, lock and session inactivity compose; all listeners are removed on close',async()=>{
  const f=fixture();try{
    await f.tick();for(const event of ['suspend','lock-screen','user-did-resign-active'])f.monitor.emit(event);const reads=f.reads,calls=f.calls.length;
    f.monitor.emit('resume');f.monitor.emit('unlock-screen');await f.tick();assert.equal(f.reads,reads);assert.equal(f.calls.length,calls);
    f.local=text('during lock');f.remoteCopy(text('remote during lock'));f.monitor.emit('user-did-become-active');await f.sync.record.task;assert.equal(f.local.text,'during lock');assert.equal(f.remote.text,'remote during lock');
    f.close();for(const event of ['suspend','resume','lock-screen','unlock-screen','user-did-resign-active','user-did-become-active'])assert.equal(f.monitor.listenerCount(event),0);
  }finally{f.close();}
});
test('paired relay application invalidates an in-flight observation and establishes a baseline without an echo',async()=>{
  const f=fixture();try{
    await f.tick();const began=deferred(),gate=deferred(),handle=f.handle;f.handle=async body=>{const result=await handle(body);began.resolve();await gate.promise;return result;};
    const task=f.tick();await began.promise;f.local=text('received broadcast');f.sync.externalApplied();gate.resolve();await task;f.handle=handle;await f.tick();await f.tick();assert.equal(f.calls.filter(c=>c.body.op==='write').length,0);assert.equal(f.local.text,'received broadcast');
  }finally{f.close();}
});
test('manual receive works while automation is off but refuses a changed local clipboard and stale view',async()=>{
  const f=fixture({enabled:false,connected:false});try{
    await f.tick();assert.equal(f.reads,0);await f.sync.receive({viewId:f.sync.viewId});assert.equal(f.local.text,'remote baseline');assert.equal(f.sync.snapshot().phase,'off');
    const reads=f.reads;await assert.rejects(f.sync.receive({viewId:'old'}),{code:'CLIPBOARD_VIEW_CHANGED'});assert.equal(f.reads,reads);
    const handle=f.handle;f.handle=async body=>{f.local=text('new local');return handle(body);};await assert.rejects(f.sync.receive({viewId:f.sync.viewId}),{code:'CLIPBOARD_LOCAL_CHANGED'});assert.equal(f.local.text,'new local');
  }finally{f.close();}
});
test('unsupported hosts pause without writes and repeated temporary read failures are bounded',async()=>{
  const f=fixture();try{
    f.handle=async()=>{throw fault('CLIPBOARD_SYNC_UNSUPPORTED');};await f.tick();assert.equal(f.sync.snapshot().phase,'paused');assert.equal(f.calls.length,1);await f.tick();assert.equal(f.calls.length,1);
    f.handle=async()=>{throw fault('CLIPBOARD_BUSY');};f.sync.resume({viewId:f.sync.viewId});await f.sync.record.task;await f.tick();await f.tick();assert.equal(f.sync.snapshot().phase,'paused');assert.equal(f.calls.length,4);assert.ok(f.calls.every(c=>c.body.op==='observe'));
  }finally{f.close();}
});

test('manual receive cannot outlive its window, lock, suspend, route or controller, even after unlock',async()=>{
  for(const cancel of [f=>{f.authorized=false;},f=>f.sync.cancelReceive(),f=>{f.monitor.emit('lock-screen');f.monitor.emit('unlock-screen');},f=>{f.monitor.emit('suspend');f.monitor.emit('resume');},f=>{f.host={...f.host,routeId:'replacement'};f.sync.reconcile();},f=>f.close()]){
    const f=fixture({enabled:false,connected:false});try{
      await f.tick();f.authorized=true;const began=deferred(),gate=deferred(),handle=f.handle;
      f.handle=async body=>{const result=await handle(body);began.resolve();await gate.promise;return result;};
      const task=f.sync.receive({viewId:f.sync.viewId},()=>f.authorized);const rejected=assert.rejects(task,{code:'CANCELLED'});
      await began.promise;cancel(f);gate.resolve();await rejected;assert.equal(f.local.text,'local baseline');assert.equal(f.writes.length,0);
    }finally{f.close();}
  }
});

test('pausing input, losing fresh frames or closing cancels pending automatic applies',async()=>{
  for(const cancel of [f=>{f.paused=true;},f=>{f.progress.receivedAgeMs=5000;},f=>f.close()]){
    const f=fixture();try{
      await f.tick();f.remoteCopy(text('late automatic'));const began=deferred(),gate=deferred(),handle=f.handle;
      f.handle=async body=>{const result=await handle(body);began.resolve();await gate.promise;return result;};
      const task=f.tick();await began.promise;cancel(f);f.sync.reconcile();gate.resolve();await task;
      assert.equal(f.local.text,'local baseline');assert.equal(f.writes.length,0);
      if(!f.sync.closed){f.paused=false;f.progress.receivedAgeMs=0;f.handle=handle;await f.tick();assert.equal(f.local.text,'local baseline');assert.equal(f.remote.text,'late automatic');}
    }finally{f.close();}
  }
});
test('PNG fingerprints compare pixels rather than encoded PNG bytes',()=>{
  const f=fixture();try{
    const png=Buffer.alloc(35);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(1,16);png.writeUInt32BE(1,20);png[33]=127;
    const encoded=Buffer.from(png);encoded[34]=18;assert.equal(fingerprint({kind:'png',bytes:png},f.nativeImage),fingerprint({kind:'png',bytes:encoded},f.nativeImage));encoded[33]=128;assert.notEqual(fingerprint({kind:'png',bytes:png},f.nativeImage),fingerprint({kind:'png',bytes:encoded},f.nativeImage));
  }finally{f.close();}
});
