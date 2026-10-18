'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {identities}=require('./mac-pairing-fixture.cjs');
const {WakeStore}=require('../electron/mac/wake-store.cjs');
const {WakeController}=require('../electron/mac/wake-controller.cjs');
const {fault}=require('../electron/mac/paired-transport.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<600;i++){if(check())return;await delay(5);}throw Error('wake test deadline');}
const host=(cert,client,name)=>({id:crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest('hex'),clientId:client.repeat(32),certificate:cert,name,enabled:true,address:'127.0.0.1',port:40000,routeId:'initial'});
const adapter=()=>({id:'12345678-1234-1234-1234-123456789012',name:'Ethernet',kind:'ethernet',mac:'02:11:22:33:44:AA',connected:true,networks:['192.168.12.0/24'],configuration:'configured'});
function fixture(t,{onRequest,observeMs=10000}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-wake-control-'));
  const target=host(identities.host.cert,'a','Target'),helper=host(identities.wrong.cert,'b','Helper');
  const store={list:[target,helper],selectedId:target.id,hosts(){return this.list;},selected(){return this.list.find(h=>h.id===this.selectedId);},identity:async()=>identities.client};
  let now=100000,wall=1792000000000;const preferences=new WakeStore(directory,{now:()=>wall});
  const s={online:true,target:{adapters:[adapter()]},helper:{adapters:[{...adapter(),id:'aaaaaaaa-1234-1234-1234-123456789012'}]},emissions:0};const calls=[],receipts=new Set();
  const request=async(h,identity,op,body,signal)=>{
    const call={host:{...h},op,body:body?{...body}:null,signal};calls.push(call);
    if(onRequest){const result=await onRequest({call,s});if(result!==undefined)return result;}
    if(signal?.aborted)throw fault('CANCELLED');
    if(op==='status'){if(h.id===target.id){if(!s.online)throw fault('ECONNREFUSED');return structuredClone(s.target);}return structuredClone(s.helper);}
    assert.equal(op,'send');assert.equal(h.id,helper.id);if(!receipts.has(body.id)){receipts.add(body.id);s.emissions++;}return {sent:3};
  };
  const controller=new WakeController({store,preferences,request,now:()=>now,pollMs:10,observeMs});controller.reconcile();
  t.after(()=>{controller.close();fs.rmSync(path.join(directory,'wake.json'),{force:true});fs.rmdirSync(directory);});
  const action=(name,extra={})=>controller.action(name,{viewId:controller.snapshot().viewId,...extra});
  return {controller,store,preferences,calls,s,target,helper,action,advance(ms){now+=ms;},expire(){wall+=31*86400000;},
    async prepare(){action('wake-prepare');await until(()=>controller.snapshot().phase==='choosing');},
    async configure(){await this.prepare();const state=controller.snapshot();action('wake-save',{adapter:state.adapters[0].id,helper:state.helpers[0].id,sameLan:true});await until(()=>controller.snapshot().configured&&controller.snapshot().phase==='ready');}
  };
}
test('configuration requires explicit same-LAN confirmation and rechecks both pinned inventories',async t=>{
  const f=fixture(t);assert.equal(f.calls.length,0);await f.prepare();const state=f.controller.snapshot();
  assert.ok(!JSON.stringify(state).includes('CERTIFICATE'));assert.ok(!JSON.stringify(state).includes(adapter().mac));
  assert.throws(()=>f.action('wake-save',{adapter:state.adapters[0].id,helper:state.helpers[0].id,sameLan:false}),{code:'WAKE_CONFIRM_LAN'});
  f.action('wake-save',{adapter:state.adapters[0].id,helper:state.helpers[0].id,sameLan:true});await until(()=>f.controller.snapshot().configured);
  assert.equal(f.calls.filter(c=>c.host.id===f.target.id&&c.op==='status').length,2);assert.equal(f.calls.filter(c=>c.host.id===f.helper.id&&c.op==='status').length,1);assert.equal(f.s.emissions,0);
});
test('helper on another network and target adapter replacement cannot create a configuration',async t=>{
  const f=fixture(t);await f.prepare();f.s.helper.adapters[0].networks=['10.0.0.0/24'];let state=f.controller.snapshot();
  f.action('wake-save',{adapter:state.adapters[0].id,helper:state.helpers[0].id,sameLan:true});await until(()=>f.controller.snapshot().phase==='error');assert.equal(f.controller.snapshot().error,'WAKE_NOT_ON_LAN');assert.equal(f.preferences.records.length,0);
  await f.prepare();f.s.target.adapters[0].mac='02:11:22:33:44:BB';state=f.controller.snapshot();f.action('wake-save',{adapter:state.adapters[0].id,helper:state.helpers[0].id,sameLan:true});
  await until(()=>f.controller.snapshot().phase==='error');assert.equal(f.controller.snapshot().error,'WAKE_TARGET_CHANGED');assert.equal(f.preferences.records.length,0);
});
test('configuration choices expire and cannot silently select a replacement helper route',async t=>{
  const f=fixture(t);await f.prepare();let state=f.controller.snapshot();f.advance(30001);assert.throws(()=>f.action('wake-save',{adapter:state.adapters[0].id,helper:state.helpers[0].id,sameLan:true}),{code:'WAKE_NOT_READY'});
  await f.prepare();state=f.controller.snapshot();f.store.list[1]={...f.helper,routeId:'replacement'};assert.throws(()=>f.action('wake-save',{adapter:state.adapters[0].id,helper:state.helpers[0].id,sameLan:true}),{code:'WAKE_STALE'});
  assert.equal(f.preferences.records.length,0);
});
test('offline target uses an online helper; packet receipt is separate from target response',async t=>{
  const f=fixture(t);await f.configure();f.s.online=false;f.action('wake-send');await until(()=>f.controller.snapshot().packetSent);
  assert.equal(f.controller.snapshot().phase,'waiting');assert.equal(f.s.emissions,1);assert.equal(f.calls.filter(c=>c.op==='send').length,1);
  f.s.online=true;await until(()=>f.controller.snapshot().phase==='online');assert.equal(f.s.emissions,1);
  const write=f.calls.find(c=>c.op==='send');assert.deepEqual(Object.keys(write.body),['id','mac','network']);assert.equal(write.body.mac,adapter().mac);
});
test('target already online responds without sending any wake packet',async t=>{
  const f=fixture(t);await f.configure();f.action('wake-send');await until(()=>f.controller.snapshot().phase==='online');assert.equal(f.s.emissions,0);
  assert.equal(f.controller.snapshot().packetSent,false);
});
test('a lost acknowledgment never retries automatically and manual retry keeps the exact receipt',async t=>{
  let lost=true,accepted='';const f=fixture(t,{onRequest:({call,s})=>{if(call.op==='send'){if(!accepted){accepted=call.body.id;s.emissions++;}else assert.equal(call.body.id,accepted);if(lost)throw fault('ECONNRESET');return {sent:3};}}});
  await f.configure();f.s.online=false;f.action('wake-send');await until(()=>f.controller.snapshot().phase==='unconfirmed');await delay(40);
  assert.equal(f.calls.filter(c=>c.op==='send').length,1);assert.equal(f.controller.snapshot().canSend,false);assert.equal(f.controller.snapshot().canRetry,true);
  lost=false;f.action('wake-retry');await until(()=>f.controller.snapshot().packetSent);assert.equal(f.s.emissions,1);
  const writes=f.calls.filter(c=>c.op==='send');assert.deepEqual(writes[0].body,writes[1].body);assert.deepEqual(writes[0].host,writes[1].host);
});
test('route replacement or helper removal forbids replay of an uncertain request',async t=>{
  const f=fixture(t,{onRequest:({call})=>{if(call.op==='send')throw fault('ECONNRESET');}});await f.configure();f.s.online=false;f.action('wake-send');await until(()=>f.controller.snapshot().canRetry);
  f.store.list[1]={...f.helper,routeId:'new'};assert.equal(f.controller.snapshot().canRetry,false);assert.throws(()=>f.action('wake-retry'),{code:'WAKE_NOT_READY'});
  f.store.list.pop();f.controller.reconcile();assert.equal(f.controller.snapshot().configured,false);assert.equal(f.controller.snapshot().canSend,false);assert.equal(f.calls.filter(c=>c.op==='send').length,1);
});
test('stop during a pending send retains uncertainty and discards a late success reply',async t=>{
  let release;const f=fixture(t,{onRequest:({call})=>{if(call.op==='send')return new Promise(resolve=>release=()=>resolve({sent:3}));}});await f.configure();f.s.online=false;f.action('wake-send');await until(()=>release);
  f.action('wake-stop');assert.equal(f.controller.snapshot().phase,'unconfirmed');assert.equal(f.controller.snapshot().packetSent,false);release();await delay(20);
  assert.equal(f.controller.snapshot().phase,'unconfirmed');assert.equal(f.controller.snapshot().packetSent,false);assert.equal(f.calls.filter(c=>c.op==='send').length,1);
});
test('switching target or stopping during preflight prevents an unsent packet',async t=>{
  let hold=false,release;const f=fixture(t,{onRequest:({call,s})=>{if(hold&&call.op==='status'&&call.host.name==='Helper')return new Promise(resolve=>release=()=>resolve(s.helper));}});
  await f.configure();f.s.online=false;hold=true;f.action('wake-send');await until(()=>release);f.store.selectedId=f.helper.id;f.controller.reconcile();release();await delay(20);
  assert.equal(f.calls.filter(c=>c.op==='send').length,0);assert.equal(f.controller.snapshot().target,'Helper');
});
test('an observed-online deadline and stop cannot claim that the target woke',async t=>{
  const f=fixture(t,{observeMs:30});await f.configure();f.s.online=false;f.action('wake-send');await until(()=>f.controller.snapshot().packetSent);f.advance(31);
  await until(()=>f.controller.snapshot().phase==='unconfirmed');assert.equal(f.controller.snapshot().packetSent,true);assert.equal(f.calls.filter(c=>c.op==='send').length,1);
});
test('expired config and expired replay window disable their corresponding operations',async t=>{
  const f=fixture(t,{onRequest:({call})=>{if(call.op==='send')throw fault('ECONNRESET');}});await f.configure();f.s.online=false;f.action('wake-send');await until(()=>f.controller.snapshot().canRetry);
  f.advance(90001);assert.equal(f.controller.snapshot().canRetry,false);assert.equal(f.controller.snapshot().canSend,false);
  f.advance(60000);assert.equal(f.controller.snapshot().canSend,true);f.expire();assert.equal(f.controller.snapshot().canSend,false);assert.equal(f.controller.snapshot().configured,false);
});
test('revoked target and malformed status stop before packet emission; renderer cannot forge network parameters',async t=>{
  let code='';const f=fixture(t,{onRequest:({call})=>{if(call.host.name==='Target'&&code)throw fault(code);}});await f.configure();
  for(const extra of [{mac:adapter().mac},{network:'10.0.0.0/24'},{host:'other'},{id:'a'.repeat(32)}])assert.throws(()=>f.action('wake-send',extra),{code:'WAKE_BAD_REQUEST'});
  for(const value of ['UNPAIRED','HOST_CERT_CHANGED','WAKE_INVALID_RESPONSE']){
    code='';if(!f.controller.snapshot().configured){f.store.list[0]={...f.store.list[0],clientId:crypto.randomBytes(16).toString('hex')};f.controller.reconcile();await f.configure();}code=value;f.action('wake-send');await until(()=>f.controller.snapshot().phase==='error');assert.equal(f.s.emissions,0);
    if(value!=='WAKE_INVALID_RESPONSE'){assert.equal(f.controller.snapshot().configured,false);assert.equal(f.controller.snapshot().canSend,false);}
  }
});
