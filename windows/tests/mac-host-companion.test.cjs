'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawn}=require('node:child_process');
const {HostCompanion,receipt,verifySocket}=require('../electron/mac/host-companion.cjs');
async function until(predicate){const end=Date.now()+4000;while(!predicate()){if(Date.now()>end)throw Error('Fixture deadline');await new Promise(resolve=>setTimeout(resolve,10));}}
function fixture(t,options={}){
  const children=[],trace=[],frames=[],messages=[];
  const state={directory:path.resolve(__dirname,'unused-companion-state'),companionInitialization(){
    const frame=Buffer.from(JSON.stringify({protocol:1,password:'fixture-only-password',certificate:'fixture-only-certificate'})+'\n');frames.push(frame);return frame;
  }};
  const companion=new HostCompanion({directory:__dirname,pin:{},state,platform:'darwin',arch:'arm64',
    verify(){trace.push('verify');},checkSocket:file=>file,readyTimeout:1000,
    stopGraceMs:options.mode==='ignore'?70:2000,killDelayMs:options.mode==='ignore'?30:200,
    launch(file,args,settings){
      trace.push({file,args,settings});
      const child=spawn(process.execPath,[path.join(__dirname,'mac-host-companion-child.cjs'),options.mode || 'normal'],
        {...settings,cwd:__dirname,stdio:['pipe','pipe','ignore','ipc']});
      child.on('message',message=>messages.push(message));children.push(child);return child;
    },...options});
  t.after(()=>companion.close());return {companion,children,trace,frames,messages};
}
function reaped(f){assert.equal(f.companion.current,null);for(const child of f.children)assert.ok(child.exitCode!==null || child.signalCode!==null);}
test('companion starts with fixed arguments and pipe-only credentials; EOF waits for real close',async t=>{
  const f=fixture(t);assert.equal((await f.companion.start()).phase,'running');
  assert.equal(f.trace[0],'verify');const launch=f.trace[1];
  assert.match(launch.file,/cliprelay-host-network$/);assert.deepEqual(launch.args,['--state-dir',f.companion.state.directory,'--owner-pid',String(process.pid)]);
  assert.deepEqual(launch.settings.stdio,['pipe','pipe','ignore']);assert.equal(launch.settings.detached,false);assert.equal(launch.settings.shell,false);
  assert.ok(!JSON.stringify(launch).includes('fixture-only-password'));assert.equal(f.companion.ipcPath(),'/fixture/clipboard-relay.sock');
  assert.deepEqual(f.companion.snapshot(),{phase:'running',error:null,nativeWorkers:false});
  await until(()=>f.messages.length===1);assert.equal(f.messages[0].passwordMatches,true);assert.ok(f.frames[0].every(byte=>byte===0));
  await f.companion.stop();reaped(f);assert.equal(f.children[0].exitCode,0);
  assert.throws(()=>f.companion.ipcPath(),{code:'HOST_COMPANION_UNAVAILABLE'});
});
test('invalid artifact or unavailable initialization never launches a child',async t=>{
  for(const options of [{verify(){throw Error('private artifact path');}},{state:{directory:__dirname,companionInitialization(){throw Object.assign(Error('private data'),{code:'HOST_CERT_UNAVAILABLE'});}}}]){
    const f=fixture(t,options);await assert.rejects(f.companion.start(),{code:options.verify?'HOST_COMPANION_INVALID':'HOST_CERT_UNAVAILABLE'});reaped(f);assert.equal(f.children.length,0);
  }
});
test('malformed, wrong-owner and excess replies cannot produce readiness',async t=>{
  for(const mode of ['wrong-pid','wrong-owner','workers','duplicate','extra-field','extra-byte','flood','bad-utf8'])await t.test(mode,async t=>{
    const phases=[],f=fixture(t,{mode,onUpdate:value=>phases.push(value.phase)});
    await assert.rejects(f.companion.start(),{code:'HOST_COMPANION_BAD_REPLY'});reaped(f);assert.ok(!phases.includes('running'));
  });
});
test('an invalid socket receipt is rejected with a fixed public error',async t=>{
  const f=fixture(t,{checkSocket(){throw Object.assign(Error('private socket path'),{code:'HOST_COMPANION_IPC_INVALID'});}});
  await assert.rejects(f.companion.start(),{code:'HOST_COMPANION_IPC_INVALID'});reaped(f);
});
test('missing startup reply and ignored EOF still force and reap the child',async t=>{
  const f=fixture(t,{mode:'ignore',readyTimeout:300});await assert.rejects(f.companion.start(),{code:'HOST_COMPANION_TIMEOUT'});reaped(f);
  assert.equal(f.companion.snapshot().phase,'failed');
});
test('stop during initialization prevents a late running state',async t=>{
  const f=fixture(t,{mode:'quiet'}),pending=assert.rejects(f.companion.start(),{code:'HOST_COMPANION_CANCELLED'});
  await until(()=>f.messages.length===1);await f.companion.stop();await pending;reaped(f);assert.equal(f.companion.snapshot().phase,'stopped');
});
test('unexpected child death and later output withdraw readiness',async t=>{
  for(const mode of ['exit','late-data'])await t.test(mode,async t=>{
    const f=fixture(t,{mode});await f.companion.start();await until(()=>f.companion.current===null);reaped(f);
    assert.equal(f.companion.snapshot().error,mode==='exit'?'HOST_COMPANION_EXITED':'HOST_COMPANION_BAD_REPLY');
    assert.throws(()=>f.companion.ipcPath(),{code:'HOST_COMPANION_UNAVAILABLE'});
  });
});
test('duplicate starts are refused; explicit restart creates a different owned child',async t=>{
  const f=fixture(t);await f.companion.start();await assert.rejects(f.companion.start(),{code:'HOST_COMPANION_BUSY'});
  await f.companion.stop();await f.companion.start();assert.notEqual(f.children[0].pid,f.children[1].pid);await f.companion.stop();reaped(f);
});
test('reentrant stop shares cleanup and does not release ownership early',async t=>{
  const f=fixture(t);await f.companion.start();let repeated;
  f.companion.onUpdate=value=>{if(value.phase==='stopping')repeated=f.companion.stop();};
  const stopping=f.companion.stop();assert.equal(repeated,stopping);assert.notEqual(f.companion.current,null);
  await assert.rejects(f.companion.start(),{code:'HOST_COMPANION_BUSY'});await stopping;reaped(f);
});
test('stop from readiness notification cancels start and clears the IPC path',async t=>{
  const f=fixture(t);f.companion.onUpdate=value=>{if(value.phase==='running')void f.companion.stop();};
  await assert.rejects(f.companion.start(),{code:'HOST_COMPANION_CANCELLED'});reaped(f);
});
test('closing a pending start reaps its child and permanently refuses restart',async t=>{
  const f=fixture(t,{mode:'quiet'}),pending=assert.rejects(f.companion.start(),{code:'HOST_COMPANION_CANCELLED'});
  await until(()=>f.messages.length===1);await f.companion.close();await pending;reaped(f);
  assert.equal(f.companion.snapshot().phase,'closed');await assert.rejects(f.companion.start(),{code:'HOST_COMPANION_CLOSED'});
});
test('OS spawn failure releases the slot and does not leak the initialization buffer',async t=>{
  const f=fixture(t,{launch:()=>spawn(path.join(__dirname,'missing-companion'),[],{stdio:['pipe','pipe','ignore'],windowsHide:true})});
  await assert.rejects(f.companion.start(),{code:'HOST_COMPANION_START_FAILED'});assert.equal(f.companion.current,null);assert.ok(f.frames[0].every(byte=>byte===0));
});
test('receipt parser rejects nested values and socket validation refuses non-private paths',()=>{
  assert.throws(()=>receipt(Buffer.from('{}'),12),{code:'HOST_COMPANION_BAD_REPLY'});
  for(const file of ['',{},'/tmp/clipboard-relay.sock','/tmp/cliprelay-host-test/elsewhere.sock'])assert.throws(()=>verifySocket(file),{code:'HOST_COMPANION_IPC_INVALID'});
});
