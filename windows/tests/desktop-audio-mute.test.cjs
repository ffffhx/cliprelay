'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),https=require('node:https');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const {AudioMuteController}=require('../electron/mac/audio-mute-controller.cjs');
const protocol=require('../electron/mac/audio-mute-protocol.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<300;i++){if(check())return;await delay(10);}throw Error('test deadline');}
const instance='12345678-1234-1234-1234-123456789012';
const off=()=>({ok:true,supported:true,active:false,expiresMs:0,recovering:false,outputs:2});
async function fixture(t,{handler,wrongPin=false,request,now,renewMs=100,pollMs=20}={}){
  const display={protocol:1,supported:true,instance,phase:'active',generation:2,capture:{id:'display'},streams:[{id:3,generation:2,firstFrame:10,width:1280,height:720,audio:{capture:'process',generation:7,ready:true}}]};
  const calls=[],s={active:'',recovering:false,blocked:false};
  const server=https.createServer({key:identities.host.key,cert:identities.host.cert,requestCert:true,rejectUnauthorized:false},async(req,res)=>{
    assert.ok(req.socket.getPeerCertificate().raw);
    if(s.blocked){res.writeHead(403);res.end();return;}
    if(req.url==='/v1/displays'){calls.push({op:'displays'});res.end(JSON.stringify(display));return;}
    assert.equal(req.url,'/v1/audio-mute');assert.equal(req.method,'POST');assert.equal(req.headers['content-type'],'application/json');
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls.push(body);
    if(handler&&await handler({body,res,s,display}))return;
    if(body.op==='start'||body.op==='renew')s.active=body.lease;
    if(body.op==='stop'&&!s.recovering)s.active='';
    const state=s.recovering?{...off(),supported:false,recovering:true}:s.active?{...off(),active:true,lease:s.active,expiresMs:15000}:off();
    res.end(JSON.stringify(state));
  });
  const port=await listen(server),host={id:'a',clientId:'b',certificate:wrongPin?identities.wrong.cert:identities.host.cert,address:'127.0.0.1',port:port-2,enabled:true};
  const store={host,selected(){return this.host;},async identity(){return identities.client;}};
  const viewer={session:{host:{...host},telemetry:true},progress:{received:100,rendered:100,width:1280,height:720,receivedAgeMs:0,renderedAgeMs:0},currentSession(){return this.session;},snapshot(){return {progress:this.progress};},reconcile(code){this.stopped=code;this.session=null;}};
  const controller=new AudioMuteController({store,viewer,pollMs,renewMs,...(request?{request}: {}),...(now?{now}: {})});
  t.after(async()=>{s.recovering=false;await controller.close();await close(server);});controller.reconcile();
  return {s,display,calls,store,viewer,controller,host,set(enabled){return controller.setEnabled({viewId:controller.snapshot().viewId,enabled});}};
}

test('real pinned mutual TLS mute binds start/renew/stop to the main-process audio generation and one lease',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canEnable);assert.equal(f.calls.filter(c=>c.op==='start').length,0);
  f.set(true);await until(()=>f.controller.snapshot().active);await until(()=>f.calls.filter(c=>c.op==='renew').length>=2);
  const lease=f.s.active;assert.ok(!JSON.stringify(f.controller.snapshot()).includes(lease));
  f.set(false);await until(()=>f.controller.snapshot().canEnable);assert.equal(f.s.active,'');
  const writes=f.calls.filter(c=>['start','renew','stop'].includes(c.op));
  for(const body of writes){assert.deepEqual(Object.keys(body),['op','instance','stream','lease','audioGeneration']);assert.equal(body.instance,instance);assert.equal(body.stream,3);assert.equal(body.lease,lease);assert.equal(body.audioGeneration,7);}
  assert.equal(writes.filter(c=>c.op==='start').length,1);
});

test('missing, endpoint, not-ready and shared audio cannot be muted even if a host claims capability',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canEnable);
  for(const audio of [undefined,{capture:'endpoint',generation:7,ready:false},{capture:'process',generation:7,ready:false},{capture:'',generation:0,ready:false}]){
    f.display.streams[0].audio=audio;
    await until(()=>!f.controller.snapshot().canEnable);assert.throws(()=>f.set(true));
    f.display.streams[0].audio={capture:'process',generation:7,ready:true};await until(()=>f.controller.snapshot().canEnable);
  }
  f.display.streams.push({...f.display.streams[0],id:4});await until(()=>!f.controller.snapshot().canEnable);assert.throws(()=>f.set(true));
  assert.equal(f.calls.filter(c=>c.op==='start').length,0);
});

