'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawn}=require('node:child_process');
const {HostEngine}=require('../electron/mac/host-engine.cjs');
const fault=code=>Object.assign(new Error(code),{code});
async function until(predicate){
  const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)throw Error('Fixture deadline');await new Promise(resolve=>setTimeout(resolve,10));}
}
function fixture(t,options={}){
  const children=[],ready=new Set(),trace=[];
  const state={prepare(name){trace.push(['prepare',name]);},environment(env){return {...env,CLIPRELAY_HOST_STATE_DIR:'fixture-only'};},close(){trace.push(['state-close']);}};
  const permissions={async query(){trace.push(['permissions']);return {screenRecording:true,inputControl:true};},async cancel(){trace.push(['permission-cancel']);},async close(){trace.push(['permission-close']);}};
  const engine=new HostEngine({directory:__dirname,pin:{arch:'arm64'},platform:'darwin',arch:'arm64',state,permissions,
    verify(){trace.push(['verify']);},pollMs:10,monitorMs:20,readyTimeout:1500,probeTimeout:100,stopGraceMs:60,killDelayMs:30,
    launch(file,args,settings){
      trace.push(['launch',file,args,settings]);
      const child=spawn(process.execPath,[path.join(__dirname,'mac-host-engine-child.cjs'),options.mode || 'normal'],{...settings,cwd:__dirname,stdio:['pipe','ignore','ignore','ipc']});
      child.on('message',message=>{if(message.ready)ready.add(child.pid);});children.push(child);return child;
    },
    async probe(){const child=children.at(-1);if(!ready.has(child?.pid))throw fault('HOST_ADMIN_UNAVAILABLE');return {protocol:1,pid:child.pid,ownerPid:process.pid,owned:true,screenRecording:true,inputControl:true};},
    ...options});
  t.after(()=>engine.close());return {engine,children,ready,trace,state,permissions};
}
test('engine verifies, preflights and prepares before fixed native launch; EOF is reaped before stop resolves',async t=>{
  const f=fixture(t);const status=await f.engine.start('Fixture Mac');assert.equal(status.phase,'running');
  assert.deepEqual(f.trace.slice(0,3).map(value=>value[0]),['verify','permissions','prepare']);
  const launch=f.trace.find(value=>value[0]==='launch');assert.match(launch[1],/Sunshine$/);assert.deepEqual(launch[2],[]);
  assert.equal(launch[3].env.CLIPRELAY_HOST_OWNER_PID,String(process.pid));assert.equal(launch[3].env.HOME,process.env.HOME);
  assert.equal(launch[3].detached,false);assert.equal(launch[3].shell,false);
  await assert.rejects(f.engine.start('Duplicate'),{code:'HOST_ENGINE_BUSY'});
  const stopped=await f.engine.stop();assert.equal(stopped.phase,'stopped');assert.equal(f.engine.current,null);assert.equal(f.children[0].exitCode,0);
});
test('missing permissions and invalid artifacts never initialize private state or launch a child',async t=>{
  for(const mode of ['permission','artifact']){
    const f=fixture(t,mode==='permission'?{permissions:{async query(){return {screenRecording:false,inputControl:true};},async cancel(){},async close(){}}}:{verify(){throw Error('unsafe internal path');}});
    await assert.rejects(f.engine.start('Mac'),{code:mode==='permission'?'HOST_PERMISSION_REQUIRED':'HOST_ENGINE_INVALID'});
    assert.equal(f.children.length,0);assert.ok(!f.trace.some(value=>value[0]==='prepare'));
  }
});
test('stop during permission preflight cancels and prevents any late launch',async t=>{
  let reject,entered;const seen=new Promise(resolve=>{entered=resolve;});
  const f=fixture(t,{permissions:{query(){entered();return new Promise((_resolve,rejectPromise)=>{reject=rejectPromise;});},async cancel(){reject?.(fault('HOST_PERMISSION_CANCELLED'));},async close(){}}});
  const pending=assert.rejects(f.engine.start('Mac'),{code:'HOST_ENGINE_CANCELLED'});await seen;await f.engine.stop();await pending;
  assert.equal(f.children.length,0);assert.equal(f.engine.snapshot().phase,'stopped');
});
test('wrong process identity cannot be promoted to a running engine',async t=>{
  const f=fixture(t,{probe:async()=>({pid:1,ownerPid:process.pid,owned:true,screenRecording:true,inputControl:true})});
  await assert.rejects(f.engine.start('Mac'),{code:'HOST_ENGINE_IDENTITY_CHANGED'});
  assert.equal(f.engine.snapshot().phase,'failed');assert.equal(f.engine.current,null);
  assert.ok(f.children[0].exitCode!==null || f.children[0].signalCode!==null);
});
test('startup deadline and ignored EOF still terminate and reap the actual fixture child',async t=>{
  const f=fixture(t,{mode:'ignore',readyTimeout:180,probe:async()=>{throw fault('HOST_ADMIN_UNAVAILABLE');}});
  await assert.rejects(f.engine.start('Mac'),{code:'HOST_ENGINE_TIMEOUT'});
  assert.equal(f.engine.current,null);assert.ok(f.children[0].exitCode!==null || f.children[0].signalCode!==null);
});
test('permission revocation withdraws running status and stops the owned process',async t=>{
  const f=fixture(t);await f.engine.start('Mac');f.engine.probe=async()=>({pid:f.children[0].pid,ownerPid:process.pid,owned:true,screenRecording:false,inputControl:true});
  await until(()=>f.engine.current===null);assert.equal(f.engine.snapshot().phase,'failed');assert.equal(f.engine.snapshot().error,'HOST_PERMISSION_REQUIRED');
});
test('unexpected child exit is reported and an explicit subsequent start owns a new child',async t=>{
  const f=fixture(t,{mode:'exit'});await f.engine.start('Mac');await until(()=>f.engine.current===null);
  assert.equal(f.engine.snapshot().error,'HOST_ENGINE_EXITED');const status=await f.engine.start('Mac');assert.equal(status.phase,'running');assert.equal(f.children.length,2);
});
test('reentrant stop notifications share cleanup and keep start blocked until the child is reaped',async t=>{
  const f=fixture(t,{mode:'ignore'});await f.engine.start('Mac');let repeated;
  f.engine.onUpdate=value=>{if(value.phase==='stopping')repeated=f.engine.stop();};
  const stopped=f.engine.stop();assert.equal(stopped,repeated);assert.equal(f.engine.snapshot().phase,'stopping');
  await assert.rejects(f.engine.start('Mac'),{code:'HOST_ENGINE_BUSY'});await stopped;assert.equal(f.engine.current,null);
});
test('closing during startup cancels, closes state and permanently rejects restart',async t=>{
  const f=fixture(t,{probe:async()=>{throw fault('HOST_ADMIN_UNAVAILABLE');}});
  const pending=assert.rejects(f.engine.start('Mac'),{code:'HOST_ENGINE_CANCELLED'});await until(()=>f.children.length===1);await f.engine.close();await pending;
  assert.equal(f.engine.snapshot().phase,'closed');assert.ok(f.trace.some(value=>value[0]==='state-close'));
  await assert.rejects(f.engine.start('Mac'),{code:'HOST_ENGINE_CLOSED'});
});

