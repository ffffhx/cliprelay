'use strict';
const assert=require('node:assert/strict');
const protocol=require('../electron/mac/wake-protocol.cjs');
async function main(){
  let raw='';for await(const chunk of process.stdin)raw+=chunk;const {host,identity}=JSON.parse(raw);
  const inventory=await protocol.request(host,identity,'status');assert.equal(inventory.adapters[0].configuration,'unknown');assert.deepEqual(inventory.adapters[0].networks,['192.168.0.0/24']);
  const binding={id:'a'.repeat(32),mac:'02:11:22:33:44:55',network:'192.168.0.0/24'};
  assert.deepEqual(await protocol.request(host,identity,'send',binding),{sent:3});
  assert.deepEqual(await protocol.request(host,identity,'send',binding),{sent:3});
  await assert.rejects(protocol.request(host,identity,'send',{...binding,mac:'02:11:22:33:44:66'}),{code:'WAKE_ID_CONFLICT'});
  await assert.rejects(protocol.request(host,identity,'send',{...binding,id:'b'.repeat(32)}),{code:'WAKE_RATE_LIMITED'});
  console.log(JSON.stringify({passed:true,replayed:true}));
}
main().catch(error=>{console.error('desktop wake fixture failed:',error.code||error.message);process.exitCode=1;});
