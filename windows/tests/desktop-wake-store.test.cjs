'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {identities}=require('./mac-pairing-fixture.cjs');
const {WakeStore,lifetime}=require('../electron/mac/wake-store.cjs');
const host=(cert,client)=>({id:crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest('hex'),clientId:client.repeat(32),certificate:cert,enabled:true,address:'127.0.0.1',port:40000,routeId:'temporary'});
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-wake-store-'));t.after(()=>{fs.rmSync(path.join(directory,'wake.json'),{force:true});fs.rmdirSync(directory);});
  const target=host(identities.host.cert,'a'),helper=host(identities.wrong.cert,'b'),adapter={id:'12345678-1234-1234-1234-123456789012',mac:'02:11:22:33:44:AA',connected:true,networks:['192.168.12.0/24']};
  let now=1792000000000;const store=new WakeStore(directory,{now:()=>now});return {directory,target,helper,adapter,store,now(value){now=value;},save(){return store.save(target,helper,adapter,adapter.networks[0]);}};
}
test('wake choice survives restart without persisting keys, addresses or transient routes',t=>{
  const f=fixture(t),saved=f.save(),raw=fs.readFileSync(path.join(f.directory,'wake.json'),'utf8');
  for(const forbidden of ['CERTIFICATE','PRIVATE','temporary','127.0.0.1','40000'])assert.ok(!raw.includes(forbidden));
  const again=new WakeStore(f.directory,{now:()=>saved.capturedAt});assert.deepEqual(again.get({...f.target,routeId:'changed',port:50000},[f.helper]),saved);
  const copy=again.get(f.target,[f.helper]);copy.network='altered';assert.equal(again.get(f.target,[f.helper]).network,'192.168.12.0/24');
});
test('changed pairing, helper removal, future timestamp and expired selection all disable reuse',t=>{
  const f=fixture(t),saved=f.save();assert.ok(f.store.get(f.target,[f.helper]));
  assert.equal(f.store.get({...f.target,clientId:'c'.repeat(32)},[f.helper]),null);
  assert.equal(f.store.get(f.target,[{...f.helper,networkId:'d'.repeat(32)}]),null);
  assert.equal(f.store.get(f.target,[]),null);assert.equal(f.store.get({...f.target,certificate:identities.wrong.cert},[f.helper]),null);
  f.now(saved.capturedAt-1);assert.equal(f.store.get(f.target,[f.helper]),null);f.now(saved.capturedAt+lifetime+1);assert.equal(f.store.get(f.target,[f.helper]),null);
  f.store.reconcile([f.target]);assert.equal(f.store.records.length,0);
});
test('save requires a connected observed adapter and a different pinned helper; failed write preserves prior selection',t=>{
  const f=fixture(t),saved=f.save();assert.throws(()=>f.store.save(f.target,f.target,f.adapter,f.adapter.networks[0]));
  assert.throws(()=>f.store.save(f.target,f.helper,{...f.adapter,connected:false},f.adapter.networks[0]));assert.throws(()=>f.store.save(f.target,f.helper,f.adapter,'10.0.0.0/24'));
  f.store.write=()=>{throw Error('disk full');};assert.throws(()=>f.store.remove(f.target.id),/disk full/);assert.deepEqual(f.store.get(f.target,[f.helper]),saved);
});
test('duplicate, injected-route and oversized stored records are rejected',t=>{
  const f=fixture(t),saved=f.save(),file=path.join(f.directory,'wake.json');
  for(const value of [{version:1,records:[saved,saved]},{version:1,records:[{...saved,target:{...saved.target,address:'other'}}]},{version:1,records:Array(17).fill(saved)}]){
    fs.writeFileSync(file,JSON.stringify(value));assert.throws(()=>new WakeStore(f.directory),{code:'WAKE_INVALID_STORAGE'});
  }
});
