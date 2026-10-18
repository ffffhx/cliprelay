'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),https=require('node:https');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const {InputSession}=require('../electron/mac/input-session.cjs');
const instance='12345678-1234-1234-1234-123456789012';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<250;i++){if(check())return;await delay(5);}throw Error('input session test deadline');}
async function fixture(t,options={}){
  const input={protocol:1,supported:true,instance,streams:[{id:3,epoch:0,acknowledged:0,enabled:false,paused:false,pending:false,closed:false,failed:false,exclusive:true}]};
  const display={protocol:1,supported:true,instance,phase:'active',generation:2,capture:{id:'left'},streams:[{id:3,generation:2,firstFrame:10,width:1280,height:720}]};
  const progress={received:20,rendered:20,width:1280,height:720,receivedAgeMs:0,renderedAgeMs:0};
  const writes=[],failures=[],reads=[];let live=true,local=true,hostAck=true,status=200,afterWrite=()=>{},hang=false;
  const server=https.createServer({key:identities.host.key,cert:identities.host.cert,requestCert:true,rejectUnauthorized:false},(req,res)=>{
    assert.ok(req.socket.getPeerCertificate().raw);reads.push(req.url);
    if(hang)return;if(status!==200){res.writeHead(status);res.end();return;}
    res.end(JSON.stringify(req.url==='/v1/input-state'?input:display));
  });
  const port=await listen(server);
  const session=new InputSession({host:{address:'127.0.0.1',port:port-2,certificate:options.wrongPin?identities.wrong.cert:identities.host.cert},identity:identities.client,
    instance,current:()=>live,progress:()=>progress,onFailure:code=>failures.push(code),pollMs:5,timeoutMs:options.timeoutMs||3000,
    write:(frame,callback)=>{
      assert.equal(frame.length,16);assert.equal(frame.subarray(0,4).toString(),'CRIC');
      const epoch=frame.readUInt32BE(8),op=frame[5];writes.push([epoch,op]);
      if(op!==3)Object.assign(input.streams[0],{enabled:true,epoch,paused:op===1,pending:!hostAck,acknowledged:hostAck?epoch:epoch-1});
      afterWrite(epoch,op);callback();
      if(local)queueMicrotask(()=>session.receive({version:1,event:'input',epoch,stage:op===3?'acknowledged':'submitted'}));
    }});
  t.after(async()=>{session.close();await close(server);});
  return {session,input,display,progress,writes,failures,reads,
    setLocal(value){local=value;},setHostAck(value){hostAck=value;},setStatus(value){status=value;},setLive(value){live=value;},setHang(value){hang=value;},
    setAfterWrite(fn){afterWrite=fn;},proof(afterFrame=20){return {generation:display.generation,capture:display.capture.id,firstFrame:display.streams[0].firstFrame,afterFrame,width:1280,height:720};}};
}
test('initial admission waits for paused local/host ACK and the actually presented frame',async t=>{
  const f=await fixture(t);f.progress.rendered=0;
  const started=f.session.initialize();await until(()=>f.writes.length===2);
  assert.deepEqual(f.writes,[[1,1],[1,3]]);assert.equal(f.session.phase,'paused');
  f.progress.rendered=20;await started;
  assert.deepEqual(f.writes,[[1,1],[1,3],[2,2],[2,3]]);assert.deepEqual(f.session.snapshot(),{phase:'active',epoch:2,error:''});
  assert.equal(f.failures.length,0);assert.ok(!JSON.stringify(f.session.snapshot()).includes('PRIVATE'));
});
test('pause waits for host release; resume waits for capture generation and presentation',async t=>{
  const f=await fixture(t);await f.session.initialize();f.setHostAck(false);
  const paused=f.session.pause();await until(()=>f.input.streams[0].epoch===3&&!f.session.waiter);
  assert.deepEqual(f.writes.at(-1),[3,1]);assert.equal(f.session.phase,'pausing');
  Object.assign(f.input.streams[0],{acknowledged:3,pending:false});await paused;f.setHostAck(true);
  f.display.generation=f.display.streams[0].generation=3;f.display.capture.id='right';f.display.streams[0].firstFrame=25;
  const resumed=f.session.resume(f.proof());await delay(25);assert.deepEqual(f.writes.at(-1),[3,3]);
  f.progress.received=f.progress.rendered=25;await resumed;
  assert.deepEqual(f.writes.slice(-2),[[4,2],[4,3]]);assert.equal(f.session.epoch,4);
});
test('a capture change after host resume never receives the local opening acknowledgment',async t=>{
  const f=await fixture(t);await f.session.initialize();await f.session.pause();
  f.setAfterWrite((epoch,op)=>{if(epoch===4&&op===2){f.display.generation=f.display.streams[0].generation=3;}});
  await assert.rejects(f.session.resume(f.proof(0)),{code:'INPUT_DISPLAY_CHANGED'});
  assert.deepEqual(f.writes.at(-1),[4,2]);assert.deepEqual(f.failures,['INPUT_DISPLAY_CHANGED']);
});
test('out-of-order and unsolicited local events close the input owner instead of advancing',async t=>{
  const f=await fixture(t);f.setLocal(false);
  const started=f.session.initialize();await until(()=>f.writes.length===1);
  f.session.receive({version:1,event:'input',epoch:2,stage:'submitted'});
  await assert.rejects(started,{code:'INPUT_INVALID_EVENT'});assert.deepEqual(f.writes,[[1,1]]);
  const duplicate=await fixture(t);await duplicate.session.initialize();
  duplicate.session.receive({version:1,event:'input',epoch:2,stage:'acknowledged'});
  assert.deepEqual(duplicate.failures,['INPUT_INVALID_EVENT']);
});
test('local or host acknowledgment timeout ends the owner without resending commands',async t=>{
  for(const which of ['local','host'])await t.test(which,async t=>{
    const f=await fixture(t,{timeoutMs:250});if(which==='local')f.setLocal(false);else f.setHostAck(false);
    await assert.rejects(f.session.initialize(),{code:'INPUT_TIMEOUT'});
    assert.deepEqual(f.writes,[[1,1]]);assert.deepEqual(f.failures,['INPUT_TIMEOUT']);
  });
});
test('wrong pin, revoked pairing, competing streams and engine replacement terminate admission',async t=>{
  const wrong=await fixture(t,{wrongPin:true});await assert.rejects(wrong.session.initialize(),{code:'HOST_CERT_CHANGED'});assert.equal(wrong.reads.length,0);
  for(const change of ['revoked','competing','engine'])await t.test(change,async t=>{
    const f=await fixture(t);await f.session.initialize();
    if(change==='revoked')f.setStatus(403);else if(change==='competing')f.input.streams[0].exclusive=false;else f.input.instance='aaaaaaaa-1234-1234-1234-123456789012';
    await assert.rejects(f.session.pause(),{code:change==='revoked'?'UNPAIRED':change==='competing'?'INPUT_NOT_EXCLUSIVE':'INPUT_CHANGED'});
    assert.deepEqual(f.writes.at(-1),[3,1]);assert.equal(f.failures.length,1);
  });
});
test('owner cancellation aborts pending host reads and cannot issue a delayed command',async t=>{
  const f=await fixture(t);f.setHang(true);
  const started=f.session.initialize();await until(()=>f.reads.length>0);f.setLive(false);f.session.close();
  await assert.rejects(started,{code:'CANCELLED'});assert.deepEqual(f.writes,[]);assert.equal(f.failures.length,0);
});
test('only one transition can be active and presentation proof is required to resume',async t=>{
  const f=await fixture(t);await f.session.initialize();f.setHostAck(false);
  const paused=f.session.pause();await assert.rejects(f.session.pause(),{code:'INPUT_BUSY'});
  Object.assign(f.input.streams[0],{epoch:3,acknowledged:3,paused:true,pending:false,enabled:true});await paused;
  await assert.rejects(f.session.resume(),{code:'INPUT_BUSY'});assert.deepEqual(f.writes.at(-1),[3,3]);
});