test('capture generation change restores the old lease and a new generation needs another explicit click',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canEnable);f.set(true);await until(()=>f.controller.snapshot().active);
  const viewId=f.controller.snapshot().viewId;f.display.streams[0].audio.generation=8;
  await until(()=>f.controller.snapshot().canEnable);assert.equal(f.s.active,'');assert.equal(f.calls.filter(c=>c.op==='start').length,1);
  assert.throws(()=>f.controller.setEnabled({viewId,enabled:true}),{code:'AUDIO_STALE'});
  assert.ok(f.calls.some(c=>c.op==='stop'&&c.audioGeneration===7));f.set(true);await until(()=>f.controller.snapshot().active);
  assert.equal(f.calls.filter(c=>c.op==='start').at(-1).audioGeneration,8);
});

test('a queued start cannot silently select a replacement audio generation',async t=>{
  let changed=false;const f=await fixture(t,{request:async(...args)=>{if(args[2]==='displays'&&changed)f.display.streams[0].audio.generation=8;return protocol.request(...args);}});
  await until(()=>f.controller.snapshot().canEnable);changed=true;f.set(true);await until(()=>f.controller.record.desired===false);
  await until(()=>f.controller.snapshot().canEnable);assert.equal(f.calls.filter(c=>c.op==='start').length,0);
});

test('HTTP recovery-pending and inactive-but-recovering responses never report restored sound or allow remuting',async t=>{
  let mode='normal';const f=await fixture(t,{handler:({body,res})=>{
    if(body.op==='stop'&&mode==='http'){res.writeHead(503);res.end(JSON.stringify({ok:false,code:'AUDIO_RECOVERY_PENDING'}));return true;}
  }});
  await until(()=>f.controller.snapshot().canEnable);f.set(true);await until(()=>f.controller.snapshot().active);mode='http';f.set(false);
  await until(()=>f.controller.snapshot().error==='AUDIO_RECOVERY_PENDING');assert.equal(f.controller.snapshot().phase,'restoring');assert.equal(f.controller.snapshot().canEnable,false);
  mode='normal';f.s.recovering=true;await until(()=>f.calls.filter(c=>c.op==='stop').length>=3);
  assert.equal(f.controller.snapshot().phase,'restoring');assert.equal(f.controller.snapshot().active,false);assert.notEqual(f.s.active,'');
  f.s.recovering=false;await until(()=>f.controller.snapshot().canEnable);assert.equal(f.s.active,'');assert.equal(f.calls.filter(c=>c.op==='start').length,1);
});

test('unowned host recovery is observed without adopting or stopping its lease',async t=>{
  const f=await fixture(t);f.s.recovering=true;await until(()=>f.controller.snapshot().phase==='restoring');
  assert.equal(f.controller.snapshot().canDisable,false);assert.equal(f.controller.snapshot().canEnable,false);await delay(60);
  assert.equal(f.calls.filter(c=>c.op==='stop'||c.op==='start').length,0);f.s.recovering=false;await until(()=>f.controller.snapshot().canEnable);
});

test('lost start acknowledgment retains the exact audio binding for cleanup without retrying mute',async t=>{
  const f=await fixture(t,{handler:({body,res,s})=>{if(body.op==='start'){s.active=body.lease;res.destroy();return true;}}});
  await until(()=>f.controller.snapshot().canEnable);f.set(true);await until(()=>f.calls.some(c=>c.op==='stop'));await until(()=>f.controller.snapshot().canEnable);
  const start=f.calls.find(c=>c.op==='start'),stop=f.calls.find(c=>c.op==='stop');assert.equal(stop.lease,start.lease);assert.equal(stop.audioGeneration,start.audioGeneration);assert.equal(f.s.active,'');assert.equal(f.calls.filter(c=>c.op==='start').length,1);
});

