'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),https=require('node:https');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const {SessionLockController}=require('../electron/mac/session-lock-controller.cjs');
const protocol=require('../electron/mac/session-lock-protocol.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<300;i++){if(check())return;await delay(10);}throw Error('test deadline');}
const instance='12345678-1234-1234-1234-123456789012';
const off=()=>({ok:true,supported:true,cancelProtected:true,state:'off',expiresMs:0});
async function fixture(t,{handler,wrongPin=false,request}={}){
  const display={protocol:1,supported:true,instance,phase:'active',generation:2,capture:{id:'display'},streams:[{id:3,generation:2,firstFrame:10,width:1280,height:720}]};
  const calls=[],s={state:off(),blocked:false};
  const server=https.createServer({key:identities.host.key,cert:identities.host.cert,requestCert:true,rejectUnauthorized:false},async(req,res)=>{
    assert.ok(req.socket.getPeerCertificate().raw);
    if(s.blocked){res.writeHead(403);res.end();return;}
    if(req.url==='/v1/displays'){calls.push({op:'displays'});res.end(JSON.stringify(display));return;}
    assert.equal(req.url,'/v1/session-lock');assert.equal(req.method,'POST');assert.equal(req.headers['content-type'],'application/json');
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls.push(body);
    assert.ok(['status','arm','disarm'].includes(body.op));
    if(handler&&await handler({body,res,s,display}))return;
    if(body.op==='arm')s.state={...off(),state:'armed',lease:body.lease,instance:body.instance,stream:body.stream,expiresMs:15000};
    if(body.op==='disarm')s.state=off();
    res.end(JSON.stringify(s.state));
  });
  const port=await listen(server),host={id:'a',clientId:'b',certificate:wrongPin?identities.wrong.cert:identities.host.cert,address:'127.0.0.1',port:port-2,enabled:true};
  const store={host,selected(){return this.host;},async identity(){return identities.client;}};
  const viewer={session:{host:{...host},telemetry:true},progress:{received:100,rendered:100,width:1280,height:720,receivedAgeMs:0,renderedAgeMs:0},currentSession(){return this.session;},snapshot(){return {progress:this.progress};},reconcile(code){this.stopped=code;this.session=null;}};
  const controller=new SessionLockController({store,viewer,pollMs:20,...(request?{request}:{})});
  t.after(async()=>{await controller.close();await close(server);});controller.reconcile();
  return {s,display,calls,store,viewer,controller,host,set(enabled){return controller.setEnabled({viewId:controller.snapshot().viewId,enabled});}};
}

test('explicit arm and disarm use one private main-process binding over pinned mutual TLS',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canArm);assert.equal(f.calls.filter(c=>c.op==='arm').length,0);
  f.set(true);await until(()=>f.controller.snapshot().armed);const lease=f.s.state.lease;
  assert.ok(!JSON.stringify(f.controller.snapshot()).includes(lease));await delay(70);
  f.set(false);await until(()=>f.controller.snapshot().canArm);
  assert.equal(f.s.state.state,'off');const writes=f.calls.filter(c=>['arm','disarm'].includes(c.op));assert.equal(writes.length,2);
  for(const body of writes){assert.deepEqual(Object.keys(body),['op','instance','stream','lease']);assert.equal(body.instance,instance);assert.equal(body.stream,3);assert.equal(body.lease,lease);}
});

test('confirmed arrangement survives viewer end and app close; final lock is historical and never repeated',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canArm);f.set(true);await until(()=>f.controller.snapshot().armed);
  f.viewer.session=null;f.controller.reconcile();assert.equal(f.controller.snapshot().sessionRunning,false);assert.equal(f.controller.snapshot().canArm,false);
  f.s.state={...f.s.state,state:'requested',expiresMs:5000};await until(()=>f.controller.snapshot().phase==='requested');assert.equal(f.controller.snapshot().canDisarm,false);
  f.s.state={...f.s.state,state:'locked',expiresMs:0};await until(()=>f.controller.snapshot().phase==='locked');await f.controller.close();
  assert.equal(f.calls.filter(c=>c.op==='disarm').length,0);assert.equal(f.calls.filter(c=>c.op==='arm').length,1);
});

