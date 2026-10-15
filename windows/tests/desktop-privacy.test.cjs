'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),https=require('node:https');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const {PrivacyController}=require('../electron/mac/privacy-controller.cjs');
const protocol=require('../electron/mac/privacy-protocol.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<300;i++){if(check())return;await delay(10);}throw Error('test deadline');}
const instance='12345678-1234-1234-1234-123456789012';
const off=()=>({ok:true,supported:true,active:false,expiresMs:0});
async function fixture(t,{handler,wrongPin=false,request,renewMs=80,pollMs=20}={}){
  const display={protocol:1,supported:true,instance,phase:'active',generation:2,capture:{id:'display'},streams:[{id:3,generation:2,firstFrame:10,width:1280,height:720}]};
  const calls=[];let active='',blocked=false;
  const server=https.createServer({key:identities.host.key,cert:identities.host.cert,requestCert:true,rejectUnauthorized:false},async(req,res)=>{
    assert.ok(req.socket.getPeerCertificate().raw);
    if(blocked){res.writeHead(403);res.end();return;}
    if(req.url==='/v1/displays'){calls.push({op:'displays'});res.end(JSON.stringify(display));return;}
    assert.equal(req.url,'/v1/privacy');assert.equal(req.method,'POST');assert.equal(req.headers['content-type'],'application/json');
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls.push(body);
    if(body.op==='start'||body.op==='renew')active=body.lease;
    if(body.op==='stop'&&body.lease===active)active='';
    const state=active?{ok:true,supported:true,active:true,expiresMs:15000,lease:active}:off();
    if(handler&&await handler({body,state,res,display}))return;
    res.end(JSON.stringify(state));
  });
  const port=await listen(server),host={id:'a',clientId:'b',certificate:wrongPin?identities.wrong.cert:identities.host.cert,address:'127.0.0.1',port:port-2,enabled:true};
  const store={host,selected(){return this.host;},async identity(){return identities.client;}};
  const session={host:{...host},telemetry:true};
  const viewer={session,progress:{received:100,rendered:100,width:1280,height:720,receivedAgeMs:0,renderedAgeMs:0},currentSession(){return this.session;},snapshot(){return {progress:this.progress};},reconcile(code){this.stopped=code;this.session=null;}};
  const controller=new PrivacyController({store,viewer,pollMs,renewMs,...(request?{request}: {})});
  t.after(async()=>{await controller.close();await close(server);});controller.reconcile();
  return {display,calls,store,viewer,session,controller,host,get active(){return active;},restore(){active='';},block(){blocked=true;},
    set(enabled){return controller.setEnabled({viewId:controller.snapshot().viewId,enabled});}};
}

test('pinned mutual TLS privacy starts only on explicit intent, renews one lease and stops without exposing it to the renderer',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canEnable);assert.equal(f.calls.filter(c=>c.op==='start').length,0);
  f.set(true);await until(()=>f.controller.snapshot().active);await until(()=>f.calls.filter(c=>c.op==='renew').length>=2);
  const writes=f.calls.filter(c=>['start','renew'].includes(c.op));assert.equal(writes.filter(c=>c.op==='start').length,1);
  for(const body of writes){assert.equal(body.instance,instance);assert.equal(body.stream,3);assert.equal(body.lease,writes[0].lease);assert.deepEqual(Object.keys(body),['op','instance','stream','lease']);}
  const snapshot=JSON.stringify(f.controller.snapshot());assert.ok(!snapshot.includes(writes[0].lease)&&!snapshot.includes('CERTIFICATE')&&!snapshot.includes(instance));
  f.set(false);await until(()=>f.controller.snapshot().canEnable);assert.equal(f.active,'');assert.equal(f.viewer.session,f.session);
});

test('lost start reply triggers exact-lease cleanup and never an automatic restart',async t=>{
  const f=await fixture(t,{handler:({body,res})=>{if(body.op==='start'){res.destroy();return true;}}});
  await until(()=>f.controller.snapshot().canEnable);f.set(true);await until(()=>f.calls.some(c=>c.op==='stop'));await until(()=>f.controller.snapshot().canEnable);
  assert.equal(f.active,'');assert.equal(f.calls.filter(c=>c.op==='start').length,1);assert.equal(f.controller.snapshot().active,false);
});

test('a local restore or frozen presented video cancels renewals and requires a new explicit enable',async t=>{
  const f=await fixture(t,{renewMs:500});await until(()=>f.controller.snapshot().canEnable);f.set(true);await until(()=>f.controller.snapshot().active);
  f.restore();await until(()=>f.controller.snapshot().canEnable);await delay(80);assert.equal(f.calls.filter(c=>c.op==='start').length,1);
  f.set(true);await until(()=>f.controller.snapshot().active);f.viewer.progress.renderedAgeMs=3000;
  assert.equal(f.controller.snapshot().active,false);await until(()=>f.active==='');assert.equal(f.controller.snapshot().canEnable,false);
});

