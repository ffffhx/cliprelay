'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {HostSession}=require('../electron/mac/host-session.cjs');
const fault=code=>Object.assign(new Error(code),{code});
function fixture(t){
  const trace=[];
  function owner(name){return {phase:'stopped',onUpdate:()=>{},snapshot(){return {phase:this.phase};},
    update(phase,error=null){this.phase=phase;this.onUpdate({phase,error});},
    async start(){trace.push(name+'-start');this.update('running');},
    async stop(){trace.push(name+'-stop');this.update('stopped');},
    async close(){trace.push(name+'-close');this.update('closed');}};}
  const engine=owner('engine'),companion=owner('companion'),session=new HostSession({engine,companion});
  t.after(()=>session.close());return {engine,companion,session,trace};
}
test('host readiness requires both owners; stop and permanent close preserve credential lifetime',async t=>{
  const f=fixture(t);await f.session.start('Mac');assert.deepEqual(f.trace,['engine-start','companion-start']);
  assert.deepEqual(f.session.snapshot(),{phase:'running',error:null,nativeWorkers:false,fileTransfer:false});
  await assert.rejects(f.session.start('Mac'),{code:'HOST_SESSION_BUSY'});await f.session.stop();
  assert.deepEqual(f.trace.slice(-2),['companion-stop','engine-stop']);
  await f.session.start('Mac');await f.session.close();assert.deepEqual(f.trace.slice(-4),['companion-stop','engine-stop','companion-close','engine-close']);
  await assert.rejects(f.session.start('Mac'),{code:'HOST_SESSION_CLOSED'});
});
test('companion startup failure shuts down the engine and reports its fixed error',async t=>{
  const f=fixture(t);f.companion.start=async()=>{throw fault('HOST_COMPANION_TIMEOUT');};
  await assert.rejects(f.session.start('Mac'),{code:'HOST_COMPANION_TIMEOUT'});
  assert.equal(f.session.snapshot().phase,'failed');assert.equal(f.engine.phase,'stopped');assert.equal(f.session.current,null);
});

test('file transfer is advertised only while the verified companion session is running',async t=>{
  const f=fixture(t),states=[];f.session.onUpdate=value=>states.push(value);
  f.companion.snapshot=function(){return {phase:this.phase,fileTransfer:true};};
  assert.equal(f.session.snapshot().fileTransfer,false);await f.session.start('Mac');
  assert.equal(f.session.snapshot().fileTransfer,true);await f.session.stop();
  assert.ok(states.some(value=>value.phase==='running'&&value.fileTransfer));
  assert.ok(states.filter(value=>value.phase!=='running').every(value=>value.fileTransfer===false));
});
test('either owner failure withdraws readiness and joins both owners',async t=>{
  for(const name of ['engine','companion'])await t.test(name,async t=>{
    const f=fixture(t);await f.session.start('Mac');f[name].update('stopping','HOST_FIXTURE_EXITED');
    assert.equal(f.session.snapshot().phase,'stopping');await f.session.current.stopPromise;
    assert.equal(f.session.snapshot().error,'HOST_FIXTURE_EXITED');assert.deepEqual(f.trace.slice(-2),['companion-stop','engine-stop']);
  });
});
test('stop while engine startup is pending prevents late companion launch',async t=>{
  const f=fixture(t);let ready;f.engine.start=()=>new Promise(resolve=>{ready=resolve;});
  const pending=assert.rejects(f.session.start('Mac'),{code:'HOST_SESSION_CANCELLED'});await f.session.stop();ready();await pending;
  assert.ok(!f.trace.includes('companion-start'));assert.equal(f.session.snapshot().phase,'stopped');
});
test('stop during companion startup never promotes a late ready result',async t=>{
  const f=fixture(t);let ready,entered;const seen=new Promise(resolve=>{entered=resolve;});
  f.companion.start=()=>new Promise(resolve=>{ready=resolve;entered();});
  const pending=assert.rejects(f.session.start('Mac'),{code:'HOST_SESSION_CANCELLED'});await seen;await f.session.stop();ready();await pending;
  assert.equal(f.session.snapshot().phase,'stopped');assert.equal(f.engine.phase,'stopped');
});
test('readiness notification can synchronously stop without returning a running session',async t=>{
  const f=fixture(t);f.session.onUpdate=value=>{if(value.phase==='running')void f.session.stop();};
  await assert.rejects(f.session.start('Mac'),{code:'HOST_SESSION_CANCELLED'});assert.equal(f.session.current,null);
});
test('close waits for companion reaping before the engine state can be closed',async t=>{
  const f=fixture(t);await f.session.start('Mac');let release;
  f.companion.stop=()=>new Promise(resolve=>{release=resolve;});const closing=f.session.close();
  await Promise.resolve();assert.ok(!f.trace.includes('engine-close'));assert.ok(!f.trace.includes('engine-stop'));
  release();await closing;assert.equal(f.session.snapshot().phase,'closed');
});