test('reopened controller adopts only the exact current stream arrangement and can explicitly cancel it',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canArm);f.set(true);await until(()=>f.controller.snapshot().armed);const original=f.s.state.lease;
  await f.controller.close();const controller=new SessionLockController({store:f.store,viewer:f.viewer,pollMs:20});t.after(()=>controller.close());controller.reconcile();
  await until(()=>controller.snapshot().armed);controller.setEnabled({viewId:controller.snapshot().viewId,enabled:false});await until(()=>controller.snapshot().canArm);
  assert.equal(f.calls.find(c=>c.op==='disarm').lease,original);assert.equal(f.calls.filter(c=>c.op==='arm').length,1);
});

test('queued arm cannot retarget a replaced stream or a viewer that already ended',async t=>{
  let changed=false;const f=await fixture(t,{request:async(...args)=>{if(args[2]==='displays'&&changed)f.display.streams[0].id=4;return protocol.request(...args);}});
  await until(()=>f.controller.snapshot().canArm);const old=f.controller.snapshot().viewId;changed=true;f.set(true);
  await until(()=>f.controller.record.armWanted===false);assert.equal(f.calls.filter(c=>c.op==='arm').length,0);
  await until(()=>f.controller.snapshot().canArm);assert.throws(()=>f.controller.setEnabled({viewId:old,enabled:true}),{code:'LOCK_STALE'});
  f.set(true);f.viewer.session=null;await until(()=>f.controller.record.armWanted===false);assert.equal(f.calls.filter(c=>c.op==='arm').length,0);
});

test('lost arm acknowledgment is cancelled with the original binding without retrying arm',async t=>{
  const f=await fixture(t,{handler:({body,res,s})=>{if(body.op==='arm'){s.state={...off(),state:'armed',...body,expiresMs:15000};res.destroy();return true;}}});
  await until(()=>f.controller.snapshot().canArm);f.set(true);await until(()=>f.calls.some(c=>c.op==='disarm'));await until(()=>f.controller.snapshot().canArm);
  assert.equal(f.calls.find(c=>c.op==='disarm').lease,f.calls.find(c=>c.op==='arm').lease);assert.equal(f.calls.filter(c=>c.op==='arm').length,1);assert.equal(f.s.state.state,'off');
});

test('cancellation stays pending until host confirmation; already-requested is never shown as off',async t=>{
  let mode='normal';const f=await fixture(t,{handler:({body,res})=>{if(body.op==='disarm'&&mode!=='normal'){res.writeHead(mode==='pending'?503:409);res.end(JSON.stringify({ok:false,code:mode==='pending'?'LOCK_CANCEL_PENDING':'LOCK_ALREADY_REQUESTED'}));return true;}}});
  await until(()=>f.controller.snapshot().canArm);f.set(true);await until(()=>f.controller.snapshot().armed);mode='pending';f.set(false);
  await until(()=>f.controller.snapshot().error==='LOCK_CANCEL_PENDING');assert.equal(f.controller.snapshot().phase,'cancelling');assert.equal(f.controller.snapshot().canArm,false);
  mode='requested';f.s.state={...f.s.state,state:'requested',expiresMs:5000};await until(()=>f.controller.snapshot().phase==='requested');assert.equal(f.controller.snapshot().canDisarm,false);
  f.s.state={...f.s.state,state:'locked',expiresMs:0};await until(()=>f.controller.snapshot().canArm);assert.equal(f.controller.snapshot().phase,'locked');
  mode='normal';f.set(true);await until(()=>f.controller.snapshot().armed);assert.equal(f.calls.filter(c=>c.op==='arm').length,2);
});

test('cancel during an in-flight arm waits for exact disarm and cannot display a late armed reply',async t=>{
  let release;const f=await fixture(t,{handler:async({body})=>{if(body.op==='arm')await new Promise(resolve=>release=resolve);}});
  await until(()=>f.controller.snapshot().canArm);f.set(true);await until(()=>release);f.set(false);assert.equal(f.controller.snapshot().phase,'cancelling');release();
  await until(()=>f.controller.snapshot().canArm);assert.equal(f.calls.filter(c=>c.op==='arm').length,1);assert.equal(f.s.state.state,'off');
});

