'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {HostMonitor}=require('../electron/mac/host-monitor.cjs');
const {HostNotices}=require('../electron/mac/host-notices.cjs');
const {loadConfig,saveConfig}=require('../electron/mac/config.cjs');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
  let now=0,wall=1000000,version=0,result={requests:[]};const timers=new Map(),notices=[],updates=[],errors=[];
  const session={current:null,phase:'stopped',snapshot(){return {phase:this.phase};}};
  const monitor=new HostMonitor({session,version:()=>version,read:async()=>result,onRequests:value=>updates.push(value),onError:error=>errors.push(error),onNotice:value=>notices.push(value),
    now:()=>now,wallNow:()=>wall,setTimer:(fn,delay)=>{const key={unref(){}};timers.set(key,{fn,delay});return key;},clearTimer:key=>timers.delete(key)});
  t.after(()=>monitor.close());
  const request=(generation='b',id='a')=>({id:id.repeat(32),generation:generation.repeat(32),name:'Private name',verification:'1234 ABCD 5678',expires:wall/1000+120,state:'waiting'});
  return {monitor,session,timers,notices,updates,errors,request,
    start(){session.current={};session.phase='running';monitor.reconcile();},set(value){result=value;},advance(ms){now+=ms;wall+=ms;},invalidate(){version++;},
    async tick(){assert.equal(timers.size,1);const [key,value]=timers.entries().next().value;timers.delete(key);value.fn();await settle();}};
}
test('background reads start only with a running owner and deduplicate exact live generations',async t=>{
  const f=fixture(t);f.monitor.reconcile();assert.equal(f.timers.size,0);f.start();f.set({requests:[f.request()]});
  await f.tick();assert.deepEqual(f.notices,[{count:1}]);assert.equal(f.updates.length,1);assert.equal(f.timers.values().next().value.delay,1500);
  await f.tick();assert.equal(f.notices.length,1);f.set({requests:[f.request('c')]});await f.tick();assert.equal(f.notices.length,2);
  f.set({requests:[{...f.request('d'),state:'approving'}]});await f.tick();assert.equal(f.notices.length,2);
  assert.ok(!JSON.stringify(f.notices).includes('Private'));assert.ok(!JSON.stringify(f.notices).includes('1234'));
});
test('transient failures retain deduplication and expired requests never create a notice',async t=>{
  const f=fixture(t);f.start();const request=f.request();f.set({requests:[request]});await f.tick();
  const read=f.monitor.read;f.monitor.read=async()=>{throw Error('disposable failure');};await f.tick();assert.equal(f.errors.length,1);
  f.monitor.read=read;await f.tick();assert.equal(f.notices.length,1);f.advance(121000);await f.tick();assert.equal(f.notices.length,1);assert.equal(f.monitor.record.seen.size,0);
});
test('notifications are coalesced and globally limited while suppressed requests remain readable',async t=>{
  const f=fixture(t);f.start();
  for(const generation of ['1','2','3','4','5']){f.set({requests:[f.request(generation),f.request(generation,'c')]});await f.tick();}
  assert.equal(f.notices.length,4);assert.deepEqual(f.notices.map(value=>value.count),[2,2,2,2]);assert.equal(f.updates.at(-1).length,2);
  f.advance(60000);await f.tick();assert.equal(f.notices.length,5);assert.ok(f.monitor.record.seen.size<=128);
  f.session.current={};f.monitor.reconcile();f.set({requests:[f.request('6')]});await f.tick();assert.equal(f.notices.length,6);
  assert.equal(f.monitor.issued.length,2);
});
test('slow reads never overlap; a replaced decision version cannot publish its old result',async t=>{
  const f=fixture(t);f.start();let finish;f.monitor.read=()=>new Promise(resolve=>finish=resolve);
  await f.tick();assert.equal(f.timers.size,0);assert.equal(f.monitor.tasks.size,1);f.invalidate();finish({requests:[f.request()]});await settle();
  assert.equal(f.updates.length,0);assert.equal(f.notices.length,0);assert.equal(f.timers.size,1);
});
test('stop aborts old work and close joins it without notifications or another timer',async t=>{
  const f=fixture(t);f.start();let finish,signal;f.monitor.read=value=>{signal=value;return new Promise(resolve=>finish=resolve);};
  await f.tick();f.session.phase='stopped';f.monitor.reconcile();assert.equal(signal.aborted,true);let closed=false;
  const closing=f.monitor.close().then(()=>closed=true);await settle();assert.equal(closed,false);finish({requests:[f.request()]});await closing;
  assert.equal(f.notices.length,0);assert.equal(f.updates.length,0);assert.equal(f.timers.size,0);f.start();assert.equal(f.timers.size,0);
});
test('a stopped owner during update cannot produce a notification afterward',async t=>{
  const f=fixture(t);f.start();f.set({requests:[f.request()]});f.monitor.onRequests=()=>{f.session.phase='stopped';f.monitor.reconcile();};
  await f.tick();assert.equal(f.notices.length,0);assert.equal(f.timers.size,0);
});
test('notification activation opens current settings only and stale callbacks are withdrawn',()=>{
  const shown=[];let active=true,opened=0;
  class Notification extends EventEmitter{static isSupported(){return true;}constructor(options){super();this.options=options;this.closed=0;}show(){shown.push(this);}close(){this.closed++;this.emit('close');}}
  const notices=new HostNotices({Notification,active:()=>active,open:()=>opened++});
  assert.equal(notices.show({count:0}),false);assert.equal(shown.length,0);assert.equal(notices.show({count:1}),true);const first=shown[0];
  first.emit('close');first.emit('click');assert.equal(opened,1);assert.deepEqual(Object.keys(first.options).sort(),['body','silent','title']);
  notices.show({count:2});first.emit('click');assert.equal(opened,1);assert.equal(first.closed,1);
  shown[1].emit('click');assert.equal(opened,2);active=false;shown[1].emit('click');assert.equal(opened,2);
  notices.close();active=true;shown[1].emit('click');assert.equal(opened,2);assert.equal(notices.show({count:1}),false);
});
test('unsupported or failing notifications do not affect the running host',()=>{
  for(const Notification of [class{static isSupported(){return false;}},class{static isSupported(){return true;}constructor(){throw Error('unavailable');}}]){
    const notices=new HostNotices({Notification,active:()=>true,open:()=>assert.fail('must not open')});assert.equal(notices.show({count:1}),false);notices.close();
  }
});
test('startup defaults on after migration and preserves subsequent explicit boolean settings',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-host-startup-'));
  try{
    const initial=loadConfig(directory,{legacy:()=>({}),defaults:()=>({}),hostname:()=> 'Disposable Mac'});assert.equal(initial.hostAutoStart,true);
    for(const invalid of [undefined,null,'true',1,{},[]]){saveConfig(directory,{...initial,hostAutoStart:invalid});assert.equal(loadConfig(directory).hostAutoStart,true);}
    saveConfig(directory,{...initial,hostAutoStart:true});const enabled=loadConfig(directory);assert.equal(enabled.hostAutoStart,true);assert.equal(enabled.deviceId,initial.deviceId);
    saveConfig(directory,{...enabled,hostAutoStart:false});assert.equal(loadConfig(directory).hostAutoStart,false);
  }finally{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(directory).startsWith('cliprelay-host-startup-'));fs.rmSync(directory,{recursive:true,force:true});}
});
