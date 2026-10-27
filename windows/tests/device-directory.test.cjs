'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DeviceDirectory}=require('../electron/device-directory.cjs');
test('background presence never enumerates computers or publishes public discoverability',async()=>{
 const calls=[];const directory=new DeviceDirectory({request:async(action,data)=>{calls.push({action,data});return action==='snapshot'?{config:{deviceId:'self',deviceName:'Me',discoveryEnabled:true}}:{ok:true};},client:{request(){throw new Error('must not enumerate');}}});
 directory.running=true;try{await directory.poll();assert.equal(calls[1].data.presence.discoverable,false);assert.deepEqual(directory.snapshot().devices,[]);}finally{directory.stop();}
});
