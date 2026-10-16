'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {HostController,message}=require('../electron/mac/host-controller.cjs');
const fault=code=>Object.assign(new Error(code),{code});
const request={id:'a'.repeat(32),generation:'b'.repeat(32),name:'Fixture device',verification:'1234 ABCD 5678',expires:Math.floor(Date.now()/1000)+120,state:'waiting'};
function fixture(t,options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-host-controller-'));
  for(const name of ['host-engine','host-companion'])if(options.missing!==name)fs.writeFileSync(path.join(directory,name+'-pin.json'),JSON.stringify({...(name==='host-engine'?{arch:'arm64'}:{}),commit:'a'.repeat(40),manifestSha256:'b'.repeat(64)}));
  const calls=[];let changed=()=>{};
  const session={phase:'stopped',current:null,error:null,engine:{state:{}},snapshot(){return {phase:this.phase,error:this.error};},
    update(phase,error=null){this.phase=phase;this.error=error;changed();},
    async start(name){calls.push(['start',name]);this.current={};this.update('starting');await Promise.resolve();this.update('running');},
    async stop(){calls.push(['stop']);this.update('stopping');this.current=null;this.update('stopped');},
    async close(){calls.push(['close']);this.current=null;this.update('closed');}};
  const controller=new HostController({directory,stateDirectory:path.join(directory,'host'),localName:'Trusted fixture name',platform:'darwin',arch:'arm64',
    create:({onUpdate})=>{changed=onUpdate;return {session,companion:{}};},
    rpc:async({op,data})=>{calls.push([op,data]);return op==='host-pair-list'?{requests:[request]}:{ok:true};},clientRequest:async()=>[],
    monitorOptions:{setTimer:()=>({unref(){}}),clearTimer(){}},...options});
  t.after(async()=>{await controller.close();assert.ok(path.basename(directory).startsWith('cliprelay-host-controller-'));fs.rmSync(directory,{recursive:true,force:true});});
  return {controller,session,calls,directory};
}
async function start(f){const status=await f.controller.action('host-start');assert.equal(status.phase,'starting');await f.controller.startTask;}
test('opening settings is read-only; start uses the trusted device name and exposes no owner internals',async t=>{
  const f=fixture(t);assert.deepEqual(f.calls,[]);assert.equal((await f.controller.action('host-status')).phase,'stopped');assert.deepEqual(f.calls,[]);
  await start(f);const status=await f.controller.action('host-status');assert.deepEqual(f.calls[0],['start','Trusted fixture name']);
  assert.deepEqual(Object.keys(status).sort(),['autoStart','available','clients','error','fileTransfer','nativeWorkers','phase','requests']);assert.equal(status.requests.length,1);assert.equal(status.clients.phase,'ready');
  status.requests[0].name='mutated';assert.equal(f.controller.snapshot().requests[0].name,'Fixture device');
  f.controller.releaseWindow();assert.equal(f.session.phase,'running');assert.ok(!f.calls.some(([op])=>op==='stop'));
});
test('partial package and unsupported platform never construct a host session',async t=>{
  for(const options of [{missing:'host-engine'},{missing:'host-companion'},{platform:'win32'}]){
    let created=0;const f=fixture(t,{...options,create:()=>{created++;throw Error('unexpected');}});
    assert.equal(f.controller.snapshot().available,false);assert.equal(created,0);await assert.rejects(f.controller.action('host-start'));
  }
});

