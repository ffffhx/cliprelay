'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {probeComputer,DirectConnection}=require('../electron/desktop-connection.cjs');
const xml='<root status_code="200"><appversion>7.1.431</appversion><uniqueid>host</uniqueid><state>SUNSHINE_SERVER_FREE</state></root>';
test('remote availability checks the remote protocol, rejects clipboard replies and bounds slow responses',async()=>{
  let reply=xml;const paths=[];
  const server=http.createServer((req,res)=>{paths.push(req.url);if(reply===null)return;res.end(reply);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const peer={id:'pc',address:'127.0.0.1',port:server.address().port};
  try{
    assert.equal((await probeComputer(peer)).ok,true);
    reply='ok';assert.equal((await probeComputer(peer)).ok,false);
    reply=null;assert.match((await probeComputer(peer,{timeout:30})).detail,/超时/);
    assert.deepEqual(paths,['/serverinfo','/serverinfo','/serverinfo']);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
function fixture(hosts=[]){
  let selected,opens=0,pairs=0,resolvePair;let phase='idle';
  const paired={store:{hosts:()=>hosts},enable(id){hosts.find(h=>h.id===id).enabled=true;},select(id){selected=id;},
    startPair(){pairs++;this.pairing={state:'waiting'};this.pairTask=new Promise(resolve=>{resolvePair=()=>{this.pairing={state:'paired'};resolve();};});},cancelPair(){resolvePair?.();}};
  const viewer={snapshot:()=>({available:true,phase}),async open(){opens++;phase='starting';},stop(){phase='idle';}};
  const direct=new DirectConnection(paired,viewer);
  return {direct,paired,viewer,get selected(){return selected;},get opens(){return opens;},get pairs(){return pairs;},pairedNow(){resolvePair();}};
}
test('saved computer starts control directly and refuses a concurrent connection before changing selection',async()=>{
  const f=fixture([{id:'saved',address:'pc.local',port:48789,enabled:false}]);
  f.direct.start({id:'card',address:'pc.local'});await f.direct.task;
  assert.equal(f.opens,1);assert.equal(f.selected,'saved');assert.equal(f.pairs,0);
  assert.equal(f.direct.status().peerId,'card');assert.equal(f.direct.status().phase,'starting');
  assert.throws(()=>f.direct.start({id:'other',address:'other.local'}),/已有远控/);
  assert.equal(f.selected,'saved');
});
test('first connection waits for automatic pairing then opens control; cancellation never starts a late viewer',async()=>{
  const f=fixture();f.direct.start({id:'new',address:'pc.local'});
  assert.equal(f.direct.status().phase,'connecting');assert.equal(f.opens,0);
  f.pairedNow();await f.direct.task;assert.equal(f.opens,1);
  f.direct.stop();f.direct.start({id:'other',address:'other.local'});f.direct.stop();await f.direct.task;
  assert.equal(f.opens,1);assert.equal(f.direct.status().phase,'idle');
});
test('failed pairing reports its reason without opening a viewer',async()=>{
  const f=fixture();f.paired.startPair=function(){this.pairing={state:'error',message:'电脑未响应'};this.pairTask=Promise.resolve();};
  f.direct.start({id:'pc',address:'pc.local'});await f.direct.task;
  assert.equal(f.opens,0);assert.equal(f.direct.status().error,'电脑未响应');
});
test('a discovered computer connects without an address or code; cancellation prevents a late viewer',async()=>{
  const f=fixture();let finish,requested,cancelled=0;
  const network={connectDiscovered(id){requested=id;this.pairing={state:'connecting'};this.pairTask=new Promise(r=>{finish=()=>{this.pairing={state:'paired'};r();};});},cancelPair(){cancelled++;finish();}};
  f.direct.network=network;
  f.direct.start({id:'card',directoryId:'a'.repeat(24),name:'Friend'});
  assert.equal(requested,'a'.repeat(24));assert.equal(f.pairs,0);assert.equal(f.opens,0);
  finish();await f.direct.task;assert.equal(f.opens,1);
  f.direct.stop();f.direct.start({id:'other',directoryId:'b'.repeat(24)});f.direct.stop();await f.direct.task;
  assert.equal(f.opens,1);assert.equal(cancelled,2);
});
