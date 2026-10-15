'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),https=require('node:https');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const {BitrateController}=require('../electron/mac/bitrate-controller.cjs');
const protocol=require('../electron/mac/bitrate-protocol.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<300;i++){if(check())return;await delay(10);}throw Error('test deadline');}
function states(){return {
  d:{protocol:1,supported:true,instance:'12345678-1234-1234-1234-123456789012',phase:'active',generation:2,capture:{id:'display'},streams:[{id:3,generation:2,firstFrame:10,width:1280,height:720}]},
  b:{protocol:1,supported:true,instance:'12345678-1234-1234-1234-123456789012',accepted:false,streams:[{id:3,revision:1,supported:true,budgetKbps:12000,videoKbps:10000,requestId:0,requestedKbps:0,targetVideoKbps:0,appliedFrame:0,result:'',error:''}]}};}
async function fixture(t,{post,confirmMs=1500,wrongPin=false,request}={}){
  const s=states(),writes=[],reads=[];let blocked=false;
  const server=https.createServer({key:identities.host.key,cert:identities.host.cert,requestCert:true,rejectUnauthorized:false},async(req,res)=>{
    assert.ok(req.socket.getPeerCertificate().raw);reads.push(req.url);
    if(blocked){res.writeHead(403);res.end();return;}
    if(req.method==='POST'){
      let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);writes.push(data);
      if(post){await post({s,req,res,data});return;}
      s.b.accepted=true;Object.assign(s.b.streams[0],{revision:2,requestId:1,requestedKbps:data.budgetKbps,targetVideoKbps:Math.floor(data.budgetKbps*.8),result:'pending'});
    }
    res.end(JSON.stringify(req.url==='/v1/displays'?s.d:s.b));
  });
  const port=await listen(server),host={id:'a',clientId:'b',certificate:wrongPin?identities.wrong.cert:identities.host.cert,address:'127.0.0.1',port:port-2,enabled:true};
  const store={data:{legacySelected:false},host,selected(){return this.host;},async identity(){return identities.client;}};
  const session={host:{...host},telemetry:true};
  const viewer={session,progress:{received:100,rendered:100,width:1280,height:720,receivedAgeMs:0,renderedAgeMs:0},accepted:[],
    currentSession(){return this.session;},snapshot(){return {progress:this.progress};},acceptBitrate(r,budget){if(r!==this.session)return false;this.accepted.push(budget);return true;},reconcile(code){this.stopped=code;this.session=null;}};
  const controller=new BitrateController({store,viewer,pollMs:20,pendingPollMs:10,confirmMs,...(request?{request}: {})});
  t.after(async()=>{controller.close();await close(server);});controller.reconcile();
  return {s,writes,reads,host,store,viewer,session,controller,block(){blocked=true;},
    apply(budget=6000){return controller.apply({viewId:controller.snapshot().viewId,budgetKbps:budget});},
    encoded(frame=150){Object.assign(s.b.streams[0],{budgetKbps:s.b.streams[0].requestedKbps,videoKbps:s.b.streams[0].targetVideoKbps,appliedFrame:frame,result:'applied'});}};
}
test('real mutual TLS control waits for encoded AND presented frames without restarting the session',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canApply);const first=f.controller.snapshot();f.apply();await until(()=>f.writes.length===1);
  assert.deepEqual(f.writes[0],{instance:f.s.b.instance,stream:3,revision:1,budgetKbps:6000});assert.throws(()=>f.apply(),{code:'BITRATE_BUSY'});
  f.encoded();await until(()=>f.controller.record.latest.b.stream.result==='applied');assert.equal(f.controller.snapshot().phase,'pending');assert.deepEqual(f.viewer.accepted,[]);
  f.viewer.progress.rendered=150;f.viewer.progress.received=150;assert.equal(f.controller.snapshot().result.kind,'applied');assert.deepEqual(f.viewer.accepted,[6000]);
  assert.equal(f.viewer.currentSession(),f.session);assert.equal(f.controller.snapshot().viewId,first.viewId);assert.ok(!JSON.stringify(f.controller.snapshot()).includes('CERTIFICATE'));
});
test('lost POST response is observed without an automatic resend or premature success',async t=>{
  const f=await fixture(t,{post:({s,res,data})=>{Object.assign(s.b.streams[0],{revision:2,requestId:1,requestedKbps:data.budgetKbps,budgetKbps:data.budgetKbps,videoKbps:4800,targetVideoKbps:4800,appliedFrame:150,result:'applied'});res.destroy();}});
  await until(()=>f.controller.snapshot().canApply);f.apply();await until(()=>f.controller.record.pending?.postDone&&f.controller.record.latest.b.stream.result==='applied');
  assert.equal(f.controller.snapshot().phase,'pending');f.viewer.progress.rendered=f.viewer.progress.received=151;
  await until(()=>f.controller.snapshot().result?.kind==='applied');await delay(50);assert.equal(f.writes.length,1);
});
test('host and route changes invalidate a stale panel and never retain its pending setting',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canApply);const stale=f.controller.snapshot().viewId;f.apply();await until(()=>f.writes.length===1);
  f.store.host={...f.host,routeId:'new'};f.viewer.session={host:{...f.store.host},telemetry:true};f.controller.reconcile();
  assert.throws(()=>f.controller.apply({viewId:stale,budgetKbps:2000}),{code:'BITRATE_STALE'});f.encoded();f.viewer.progress.rendered=200;
  await until(()=>f.controller.record.latest);assert.deepEqual(f.viewer.accepted,[]);assert.equal(f.writes.length,1);
});
test('revocation and wrong certificate terminate control without HTTP leakage',async t=>{
  const f=await fixture(t,{wrongPin:true});await until(()=>f.viewer.stopped);assert.equal(f.viewer.stopped,'HOST_CERT_CHANGED');assert.equal(f.reads.length,0);
  const live=await fixture(t);await until(()=>live.controller.snapshot().canApply);live.block();await until(()=>live.viewer.stopped);assert.equal(live.viewer.stopped,'UNPAIRED');assert.equal(live.controller.snapshot().phase,'idle');
});
test('multiple streams, unsupported encoders and frozen video cannot be adjusted',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canApply);
  f.viewer.progress.renderedAgeMs=3000;assert.equal(f.controller.snapshot().canApply,false);assert.throws(()=>f.apply(),{code:'BITRATE_NOT_READY'});f.viewer.progress.renderedAgeMs=0;
  f.s.b.streams[0].supported=false;await until(()=>f.controller.snapshot().error==='BITRATE_ENCODER_UNSUPPORTED');assert.throws(()=>f.apply(),{code:'BITRATE_ENCODER_UNSUPPORTED'});
  f.s.b.streams.push({...f.s.b.streams[0],id:4});await until(()=>f.controller.snapshot().error==='BITRATE_NO_EXCLUSIVE_STREAM');assert.equal(f.controller.snapshot().canApply,false);assert.equal(f.writes.length,0);
});
test('timeout remains unconfirmed and explicit rejection does not become success',async t=>{
  const f=await fixture(t,{confirmMs:100});await until(()=>f.controller.snapshot().canApply);f.apply();await until(()=>f.controller.snapshot().result?.kind==='unconfirmed');assert.equal(f.writes.length,1);assert.deepEqual(f.viewer.accepted,[]);
  const reject=await fixture(t,{post:({s,res})=>{res.writeHead(409);res.end(JSON.stringify(s.b));}});await until(()=>reject.controller.snapshot().canApply);reject.apply();await until(()=>reject.controller.snapshot().result?.kind==='rejected');assert.deepEqual(reject.viewer.accepted,[]);
});
test('unsafe integers, duplicate streams and contradictory applied state are rejected',()=>{
  for(const change of [{id:Number.MAX_SAFE_INTEGER+1},{revision:0},{videoKbps:0},{appliedFrame:-1},{result:'applied',requestId:1,appliedFrame:99,requestedKbps:6000,budgetKbps:6000,targetVideoKbps:1}]){
    const s=states();Object.assign(s.b.streams[0],change);assert.throws(()=>protocol.bitrate(s.b),{code:'BITRATE_INVALID_RESPONSE'});
  }
  const s=states();s.b.streams.push({...s.b.streams[0]});assert.throws(()=>protocol.bitrate(s.b));
  s.d.streams[0].firstFrame='10';assert.throws(()=>protocol.display(s.d));
});
test('renderer cannot choose a host/stream/revision and delayed identity unlock is cancelled',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canApply);const viewId=f.controller.snapshot().viewId;
  for(const data of [{viewId,budgetKbps:999},{viewId,budgetKbps:100001},{viewId,budgetKbps:6000,stream:4}])assert.throws(()=>f.controller.apply(data),{code:'BITRATE_INVALID_VALUE'});
  let unlock;f.controller.record.identity=null;f.store.identity=()=>new Promise(resolve=>unlock=resolve);f.apply();await until(()=>unlock);f.viewer.session=null;f.controller.reconcile();unlock(identities.client);await delay(40);assert.equal(f.writes.length,0);
});
