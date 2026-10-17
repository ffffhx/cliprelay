'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {HostPermissionController,message}=require('../electron/mac/host-permission-controller.cjs');
function fixture(t,{pin={arch:'arm64',commit:'a'.repeat(40),manifestSha256:'b'.repeat(64)},...options}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-host-permission-controller-'));
  t.after(()=>{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(directory).startsWith('cliprelay-host-permission-controller-'));fs.rmSync(directory,{recursive:true,force:true});});
  if(pin!==null)fs.writeFileSync(path.join(directory,'host-engine-pin.json'),typeof pin==='string'?pin:JSON.stringify(pin));
  const calls=[],opened=[],state={checking:false,screenRecording:null,inputControl:null,checkedAt:null,error:null};let created=0;
  const owner={operation:null,snapshot:()=>({...state}),query:async()=>{calls.push('query');Object.assign(state,{checkedAt:0,screenRecording:false,inputControl:true});},
    request:async permission=>{calls.push(permission);Object.assign(state,{screenRecording:false,inputControl:false,checkedAt:1});},
    cancel:()=>{calls.push('cancel');return Promise.resolve();},close:()=>{calls.push('close');return Promise.resolve();}};
  const controller=new HostPermissionController({directory,platform:'darwin',arch:'arm64',openSettings:async url=>{opened.push(url);},create:args=>{created++;assert.equal(args.directory,path.join(directory,'host-engine'));return owner;},...options});
  return {controller,calls,opened,owner,state,get created(){return created;}};
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
test('ungranted explicit requests open only the matching fixed system pane and never imply a grant',async t=>{
  const f=fixture(t);await f.controller.action('host-permissions-check');assert.deepEqual(f.opened,[]);
  for(const [permission,pane] of [['screenRecording','Privacy_ScreenCapture'],['inputControl','Privacy_Accessibility']]){
    const state=await f.controller.action('host-permissions-request',{permission});
    assert.equal(state[permission],false);assert.equal(state.settingsOpened,permission);assert.equal(state.error,null);
    assert.equal(f.opened.at(-1),'x-apple.systempreferences:com.apple.preference.security?'+pane);
  }
  await f.controller.action('host-permissions-check');assert.equal(f.controller.snapshot().settingsOpened,null);assert.equal(f.opened.length,2);
});
test('successful grants and native request failures do not open settings',async t=>{
  const f=fixture(t);await f.controller.action('host-permissions-check');
  f.owner.request=async()=>{f.state.inputControl=true;};
  await f.controller.action('host-permissions-request',{permission:'inputControl'});assert.deepEqual(f.opened,[]);
  f.owner.request=async()=>{f.state.inputControl=false;throw Object.assign(Error('private'),{code:'HOST_PERMISSION_TIMEOUT'});};
  await f.controller.action('host-permissions-request',{permission:'inputControl'});assert.deepEqual(f.opened,[]);
});
test('closing or replacing the permission window prevents a late request from opening settings',async t=>{
  for(const close of [false,true]){
    const f=fixture(t);await f.controller.action('host-permissions-check');let settle;
    f.owner.request=()=>new Promise(resolve=>{settle=()=>{f.state.inputControl=false;resolve();};});
    const request=f.controller.action('host-permissions-request',{permission:'inputControl'});
    if(close)await f.controller.close();else await f.controller.releaseWindow();
    settle();await request;assert.deepEqual(f.opened,[]);assert.equal(f.controller.snapshot().settingsOpened,null);
  }
});
test('system-settings failure stays sanitized and stale opening completion cannot change a new window',async t=>{
  const f=fixture(t,{openSettings:async()=>{throw Error('/private/launch/failure');}});await f.controller.action('host-permissions-check');
  const state=await f.controller.action('host-permissions-request',{permission:'inputControl'});
  assert.equal(state.error,'HOST_SETTINGS_UNAVAILABLE');assert.equal(state.inputControl,false);assert.equal(state.settingsOpened,null);
  assert.ok(!message({code:state.error}).includes('/private'));
  let finish;f.controller.openSettings=()=>new Promise(resolve=>{finish=resolve;});
  const request=f.controller.action('host-permissions-request',{permission:'inputControl'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.controller.snapshot().busy,true);
  await assert.rejects(f.controller.action('host-permissions-check'),{code:'HOST_PERMISSIONS_BUSY'});
  await f.controller.releaseWindow();finish();await request;
  assert.equal(f.controller.snapshot().settingsOpened,null);assert.equal(f.controller.snapshot().error,null);assert.equal(f.controller.snapshot().busy,false);
});
