'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {HostController,message}=require('../electron/mac/host-controller.cjs');
const fault=code=>Object.assign(new Error(code),{code});
const request={id:'a'.repeat(32),generation:'b'.repeat(32),name:'Fixture device',verification:'1234 ABCD 5678',expires:Math.floor(Date.now()/1000)+120,state:'waiting'};
function fixture(t,options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-host-controller-'));
  for(const name of ['host-engine','host-companion'])if(options.missing!==name)fs.writeFileSync(path.join(directory,name+'-pin.json'),JSON.stringify({...(name==='host-engine'?{arch:'arm64'}:{}),commit:'a'.repeat(40),manifestSha256:'b'.repeat(64)}));
  const calls=[];let changed=()=>{};
  const session={phase:'stopped',current:null,error:null,snapshot(){return {phase:this.phase,error:this.error};},
    update(phase,error=null){this.phase=phase;this.error=error;changed();},
    async start(name){calls.push(['start',name]);this.current={};this.update('starting');await Promise.resolve();this.update('running');},
    async stop(){calls.push(['stop']);this.update('stopping');this.current=null;this.update('stopped');},
    async close(){calls.push(['close']);this.current=null;this.update('closed');}};
  const controller=new HostController({directory,stateDirectory:path.join(directory,'host'),localName:'Trusted fixture name',platform:'darwin',arch:'arm64',
    create:({onUpdate})=>{changed=onUpdate;return {session,companion:{}};},
    rpc:async({op,data})=>{calls.push([op,data]);return op==='host-pair-list'?{requests:[request]}:{ok:true};},...options});
  t.after(async()=>{await controller.close();assert.ok(path.basename(directory).startsWith('cliprelay-host-controller-'));fs.rmSync(directory,{recursive:true,force:true});});
  return {controller,session,calls,directory};
}
async function start(f){const status=await f.controller.action('host-start');assert.equal(status.phase,'starting');await f.controller.startTask;}
test('opening settings is read-only; start uses the trusted device name and exposes no owner internals',async t=>{
  const f=fixture(t);assert.deepEqual(f.calls,[]);assert.equal((await f.controller.action('host-status')).phase,'stopped');assert.deepEqual(f.calls,[]);
  await start(f);const status=await f.controller.action('host-status');assert.deepEqual(f.calls[0],['start','Trusted fixture name']);
  assert.deepEqual(Object.keys(status).sort(),['available','error','nativeWorkers','phase','requests']);assert.equal(status.requests.length,1);
  status.requests[0].name='mutated';assert.equal(f.controller.snapshot().requests[0].name,'Fixture device');
  f.controller.releaseWindow();assert.equal(f.session.phase,'running');assert.ok(!f.calls.some(([op])=>op==='stop'));
});
test('partial package and unsupported platform never construct a host session',async t=>{
  for(const options of [{missing:'host-engine'},{missing:'host-companion'},{platform:'win32'}]){
    let created=0;const f=fixture(t,{...options,create:()=>{created++;throw Error('unexpected');}});
    assert.equal(f.controller.snapshot().available,false);assert.equal(created,0);await assert.rejects(f.controller.action('host-start'));
  }
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
  release();await closing;assert.equal(f.controller.snapshot().phase,'closed');
});