test('local override and stale video end mute instead of silently reapplying it',async t=>{
  const f=await fixture(t,{renewMs:500});await until(()=>f.controller.snapshot().canEnable);f.set(true);await until(()=>f.controller.snapshot().active);
  f.s.active='';await until(()=>f.controller.snapshot().canEnable);await delay(70);assert.equal(f.calls.filter(c=>c.op==='start').length,1);
  f.set(true);await until(()=>f.controller.snapshot().active);f.viewer.progress.renderedAgeMs=3000;
  assert.equal(f.controller.snapshot().active,false);await until(()=>f.s.active==='');assert.equal(f.controller.snapshot().canEnable,false);
});

test('route replacement cleans up using the old audio generation without adopting a new child',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canEnable);f.set(true);await until(()=>f.controller.snapshot().active);
  const lease=f.s.active;f.store.host={...f.host,routeId:'new'};f.viewer.session={host:{...f.store.host},telemetry:true};f.display.streams[0].audio.generation=8;f.controller.reconcile();
  await until(()=>f.controller.snapshot().canEnable);assert.equal(f.s.active,'');assert.ok(f.calls.some(c=>c.op==='stop'&&c.lease===lease&&c.audioGeneration===7));assert.equal(f.calls.filter(c=>c.op==='start').length,1);
});

test('expired in-flight audio renewal cannot reopen the confirmed state',async t=>{
  let now=1000,release,renewalPending=false;const gate=new Promise(resolve=>release=resolve);t.after(release);
  const f=await fixture(t,{now:()=>now,pollMs:5,renewMs:5,handler:async({body,res})=>{
    if(body.op==='renew'){renewalPending=true;await gate;res.end(JSON.stringify({...off(),active:true,lease:body.lease,expiresMs:15000}));return true;}
  }});
  await until(()=>f.controller.snapshot().canEnable);f.set(true);await until(()=>f.controller.snapshot().active);
  // Advance the monotonic clock only after admission, then hold the real TLS
  // response across expiry. Runner speed cannot expire the initial lease first.
  now+=6;await until(()=>renewalPending);now+=15000;
  assert.equal(f.controller.snapshot().active,false);release();await until(()=>f.controller.snapshot().canEnable);assert.equal(f.s.active,'');
  assert.equal(f.calls.filter(c=>c.op==='start').length,1);assert.equal(f.calls.filter(c=>c.op==='renew').length,1);
});

test('certificate pin and pairing revocation gate audio requests',async t=>{
  const wrong=await fixture(t,{wrongPin:true});await until(()=>wrong.viewer.stopped);assert.equal(wrong.viewer.stopped,'HOST_CERT_CHANGED');assert.equal(wrong.calls.length,0);
  const live=await fixture(t);await until(()=>live.controller.snapshot().canEnable);live.s.blocked=true;await until(()=>live.viewer.stopped);assert.equal(live.viewer.stopped,'UNPAIRED');
});

test('strict audio parsing and renderer ownership reject forged endpoints, generations and contradictory state',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canEnable);const viewId=f.controller.snapshot().viewId;
  for(const extra of [{audioGeneration:8},{stream:99},{lease:'a'.repeat(32)},{endpoints:['speaker']},{host:'other'}])assert.throws(()=>f.controller.setEnabled({viewId,enabled:true,...extra}),{code:'AUDIO_BAD_REQUEST'});
  for(const value of [{...off(),recovering:'false'},{...off(),outputs:33},{...off(),outputs:0},{...off(),recovering:true},{...off(),outputs:2.5},{...off(),active:true,lease:'a'.repeat(32),expiresMs:100,recovering:true}])assert.throws(()=>protocol.state(value),{code:'AUDIO_INVALID_RESPONSE'});
  for(const audio of [null,{capture:'unknown',generation:7,ready:true},{capture:'endpoint',generation:7,ready:true},{capture:'process',generation:0,ready:true},{capture:'process',generation:'7',ready:true}]){
    const d=structuredClone(f.display);d.streams[0].audio=audio;assert.throws(()=>protocol.display(d),{code:'AUDIO_INVALID_RESPONSE'});
  }
  assert.throws(()=>protocol.body('start',{instance,stream:3,lease:'a'.repeat(32),audioGeneration:0}),{code:'AUDIO_BAD_REQUEST'});
});