test('controller withdraws the file capability on stop and close',async t=>{
  const f=fixture(t);f.session.snapshot=function(){return {phase:this.phase,error:null,fileTransfer:true};};
  assert.equal(f.controller.snapshot().fileTransfer,false);await start(f);assert.equal(f.controller.snapshot().fileTransfer,true);
  await f.controller.action('host-stop');assert.equal(f.controller.snapshot().fileTransfer,false);
  await start(f);await f.controller.close();assert.equal(f.controller.snapshot().fileTransfer,false);
});
test('actions reject arbitrary filenames, executable arguments and unregistered commands',async t=>{
  const f=fixture(t);
  for(const [action,data] of [['launch',{}],['host-start',{name:'untrusted'}],['host-status',{path:'/elsewhere'}],['host-stop',[]],['host-pair-approve',{id:'../escape'}]])await assert.rejects(f.controller.action(action,data),{code:'HOST_PAIR_INVALID'});
  assert.deepEqual(f.calls,[]);assert.ok(!message({message:'/private/secret'}).includes('secret'));
});
test('live decisions carry generation and verification; stale replies do not claim approval',async t=>{
  const f=fixture(t);await start(f);await f.controller.refresh();
  const data={id:request.id,generation:request.generation,verification:request.verification};
  await f.controller.action('host-pair-approve',data);assert.ok(f.calls.some(([op,payload])=>op==='host-pair-approve' && JSON.stringify(payload)===JSON.stringify(data)));
  f.controller.rpc=async()=>{throw fault('HOST_PAIR_STALE');};await assert.rejects(f.controller.action('host-pair-reject',data),{code:'HOST_PAIR_STALE'});
});
test('stopping cancels an in-flight read and late replies cannot restore previous requests',async t=>{
  const f=fixture(t);await start(f);let finish,signal;
  f.controller.rpc=args=>{signal=args.signal;return new Promise(resolve=>finish=resolve);};
  const reading=f.controller.refresh();await f.controller.action('host-stop');assert.equal(signal.aborted,true);
  finish({requests:[request]});await reading;assert.equal(f.controller.snapshot().phase,'stopped');assert.deepEqual(f.controller.snapshot().requests,[]);
});
test('a decision invalidates an older list even when its reply arrives last',async t=>{
  const f=fixture(t);await start(f);let finish,lists=0;
  f.controller.rpc=async({op})=>{if(op!=='host-pair-list')return {ok:true};if(++lists===1)return new Promise(resolve=>finish=resolve);return {requests:[]};};
  const old=f.controller.refresh();await f.controller.action('host-pair-reject',{id:request.id,generation:request.generation,verification:request.verification});
  finish({requests:[request]});await old;assert.deepEqual(f.controller.snapshot().requests,[]);assert.equal(f.controller.snapshot().error,null);
});
test('close cancels pending private requests and waits for both owned children through the session',async t=>{
  const f=fixture(t);await start(f);let release;f.session.close=()=>new Promise(resolve=>release=resolve);
  const closing=f.controller.close();assert.equal(f.controller.snapshot().available,false);await assert.rejects(f.controller.action('host-start'),{code:'HOST_SESSION_CLOSED'});
  await new Promise(resolve=>setImmediate(resolve));release();await closing;assert.equal(f.controller.snapshot().phase,'closed');
});

test('host client revoke is routed through the owned session and remains separate from pair approval',async t=>{
  const device={uuid:'aaaaaaaa-1111-2222-3333-444444444444',name:'Test client',enabled:true};let devices=[device];const writes=[];
  const f=fixture(t,{clientRequest:async({operation,uuid})=>{if(operation==='list')return devices.map(value=>({...value}));writes.push([operation,uuid]);if(operation==='disable')device.enabled=false;else devices=[];return {status:true};}});
  await start(f);const status=await f.controller.action('host-status');assert.deepEqual(status.clients.devices,[device]);
  const final=await f.controller.action('host-client-revoke',{viewId:status.clients.viewId,uuid:device.uuid});assert.deepEqual(final.clients.devices,[]);
  assert.deepEqual(writes,[['disable',device.uuid],['unpair',device.uuid]]);assert.equal(f.calls.some(([op])=>op==='host-pair-approve'),false);
});

