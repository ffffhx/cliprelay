'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),https=require('node:https');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const protocol=require('../electron/mac/wake-protocol.cjs');
const adapter=()=>({id:'12345678-1234-1234-1234-123456789012',name:'Ethernet',kind:'ethernet',mac:'02:11:22:33:44:aa',connected:true,addresses:[{address:'192.168.12.4',prefix:24}],powerManagement:'enabled',magicPacket:'enabled',wakeArmed:'enabled',configuration:'configured'});
const inventory=()=>({ok:true,supported:true,platform:'windows',wakeVerified:false,adapters:[adapter()]});
const sent=()=>({ok:true,state:'sent',sent:3,wakeVerified:false});
test('read-only inventory derives exact broadcastable networks and preserves unknown power capability',()=>{
  const value=inventory();value.adapters[0].addresses.push({address:'192.168.12.5',prefix:24},{address:'10.1.2.3',prefix:32});
  const parsed=protocol.inventory(value);assert.deepEqual(parsed.adapters[0].networks,['192.168.12.0/24']);assert.equal(parsed.adapters[0].mac,'02:11:22:33:44:AA');
  value.adapters[0].powerManagement='unknown';value.adapters[0].configuration='unknown';assert.equal(protocol.inventory(value).adapters[0].configuration,'unknown');
  value.adapters[0].configuration='configured';assert.throws(()=>protocol.inventory(value),{code:'WAKE_INVALID_RESPONSE'});
});
test('malformed inventory, duplicate adapter IDs and false physical-wake claims are rejected',()=>{
  for(const change of [v=>v.wakeVerified=true,v=>v.adapters.push({...v.adapters[0],id:v.adapters[0].id.toUpperCase()}),v=>v.adapters[0].connected='true',v=>v.adapters[0].addresses[0].address='127.0.0.1',v=>v.adapters[0].addresses[0].address='224.0.0.1',v=>v.adapters[0].addresses[0].prefix=0,v=>v.adapters[0].name='bad\0name',v=>v.adapters[0].wakeArmed='unsupported']){
    const value=inventory();change(value);assert.throws(()=>protocol.inventory(value),{code:'WAKE_INVALID_RESPONSE'});
  }
  for(const value of [{...sent(),wakeVerified:true},{...sent(),state:'awake'},{...sent(),sent:0},{...sent(),sent:25},{...sent(),sent:'3'}])assert.throws(()=>protocol.sent(value),{code:'WAKE_INVALID_RESPONSE'});
  assert.deepEqual(protocol.sent(sent()),{sent:3});
});
test('send body is restricted to canonical MAC, network and one request receipt',()=>{
  const binding={id:'a'.repeat(32),mac:'02:11:22:33:44:aa',network:'192.168.12.0/24',address:'evil',port:123,payload:'arbitrary'};
  assert.deepEqual(protocol.body('send',binding),{op:'send',id:binding.id,mac:'02:11:22:33:44:AA',network:'192.168.12.0/24'});
  for(const mac of ['00:00:00:00:00:00','FF:FF:FF:FF:FF:FF','01:11:22:33:44:55','021122334455'])assert.throws(()=>protocol.body('send',{...binding,mac}),{code:'WAKE_BAD_REQUEST'});
  for(const network of ['192.168.12.4/24','192.168.12.0/024','192.168.012.0/24','0.0.0.0/0','192.168.12.0/31','192.168.12.0/32','::/64'])assert.throws(()=>protocol.body('send',{...binding,network}),{code:'WAKE_BAD_REQUEST'});
  assert.throws(()=>protocol.body('status',binding),{code:'WAKE_BAD_REQUEST'});
});
test('wake inventory and send acknowledgment use pinned mutual TLS without emitting a UDP packet',async t=>{
  const calls=[];let failure='';const server=https.createServer({key:identities.host.key,cert:identities.host.cert,requestCert:true,rejectUnauthorized:false},async(req,res)=>{
    assert.ok(req.socket.getPeerCertificate().raw);assert.equal(req.url,'/v1/wake');assert.equal(req.method,'POST');let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);calls.push(body);if(failure){res.writeHead(429);res.end(JSON.stringify({ok:false,code:failure}));return;}
    res.end(JSON.stringify(body.op==='status'?inventory():sent()));
  });const port=await listen(server);t.after(()=>close(server));const host={address:'127.0.0.1',port:port-2,certificate:identities.host.cert};
  assert.equal((await protocol.request(host,identities.client,'status')).adapters.length,1);
  assert.deepEqual(await protocol.request(host,identities.client,'send',{id:'a'.repeat(32),mac:adapter().mac,network:'192.168.12.0/24'}),{sent:3});
  await assert.rejects(protocol.request({...host,certificate:identities.wrong.cert},identities.client,'status'),{code:'HOST_CERT_CHANGED'});assert.equal(calls.length,2);
  failure='WAKE_RATE_LIMITED';await assert.rejects(protocol.request(host,identities.client,'status'),{code:'WAKE_RATE_LIMITED'});
});
