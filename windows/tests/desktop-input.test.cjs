'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),https=require('node:https');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const protocol=require('../electron/mac/input-protocol.cjs');
const instance='12345678-1234-1234-1234-123456789012';
function state(){return {protocol:1,supported:true,instance,streams:[{id:3,epoch:1,acknowledged:1,enabled:true,paused:true,pending:false,closed:false,failed:false,exclusive:true}]};}
test('input state requires exact stream, engine, epoch and explicit exclusivity',()=>{
  const parsed=protocol.state(state());assert.ok(protocol.acknowledged(parsed,instance,3,1));
  for(const [engine,id,epoch] of [['wrong',3,1],[instance,4,1],[instance,3,3]])assert.equal(protocol.acknowledged(parsed,engine,id,epoch),false);
  for(const change of [{exclusive:false},{closed:true},{pending:true,acknowledged:0},{failed:true,acknowledged:0}]){
    const value=state();Object.assign(value.streams[0],change);
    assert.equal(protocol.acknowledged(protocol.state(value),instance,3,1),false);
  }
  const value=state();value.streams[0].epoch=value.streams[0].acknowledged=2;value.streams[0].paused=false;
  assert.ok(protocol.acknowledged(protocol.state(value),instance,3,2));
});
test('unsafe IDs, inconsistent flags and replay-looking acknowledgments are rejected',()=>{
  for(const change of [{id:Number.MAX_SAFE_INTEGER+1},{id:0},{epoch:0},{epoch:0x100000000},{epoch:1.5},
    {acknowledged:2},{acknowledged:0},{paused:false},{pending:true},{pending:true,closed:true,acknowledged:0},
    {pending:true,failed:true,acknowledged:0},{enabled:false},{exclusive:1},{closed:'false'}]){
    const value=state();Object.assign(value.streams[0],change);assert.throws(()=>protocol.state(value),{code:'INPUT_INVALID_RESPONSE'},JSON.stringify(change));
  }
  const duplicate=state();duplicate.streams.push({...duplicate.streams[0]});assert.throws(()=>protocol.state(duplicate));
  const competing=state();competing.streams.push({...competing.streams[0],id:4});assert.throws(()=>protocol.state(competing));
  for(const stream of competing.streams)stream.exclusive=false;
  assert.equal(protocol.acknowledged(protocol.state(competing),instance,3,1),false);
});
test('legacy and unsupported input states stay unavailable without guessing',()=>{
  assert.deepEqual(protocol.state({protocol:1,supported:false,streams:[]}),{supported:false,streams:[]});
  const legacy=state();Object.assign(legacy.streams[0],{enabled:false,epoch:0,acknowledged:0,paused:false});
  assert.equal(protocol.acknowledged(protocol.state(legacy),instance,3,0),false);
  for(const change of [{protocol:2},{instance:''},{streams:null},{supported:false},{streams:Array(65).fill({})}])assert.throws(()=>protocol.state({...state(),...change}));
});
test('owner frames match CRIC layout, reserve zero bytes and enforce operation parity',()=>{
  assert.equal(protocol.command(1,'pause').toString('hex'),'43524943010100000000000100000000');
  assert.equal(protocol.command(2,'resume').toString('hex'),'43524943010200000000000200000000');
  assert.equal(protocol.command(0xffffffff,'acknowledge').toString('hex'),'4352494301030000ffffffff00000000');
  for(const [epoch,op] of [[0,'pause'],[2,'pause'],[1,'resume'],[0x100000000,'pause'],[1.5,'pause'],[1,'unknown'],[1,'toString']])assert.throws(()=>protocol.command(epoch,op),{code:'INPUT_INVALID_COMMAND'});
});
test('local submission and acknowledgment events are distinct and strictly bounded',()=>{
  for(const stage of ['submitted','acknowledged'])assert.deepEqual(protocol.event({version:1,event:'input',epoch:1,stage}),{epoch:1,stage});
  for(const change of [{version:2},{event:'connected'},{epoch:0},{epoch:'1'},{stage:'host'},{extra:1}])assert.throws(()=>protocol.event({version:1,event:'input',epoch:1,stage:'submitted',...change}));
});
test('read-only paired input observation uses exact pinned mutual TLS',async t=>{
  const reads=[];
  const server=https.createServer({key:identities.host.key,cert:identities.host.cert,requestCert:true,rejectUnauthorized:false},(req,res)=>{
    assert.ok(req.socket.getPeerCertificate().raw);reads.push([req.method,req.url]);res.end(JSON.stringify(state()));
  });
  const port=await listen(server);t.after(()=>close(server));
  const result=await protocol.request({address:'127.0.0.1',port:port-2,certificate:identities.host.cert},identities.client);
  assert.ok(protocol.acknowledged(result,instance,3,1));assert.deepEqual(reads,[['GET','/v1/input-state']]);
});
test('wrong host pin receives zero HTTP and revoked pairing cannot acknowledge',async t=>{
  let reads=0;
  const server=https.createServer({key:identities.host.key,cert:identities.host.cert},(req,res)=>{++reads;res.writeHead(403);res.end();});
  const port=await listen(server);t.after(()=>close(server));
  const host={address:'127.0.0.1',port:port-2,certificate:identities.wrong.cert};
  await assert.rejects(protocol.request(host,identities.client),{code:'HOST_CERT_CHANGED'});assert.equal(reads,0);
  await assert.rejects(protocol.request({...host,certificate:identities.host.cert},identities.client),{code:'UNPAIRED'});assert.equal(reads,1);
});
