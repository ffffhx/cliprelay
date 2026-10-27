'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),readline=require('node:readline');
const {BrokerClient}=require('../electron/mac/network-broker.cjs');
(async()=>{
  const lines=readline.createInterface({input:process.stdin})[Symbol.asyncIterator]();
  const config=JSON.parse((await lines.next()).value);
  const client=new BrokerClient(crypto.randomBytes(32).toString('base64url'),{endpoint:config.endpoint,ca:config.ca});
  if(config.discovery){const directory=await client.request('directory');assert.equal(directory.devices.length,1);assert.equal(directory.devices[0].id,config.hostId);assert.equal(directory.devices[0].connectable,true);}
  const claimed=config.discovery?await client.request('connect-device',{id:config.hostId,name:'Desktop fixture'}):await client.request('claim',{code:config.code,name:'Desktop fixture'});
  assert.equal(claimed.id,client.id);assert.equal((await client.request('status')).state,config.discovery?'approved':'pending');
  if(!config.discovery)await assert.rejects(client.request('enroll'),{code:'NETWORK_NOT_APPROVED'});
  console.log(JSON.stringify({phase:'claimed',id:claimed.id}));
  assert.equal((await lines.next()).value,'approved');
  const state=await client.request('status');assert.equal(state.state,'approved');assert.equal(state.peers[0].id,config.hostId);assert.equal(state.peers[0].addresses[0],'100.64.0.2');
  const enrollment=await client.request('enroll');assert.equal(enrollment.hostname,'cr-'+client.id);assert.ok(enrollment.authKey);assert.equal(enrollment.controlUrl,'https://control.invalid');
  console.log(JSON.stringify({phase:'enrolled'}));
  assert.equal((await lines.next()).value,'revoked');await assert.rejects(client.request('status'),{code:'NETWORK_REVOKED'});
  console.log(JSON.stringify({phase:'complete',passed:true}));process.exit(0);
})().catch(()=>{console.error('Desktop broker interoperability failed');process.exit(1);});