test('automatic hosting is off by default; manual start does not persist future consent',async t=>{
  const saved=[],f=fixture(t,{saveAutoStart:async value=>saved.push(value)});await f.controller.launch();assert.deepEqual(f.calls,[]);
  await start(f);assert.equal(f.controller.snapshot().autoStart,false);assert.deepEqual(saved,[]);
  await f.controller.action('host-set-auto-start',{enabled:true});assert.deepEqual(saved,[true]);assert.equal(f.controller.snapshot().autoStart,true);
  await f.controller.action('host-set-auto-start',{enabled:false});assert.deepEqual(saved,[true,false]);assert.equal(f.session.phase,'running');
});
test('persisted strict opt-in starts once and permission failure never triggers a retry or a preference write',async t=>{
  const f=fixture(t,{autoStart:true,saveAutoStart:()=>assert.fail('must not write on launch')});
  await f.controller.launch();await f.controller.startTask;await f.controller.launch();assert.equal(f.calls.filter(([op])=>op==='start').length,1);
  const denied=fixture(t,{autoStart:true});let attempts=0;
  denied.session.start=async()=>{attempts++;denied.session.update('failed','HOST_PERMISSION_REQUIRED');throw fault('HOST_PERMISSION_REQUIRED');};
  await denied.controller.launch();await denied.controller.startTask;await denied.controller.launch();assert.equal(attempts,1);assert.equal(denied.controller.snapshot().error,'HOST_PERMISSION_REQUIRED');
  const malformed=fixture(t,{autoStart:'true'});await malformed.controller.launch();assert.deepEqual(malformed.calls,[]);
});
test('startup preference validation and failed persistence cannot change the selected value',async t=>{
  let fail=true;const f=fixture(t,{saveAutoStart:()=>{if(fail)throw Error('/private/config');}});
  for(const value of [{enabled:'true'},{enabled:true,path:'/elsewhere'},null])await assert.rejects(f.controller.action('host-set-auto-start',value),{code:'HOST_PREFERENCES_INVALID'});
  await assert.rejects(f.controller.action('host-set-auto-start',{enabled:true}),{code:'HOST_PREFERENCES_FAILED'});assert.equal(f.controller.snapshot().autoStart,false);
  fail=false;await f.controller.action('host-set-auto-start',{enabled:true});assert.equal(f.controller.snapshot().autoStart,true);assert.equal(f.session.phase,'stopped');
});
test('pending preference writes are serialized and joined on close without starting a host',async t=>{
  let finish,value;const f=fixture(t,{saveAutoStart:enabled=>{value=enabled;return new Promise(resolve=>finish=resolve);}}),data={enabled:true};
  const saving=f.controller.action('host-set-auto-start',data);data.enabled=false;await new Promise(resolve=>setImmediate(resolve));assert.equal(value,true);
  await assert.rejects(f.controller.action('host-set-auto-start',{enabled:false}),{code:'HOST_PREFERENCES_BUSY'});
  const closing=f.controller.close();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,0);finish();await saving;await closing;
  assert.equal(f.controller.snapshot().autoStart,true);assert.deepEqual(f.calls,[['close']]);
});
test('closing settings cancels foreground reads while the background request monitor continues',async t=>{
  const timers=new Set(),reads=[],notices=[];
  const f=fixture(t,{monitorOptions:{setTimer:fn=>{timers.add(fn);return fn;},clearTimer:fn=>timers.delete(fn)},onPairingRequest:value=>notices.push(value),
    rpc:({signal})=>new Promise(resolve=>reads.push({signal,resolve}))});
  await start(f);const tick=timers.values().next().value;timers.delete(tick);tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(reads.length,1);
  const foreground=f.controller.refreshPairing();f.controller.releaseWindow();assert.equal(reads[0].signal.aborted,false);assert.equal(reads[1].signal.aborted,true);
  reads[1].resolve({requests:[]});await foreground;reads[0].resolve({requests:[request]});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(notices,[{count:1}]);assert.equal(f.controller.snapshot().requests.length,1);
  await f.controller.action('host-stop');assert.equal(timers.size,0);assert.equal(f.controller.monitor.tasks.size,0);
});
