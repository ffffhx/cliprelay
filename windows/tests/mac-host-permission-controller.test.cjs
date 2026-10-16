'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {HostPermissionController,message}=require('../electron/mac/host-permission-controller.cjs');
function fixture(t,{pin={arch:'arm64',commit:'a'.repeat(40),manifestSha256:'b'.repeat(64)},...options}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-host-permission-controller-'));
  t.after(()=>{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(directory).startsWith('cliprelay-host-permission-controller-'));fs.rmSync(directory,{recursive:true,force:true});});
  if(pin!==null)fs.writeFileSync(path.join(directory,'host-engine-pin.json'),typeof pin==='string'?pin:JSON.stringify(pin));
  const calls=[],state={checking:false,screenRecording:null,inputControl:null,checkedAt:null,error:null};let created=0;
  const owner={operation:null,snapshot:()=>({...state}),query:async()=>{calls.push('query');Object.assign(state,{checkedAt:0,screenRecording:false,inputControl:true});},
    request:async permission=>{calls.push(permission);Object.assign(state,{screenRecording:false,inputControl:false,checkedAt:1});},
    cancel:()=>{calls.push('cancel');return Promise.resolve();},close:()=>{calls.push('close');return Promise.resolve();}};
  const controller=new HostPermissionController({directory,platform:'darwin',arch:'arm64',create:args=>{created++;assert.equal(args.directory,path.join(directory,'host-engine'));return owner;},...options});
  return {controller,calls,owner,state,get created(){return created;}};
}
test('loading settings has no process side effects and requires a successful check before requests',async t=>{
  const f=fixture(t);assert.equal(f.created,1);assert.equal(f.controller.snapshot().available,true);assert.deepEqual(f.calls,[]);
  await assert.rejects(f.controller.action('host-permissions-request',{permission:'screenRecording'}),{code:'HOST_PERMISSION_NOT_CHECKED'});
  assert.deepEqual(f.calls,[]);const status=await f.controller.action('host-permissions-check');assert.equal(status.screenRecording,false);assert.equal(status.inputControl,true);
  assert.equal(status.checkedAt,0);await f.controller.action('host-permissions-request',{permission:'screenRecording'});assert.deepEqual(f.calls,['query','screenRecording']);
  assert.equal(f.controller.snapshot().screenRecording,false);await f.controller.close();
});
test('unavailable, malformed and wrong-architecture package pins never construct an executable owner',async t=>{
  for(const options of [{pin:null},{pin:'{'},{pin:'a'.repeat(1025)},{pin:{arch:'x86_64',commit:'a'.repeat(40),manifestSha256:'b'.repeat(64)}},{platform:'win32'}]){
    const f=fixture(t,options);assert.equal(f.created,0);assert.equal(f.controller.snapshot().available,false);
    await assert.rejects(f.controller.action('host-permissions-check'));assert.deepEqual(f.calls,[]);await f.controller.close();
  }
});
test('permission actions accept only the exact target payload and expose no native diagnostics',async t=>{
  const f=fixture(t);await f.controller.action('host-permissions-check');
  for(const value of [null,{},[],{permission:'constructor'},{permission:'screenRecording',executable:'/arbitrary'},{permission:['inputControl']}]){
    await assert.rejects(f.controller.action('host-permissions-request',value),{code:'INVALID_HOST_PERMISSION'});
  }
  await assert.rejects(f.controller.action('launch',{}),{code:'INVALID_HOST_PERMISSION'});assert.deepEqual(f.calls,['query']);
  assert.ok(!message({code:'UNKNOWN',message:'/private/log'}).includes('/private/'));await f.controller.close();
});
test('window release and application close retain child ownership until cleanup resolves',async t=>{
  const f=fixture(t);let end;const stopped=new Promise(resolve=>end=resolve);f.owner.cancel=()=>stopped;f.owner.close=()=>stopped;
  assert.equal(f.controller.releaseWindow(),stopped);assert.equal(f.controller.close(),stopped);
  assert.equal(f.controller.snapshot().available,false);await assert.rejects(f.controller.action('host-permissions-check'),{code:'HOST_PERMISSIONS_CLOSED'});end();await stopped;
});
test('a failed check clears permission claims and busy operations stay disabled until reaped',async t=>{
  const f=fixture(t);await f.controller.action('host-permissions-check');f.owner.query=async()=>{Object.assign(f.state,{checkedAt:null,screenRecording:null,inputControl:null,error:'HOST_PERMISSION_TIMEOUT'});f.owner.operation={};throw Object.assign(Error('/private'),{code:'HOST_PERMISSION_TIMEOUT'});};
  let reap;f.owner.cancel=()=>new Promise(resolve=>{reap=()=>{f.owner.operation=null;resolve();};});
  const pending=f.controller.action('host-permissions-check');await new Promise(resolve=>setImmediate(resolve));assert.equal(f.controller.snapshot().busy,true);
  reap();const state=await pending;assert.equal(state.inputControl,null);assert.equal(state.busy,false);assert.equal(state.error,'HOST_PERMISSION_TIMEOUT');
  await assert.rejects(f.controller.action('host-permissions-request',{permission:'inputControl'}),{code:'HOST_PERMISSION_NOT_CHECKED'});await f.controller.close();
});
