'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DeviceDirectory}=require('../electron/device-directory.cjs');
const pc={id:'a'.repeat(24),deviceId:'local-friend',name:'Friend',platform:'windows',connectable:true};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('public directory filters self and keeps outbound discovery independent of publishing',async()=>{
  const calls=[];let discoverable=true,failed=false;
  const directory=new DeviceDirectory({request:async(action,data)=>{
    calls.push({action,data});return action==='snapshot'?{config:{deviceId:'self',deviceName:'Me',discoveryEnabled:discoverable}}:{ok:true,data:{id:'b'.repeat(24)}};
  },client:{async request(action){assert.equal(action,'directory');if(failed)throw new Error();return {devices:[pc,{...pc,id:'b'.repeat(24),deviceId:'self'}]};}}});
  directory.running=true;
  try{
    await directory.poll();clearTimeout(directory.timer);
    assert.deepEqual(directory.snapshot().devices,[pc]);assert.equal(calls[1].data.presence.discoverable,true);
    discoverable=false;await directory.poll();clearTimeout(directory.timer);
    assert.equal(calls.at(-1).data.presence.discoverable,false);assert.deepEqual(directory.snapshot().devices,[pc]);
    failed=true;await directory.poll();clearTimeout(directory.timer);
    assert.equal(directory.snapshot().devices.length,0);assert.ok(directory.snapshot().error);
  }finally{directory.stop();}
});
test('stopping ignores late directory results and aborts requests',async()=>{
  const gate=deferred();let signal;
  const directory=new DeviceDirectory({request:async action=>action==='snapshot'?{config:{deviceId:'self',deviceName:'Me',discoveryEnabled:true}}:{ok:false},client:{request(action,data,s){signal=s;return gate.promise;}}});
  directory.running=true;const work=directory.poll();await new Promise(r=>setImmediate(r));directory.stop();
  gate.resolve({devices:[pc]});await work;
  assert.equal(signal.aborted,true);assert.equal(directory.snapshot().devices.length,0);
});