test('late readiness after cancellation cannot restore running status',async t=>{
  let resolveProbe,entered;const seen=new Promise(resolve=>{entered=resolve;});const phases=[];
  const f=fixture(t,{onUpdate:value=>phases.push(value.phase),probe:()=>new Promise(resolve=>{resolveProbe=resolve;entered();})});
  const pending=assert.rejects(f.engine.start('Mac'),{code:'HOST_ENGINE_CANCELLED'});await seen;await f.engine.stop();
  resolveProbe({pid:f.children[0].pid,ownerPid:process.pid,owned:true,screenRecording:true,inputControl:true});await pending;
  assert.ok(!phases.includes('running'));assert.equal(f.engine.snapshot().phase,'stopped');
});

test('an OS spawn failure is reaped and leaves no occupied engine slot',async t=>{
  let child;
  const f=fixture(t,{launch:()=>{child=spawn(path.join(__dirname,'missing-fixture-engine'),[],{stdio:['pipe','ignore','ignore'],windowsHide:true});return child;}});
  await assert.rejects(f.engine.start('Mac'),{code:'HOST_ENGINE_START_FAILED'});assert.equal(f.engine.current,null);
  assert.ok(child.exitCode!==null || child.signalCode!==null);
});

test('stop from the readiness notification cancels the pending start and reaps its child',async t=>{
  const f=fixture(t);
  f.engine.onUpdate=value=>{if(value.phase==='running')void f.engine.stop();};
  await assert.rejects(f.engine.start('Mac'),{code:'HOST_ENGINE_CANCELLED'});
  assert.equal(f.engine.current,null);assert.equal(f.engine.snapshot().phase,'stopped');
  assert.equal(f.children[0].exitCode,0);
});
