'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {LoginStartup}=require('../electron/mac/login-startup.cjs');
function fixture({status='not-registered',packaged=true,platform='darwin',write,read}={}){
  const writes=[];let current=status,reads=0;
  const app={isPackaged:packaged,getLoginItemSettings(options){reads++;assert.deepEqual(options,{type:'mainAppService'});return read?read():{status:current,openAtLogin:current==='enabled'};},
    setLoginItemSettings(options){writes.push(options);if(write)write(options);else current=options.openAtLogin?'enabled':'not-registered';}};
  const owner=new LoginStartup({app,platform});
  return {app,owner,writes,get reads(){return reads;},set status(value){current=value;}};
}
test('launch and refresh only read system settings and never replay a saved opt-in',()=>{
  const f=fixture();assert.equal(f.owner.snapshot().enabled,false);f.owner.refresh();assert.deepEqual(f.writes,[]);
  f.status='enabled';assert.equal(f.owner.refresh().enabled,true);
  f.status='not-registered';assert.equal(f.owner.refresh().enabled,false);assert.deepEqual(f.writes,[]);
});
test('explicit toggles read back actual state, persist across owners and close preserves the preference',()=>{
  const f=fixture();assert.equal(f.owner.setEnabled({enabled:true}).enabled,true);
  f.owner.close();assert.equal(f.owner.snapshot().available,false);
  const reopened=new LoginStartup({app:f.app,platform:'darwin'});assert.equal(reopened.snapshot().enabled,true);
  assert.equal(reopened.setEnabled({enabled:false}).status,'not-registered');
  assert.deepEqual(f.writes,[{type:'mainAppService',openAtLogin:true},{type:'mainAppService',openAtLogin:false}]);
});
test('pending system approval stays visibly unconfirmed and can be removed',()=>{
  const f=fixture({write:options=>{f.status=options.openAtLogin?'requires-approval':'not-registered';}});
  const pending=f.owner.setEnabled({enabled:true});assert.equal(pending.status,'requires-approval');assert.equal(pending.enabled,false);assert.equal(pending.registered,true);
  assert.equal(f.owner.setEnabled({enabled:false}).registered,false);
});
test('a previously unseen system service may be explicitly registered without treating not-found as enabled',()=>{
  const f=fixture({status:'not-found'});assert.equal(f.owner.snapshot().enabled,false);assert.equal(f.owner.snapshot().registered,false);
  assert.deepEqual(f.writes,[]);assert.equal(f.owner.setEnabled({enabled:true}).status,'enabled');
});
test('silent OS failure, exceptions and inconsistent reads never claim a successful change',()=>{
  const unchanged=fixture({write:()=>{}});assert.throws(()=>unchanged.owner.setEnabled({enabled:true}),{code:'LOGIN_STARTUP_UNCONFIRMED'});assert.equal(unchanged.owner.snapshot().enabled,false);
  const denied=fixture({status:'enabled',write:()=>{throw Error('private OS detail');}});assert.throws(()=>denied.owner.setEnabled({enabled:false}),{code:'LOGIN_STARTUP_UNCONFIRMED'});assert.equal(denied.owner.snapshot().enabled,true);
  for(const read of [()=>({status:'enabled',openAtLogin:false}),()=>({status:'future',openAtLogin:false}),()=>{throw Error('private path');}]){
    const f=fixture({read});assert.equal(f.owner.snapshot().status,'unknown');assert.equal(f.owner.snapshot().enabled,false);assert.deepEqual(f.writes,[]);
  }
});
test('invalid requests, source Electron, other platforms and a closed owner cannot write settings',()=>{
  const f=fixture();for(const value of [null,[],true,{},{enabled:'true'},{enabled:true,path:'/arbitrary'}])assert.throws(()=>f.owner.setEnabled(value),{code:'LOGIN_STARTUP_INVALID'});
  f.owner.close();const reads=f.reads;f.owner.refresh();assert.equal(f.reads,reads);assert.throws(()=>f.owner.setEnabled({enabled:true}),{code:'LOGIN_STARTUP_CLOSED'});assert.deepEqual(f.writes,[]);
  for(const options of [{packaged:false},{platform:'win32'}]){const other=fixture(options);assert.equal(other.reads,0);assert.equal(other.owner.snapshot().available,false);assert.throws(()=>other.owner.setEnabled({enabled:true}),{code:'LOGIN_STARTUP_UNAVAILABLE'});assert.deepEqual(other.writes,[]);}
});