test('status loss does not cancel an accepted arrangement or falsely claim it is still confirmed',async t=>{
  let lost=false;const f=await fixture(t,{handler:({body,res})=>{if(body.op==='status'&&lost){res.destroy();return true;}}});
  await until(()=>f.controller.snapshot().canArm);f.set(true);await until(()=>f.controller.snapshot().armed);lost=true;
  await until(()=>f.controller.snapshot().phase==='unconfirmed');assert.equal(f.controller.snapshot().armed,false);assert.equal(f.controller.snapshot().canDisarm,true);
  await f.controller.close();assert.equal(f.calls.filter(c=>c.op==='disarm').length,0);
});

test('route and native session replacement neither transfers nor cancels a confirmed old intent',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canArm);f.set(true);await until(()=>f.controller.snapshot().armed);const lease=f.s.state.lease;
  f.store.host={...f.host,routeId:'new'};f.viewer.session={host:{...f.store.host},telemetry:true};f.display.streams[0].id=4;f.controller.reconcile();
  await until(()=>f.controller.snapshot().error==='LOCK_BUSY');assert.equal(f.controller.snapshot().canDisarm,false);assert.equal(f.s.state.lease,lease);assert.equal(f.calls.filter(c=>c.op==='disarm').length,0);
  f.s.state=off();await until(()=>f.controller.snapshot().canArm);assert.equal(f.calls.filter(c=>c.op==='arm').length,1);
});

test('unknown arm cleanup uses the old route and token after replacement',async t=>{
  let release;const observed=[];const f=await fixture(t,{request:async(...args)=>{observed.push({route:args[0].routeId||'old',op:args[2],binding:args[3]});if(args[2]==='arm')await new Promise(resolve=>release=resolve);return protocol.request(...args);}});
  await until(()=>f.controller.snapshot().canArm);f.set(true);await until(()=>release);
  f.store.host={...f.host,routeId:'new'};f.viewer.session={host:{...f.store.host},telemetry:true};f.controller.reconcile();release();
  await until(()=>observed.some(c=>c.op==='disarm'));await Promise.allSettled([...f.controller.cleanups]);
  const arm=observed.find(c=>c.op==='arm'),cancel=observed.find(c=>c.op==='disarm');assert.equal(cancel.route,'old');assert.deepEqual(cancel.binding,arm.binding);
});

test('legacy hosts and stale presentation cannot arm, and renderer cannot choose host or stream',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canArm);const viewId=f.controller.snapshot().viewId;
  for(const extra of [{stream:99},{lease:'a'.repeat(32)},{instance},{host:'other'}])assert.throws(()=>f.controller.setEnabled({viewId,enabled:true,...extra}),{code:'LOCK_BAD_REQUEST'});
  f.viewer.progress.renderedAgeMs=3000;assert.equal(f.controller.snapshot().canArm,false);assert.throws(()=>f.set(true));f.viewer.progress.renderedAgeMs=0;
  delete f.s.state.cancelProtected;await until(()=>f.controller.snapshot().error==='LOCK_UPDATE_REQUIRED');assert.throws(()=>f.set(true));assert.equal(f.calls.filter(c=>c.op==='arm').length,0);
});

test('strict protocol rejects null identities, contradictory state, unsafe operations and certificate changes',async t=>{
  for(const value of [{...off(),lease:null},{...off(),instance:null},{...off(),stream:null},{...off(),state:'armed'},{...off(),expiresMs:1},{...off(),cancelProtected:'true'}])assert.throws(()=>protocol.state(value),{code:'LOCK_INVALID_RESPONSE'});
  for(const op of ['commit','renew'])assert.throws(()=>protocol.body(op,{instance,stream:3,lease:'a'.repeat(32)}),{code:'LOCK_BAD_REQUEST'});
  const wrong=await fixture(t,{wrongPin:true});await until(()=>wrong.viewer.stopped);assert.equal(wrong.viewer.stopped,'HOST_CERT_CHANGED');assert.equal(wrong.calls.length,0);
  const live=await fixture(t);await until(()=>live.controller.snapshot().canArm);live.s.blocked=true;await until(()=>live.viewer.stopped);assert.equal(live.viewer.stopped,'UNPAIRED');
});