test('route recovery cleans up the old pinned lease and never transfers intent to a new native child',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canEnable);f.set(true);await until(()=>f.controller.snapshot().active);
  const viewId=f.controller.snapshot().viewId,lease=f.active;
  f.store.host={...f.host,routeId:'new'};f.viewer.session={host:{...f.store.host},telemetry:true};f.controller.reconcile();
  assert.throws(()=>f.controller.setEnabled({viewId,enabled:true}),{code:'PRIVACY_STALE'});
  await until(()=>f.calls.some(c=>c.op==='stop'&&c.lease===lease));await until(()=>f.controller.snapshot().canEnable);
  assert.equal(f.controller.snapshot().active,false);assert.equal(f.calls.filter(c=>c.op==='start').length,1);
});

test('stop during a delayed start acknowledgment never publishes an active result',async t=>{
  let release;const f=await fixture(t,{handler:async({body})=>{if(body.op==='start')await new Promise(resolve=>release=resolve);}});
  await until(()=>f.controller.snapshot().canEnable);f.set(true);await until(()=>release);assert.equal(f.controller.snapshot().phase,'starting');
  f.set(false);release();await until(()=>f.controller.snapshot().canEnable);assert.equal(f.controller.snapshot().active,false);assert.equal(f.active,'');
});

test('late renew acknowledgments cannot resurrect a lease after the monotonic expiry deadline',async t=>{
  let release;const f=await fixture(t,{pollMs:5,renewMs:5,handler:async({body,state,res})=>{
    if(body.op==='start'){res.end(JSON.stringify({...state,expiresMs:80}));return true;}
    if(body.op==='renew'){await new Promise(resolve=>release=resolve);res.end(JSON.stringify(state));return true;}
  }});
  await until(()=>f.controller.snapshot().canEnable);f.set(true);await until(()=>release);await delay(100);
  assert.equal(f.controller.snapshot().active,false);release();await until(()=>f.controller.snapshot().canEnable);assert.equal(f.active,'');assert.equal(f.calls.filter(c=>c.op==='start').length,1);
});

test('stream replacement before a queued start and delayed key unlock cannot retarget a click',async t=>{
  let changed=false;const f=await fixture(t,{request:async(...args)=>{
    if(args[2]==='displays'&&changed)f.display.streams[0].id=4;
    return protocol.request(...args);
  }});
  await until(()=>f.controller.snapshot().canEnable);changed=true;f.set(true);await until(()=>f.controller.record.desired===false);
  assert.equal(f.calls.filter(c=>c.op==='start').length,0);
  await until(()=>f.controller.snapshot().canEnable);let unlock;f.controller.record.identity=null;f.store.identity=()=>new Promise(resolve=>unlock=resolve);
  f.set(true);await until(()=>unlock);f.viewer.session=null;f.controller.reconcile();unlock(identities.client);await delay(40);
  assert.equal(f.calls.filter(c=>c.op==='start').length,0);
});

test('wrong pin sends no HTTP and revoked pairing closes the viewer',async t=>{
  const wrong=await fixture(t,{wrongPin:true});await until(()=>wrong.viewer.stopped);assert.equal(wrong.viewer.stopped,'HOST_CERT_CHANGED');assert.equal(wrong.calls.length,0);
  const live=await fixture(t);await until(()=>live.controller.snapshot().canEnable);live.block();await until(()=>live.viewer.stopped);assert.equal(live.viewer.stopped,'UNPAIRED');
});

test('renderer cannot supply a host, lease or stream; invalid and contradictory responses are rejected',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canEnable);const viewId=f.controller.snapshot().viewId;
  for(const value of [{viewId,enabled:'true'},{viewId,enabled:true,stream:99},{viewId,enabled:true,lease:'a'.repeat(32)},{viewId,enabled:true,host:'other'}])assert.throws(()=>f.controller.setEnabled(value),{code:'PRIVACY_BAD_REQUEST'});
  const active={ok:true,supported:true,active:true,lease:'a'.repeat(32),expiresMs:15000};
  for(const value of [{...active,ok:1},{...active,supported:false},{...active,lease:'bad'},{...active,expiresMs:0},{...active,expiresMs:15001},{...active,expiresMs:'500'},{...off(),lease:'a'.repeat(32)},{...off(),expiresMs:1},{...off(),lease:0}])assert.throws(()=>protocol.state(value),{code:'PRIVACY_INVALID_RESPONSE'});
  assert.throws(()=>protocol.body('renew',{instance,stream:0,lease:'a'.repeat(32)}));
  assert.equal(f.calls.filter(c=>c.op==='start').length,0);
});
