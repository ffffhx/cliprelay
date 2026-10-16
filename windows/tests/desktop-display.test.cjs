'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),https=require('node:https');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const {DisplayController}=require('../electron/mac/display-controller.cjs');
const {InputSession}=require('../electron/mac/input-session.cjs');
const protocol=require('../electron/mac/display-protocol.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<400;i++){if(check())return;await delay(5);}throw Error('display test deadline');}
function states(){const instance='12345678-1234-1234-1234-123456789012';return {
  d:{protocol:1,supported:true,instance,revision:1,requestId:0,requested:'',result:'',error:'',accepted:false,shared:false,inputEpochSelection:true,requestStream:0,inputEpoch:0,
    displays:['left','right'],phase:'active',generation:2,capture:{id:'left'},streams:[{id:3,generation:2,firstFrame:10,width:1280,height:720}]},
  i:{protocol:1,supported:true,instance,streams:[{id:3,epoch:0,acknowledged:0,enabled:false,paused:false,pending:false,closed:false,failed:false,exclusive:true}]}};}
async function fixture(t,{post,timeoutMs=3000}={}){
  const s=states(),posts=[],commands=[],reads=[];let blocked=false,local=true;
  const server=https.createServer({key:identities.host.key,cert:identities.host.cert,requestCert:true,rejectUnauthorized:false},async(req,res)=>{
    assert.ok(req.socket.getPeerCertificate().raw);reads.push(req.url);
    if(blocked){res.writeHead(403);res.end();return;}
    if(req.method==='POST'){
      let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);posts.push(body);
      if(post){await post({s,body,res});return;}
      Object.assign(s.d,{accepted:true,requestId:s.d.requestId+1,requested:body.display,result:'pending',requestStream:body.stream,inputEpoch:body.inputEpoch});
    }
    res.end(JSON.stringify(req.url==='/v1/input-state'?s.i:s.d));
  });
  const port=await listen(server),host={id:'a',clientId:'b',enabled:true,certificate:identities.host.cert,address:'127.0.0.1',port:port-2};
  const session={host:{...host},telemetry:true},store={selected:()=>host,identity:async()=>identities.client};
  const viewer={session,failures:[],manualPaused:false,progress:{received:20,rendered:20,width:1280,height:720,receivedAgeMs:0,renderedAgeMs:0},currentSession(){return this.session;},snapshot(){return {progress:this.progress};},
    inputPaused(record){return this.session===record&&this.manualPaused;},setInputPaused(record,value){if(this.session!==record)return false;this.manualPaused=value;return true;},
    finish(code){this.failures.push(code);session.input.close(code);this.session=null;},reconcile(code){if(code)this.finish(code);}};
  const input=session.input=new InputSession({host,identity:identities.client,instance:s.i.instance,current:()=>viewer.session===session,progress:()=>viewer.progress,pollMs:5,timeoutMs,
    onFailure:code=>viewer.finish(code),write:(frame,callback)=>{
      const epoch=frame.readUInt32BE(8),op=frame[5];commands.push([epoch,op]);
      if(op!==3)Object.assign(s.i.streams[0],{epoch,acknowledged:epoch,enabled:true,paused:op===1});callback();
      if(local)queueMicrotask(()=>input.receive({version:1,event:'input',epoch,stage:op===3?'acknowledged':'submitted'}));
    }});
  await input.initialize();
  const controller=new DisplayController({store,viewer,pollMs:10,pendingPollMs:5,timeoutMs});
  t.after(async()=>{controller.close();input.close();await close(server);});controller.reconcile();
  return {s,posts,commands,reads,host,session,store,viewer,input,controller,block(){blocked=true;},local(value){local=value;},
    apply(){return controller.apply({viewId:controller.snapshot().viewId,display:'right'});},
    setInput(paused){return controller.setInput({viewId:controller.snapshot().viewId,paused});},
    encoded(){Object.assign(s.d,{generation:3,capture:{id:'right'},result:'applied'});Object.assign(s.d.streams[0],{generation:3,firstFrame:25});}};
}
test('paired display selection pauses through host encoding and actual native presentation',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canSelect);f.apply();await until(()=>f.posts.length===1);
  assert.deepEqual(f.posts[0],{instance:f.s.i.instance,stream:3,inputEpoch:3,revision:1,display:'right'});
  assert.deepEqual(f.commands.slice(-2),[[3,1],[3,3]]);assert.equal(f.input.phase,'paused');
  f.encoded();await delay(40);assert.equal(f.controller.snapshot().phase,'switching');assert.equal(f.input.phase,'paused');
  f.viewer.progress.received=f.viewer.progress.rendered=25;await until(()=>f.controller.snapshot().result?.kind==='applied');
  assert.deepEqual(f.commands.slice(-2),[[4,2],[4,3]]);assert.equal(f.input.phase,'active');assert.equal(f.viewer.session,f.session);
  assert.equal(f.controller.snapshot().capture,'right');assert.equal(f.posts.length,1);
});
test('manual pause survives display selection and explicit resume requires a new presented frame',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().input.canPause);f.setInput(true);await until(()=>f.controller.snapshot().input.canResume);
  assert.equal(f.viewer.manualPaused,true);assert.equal(f.input.epoch,3);
  f.apply();await until(()=>f.posts.length===1);assert.equal(f.posts[0].inputEpoch,3);f.encoded();f.viewer.progress.received=f.viewer.progress.rendered=25;
  await until(()=>f.controller.snapshot().result?.kind==='applied');assert.equal(f.input.phase,'paused');assert.equal(f.input.epoch,3);
  assert.equal(f.commands.some(([epoch])=>epoch===4),false);f.setInput(false);
  // The controller reports resuming before its metadata read has completed.
  // Wait for InputSession to begin the guarded resume before advancing video.
  await until(()=>f.input.busy);assert.equal(f.controller.snapshot().input.phase,'resuming');assert.equal(f.input.epoch,3);assert.equal(f.viewer.manualPaused,true);
  f.viewer.progress.received=f.viewer.progress.rendered=26;await until(()=>f.input.phase==='active');
  assert.equal(f.viewer.manualPaused,false);assert.deepEqual(f.commands.slice(-2),[[4,2],[4,3]]);
});

test('a frame arriving before delayed resume metadata is not a new resume frame',{timeout:5000},async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().input.canPause);f.setInput(true);await until(()=>f.controller.snapshot().input.canResume);
  const request=f.controller.request,readDisplay=f.input.readDisplay;let release,arrived,observed,reads=0;
  const gate=new Promise(resolve=>release=resolve),metadata=new Promise(resolve=>arrived=resolve);t.after(release);
  const checkedUnchangedFrame=new Promise(resolve=>observed=resolve);
  f.input.readDisplay=(...args)=>{if(++reads===2)observed();return readDisplay(...args);};
  f.controller.request=async(...args)=>{const result=await request(...args);arrived();await gate;return result;};
  f.setInput(false);await metadata;
  assert.equal(f.controller.snapshot().input.phase,'resuming');assert.equal(f.input.busy,false);
  f.viewer.progress.received=f.viewer.progress.rendered=21;release();await checkedUnchangedFrame;
  assert.equal(f.input.phase,'paused');assert.equal(f.input.epoch,3);assert.equal(f.viewer.manualPaused,true);
  f.viewer.progress.received=f.viewer.progress.rendered=22;await until(()=>f.input.phase==='active');
  assert.equal(f.viewer.manualPaused,false);assert.deepEqual(f.commands.slice(-2),[[4,2],[4,3]]);
});
test('a manual pause requested during automatic display switching suppresses its automatic resume',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canSelect);f.apply();await until(()=>f.posts.length===1);
  assert.equal(f.controller.snapshot().input.canPause,true);f.setInput(true);f.encoded();f.viewer.progress.received=f.viewer.progress.rendered=25;
  await until(()=>f.controller.snapshot().result?.kind==='applied');assert.equal(f.input.phase,'paused');assert.equal(f.input.epoch,3);assert.equal(f.viewer.manualPaused,true);
  assert.equal(f.commands.filter(([epoch,op])=>epoch===3&&op===1).length,1);
});
test('manual pause remains available with frozen video; resume waits for current display metadata',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canSelect);f.viewer.progress.renderedAgeMs=3000;
  assert.equal(f.controller.snapshot().canSelect,false);assert.equal(f.controller.snapshot().input.canPause,true);f.setInput(true);
  await until(()=>f.input.phase==='paused'&&!f.input.busy);assert.equal(f.controller.snapshot().input.canResume,false);
  assert.throws(()=>f.setInput(false),{code:'INPUT_NOT_READY'});assert.equal(f.input.epoch,3);
  f.viewer.progress.renderedAgeMs=0;await until(()=>f.controller.snapshot().input.canResume);
  f.s.d.inputEpochSelection=false;await until(()=>f.controller.snapshot().error==='DISPLAY_UNSUPPORTED');assert.equal(f.controller.snapshot().input.canResume,true);
  f.setInput(false);await until(()=>f.input.busy);
  assert.equal(f.input.phase,'paused');assert.equal(f.viewer.manualPaused,true);
  f.viewer.progress.received=f.viewer.progress.rendered=21;await until(()=>f.input.phase==='active');
});
test('manual resume cancellation preserves pause intent and rejects stale or injected renderer targets',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().input.canPause);const viewId=f.controller.snapshot().viewId;
  for(const data of [{viewId,paused:'true'},{viewId,paused:true,epoch:3},{viewId:'old',paused:true}])assert.throws(()=>f.controller.setInput(data));
  f.setInput(true);await until(()=>f.controller.snapshot().input.canResume);f.setInput(false);await until(()=>f.controller.record.pending?.paused===false);
  f.viewer.finish('CANCELLED');f.controller.reconcile();await delay(30);assert.equal(f.viewer.manualPaused,true);assert.equal(f.commands.some(([epoch])=>epoch===4),false);
});
test('a lost selection response is observed once and never automatically resent',async t=>{
  const f=await fixture(t,{post:({s,body,res})=>{Object.assign(s.d,{requestId:1,requested:body.display,requestStream:body.stream,inputEpoch:body.inputEpoch,result:'pending'});res.destroy();}});
  await until(()=>f.controller.snapshot().canSelect);f.apply();await until(()=>f.posts.length===1);f.encoded();f.viewer.progress.received=f.viewer.progress.rendered=25;
  await until(()=>f.controller.snapshot().result?.kind==='applied');await delay(30);assert.equal(f.posts.length,1);assert.equal(f.input.epoch,4);
});
test('uncertain timeout and explicit rejection end the viewer without reopening input',async t=>{
  for(const reject of [false,true])await t.test(reject?'rejection':'timeout',async t=>{
    const f=await fixture(t,{timeoutMs:300,post:reject?({s,res})=>{res.writeHead(409);res.end(JSON.stringify(s.d));}:undefined});
    await until(()=>f.controller.snapshot().canSelect);f.apply();await until(()=>f.viewer.failures.length);
    assert.deepEqual(f.commands.slice(-2),[[3,1],[3,3]]);assert.equal(f.posts.length,1);assert.equal(f.input.phase,'closed');
  });
});
test('superseded request, epoch, competing stream and engine replacement cannot confirm',async t=>{
  for(const change of ['request','epoch','shared','engine'])await t.test(change,async t=>{
    const f=await fixture(t);await until(()=>f.controller.snapshot().canSelect);f.apply();await until(()=>f.posts.length===1);
    if(change==='request')f.s.d.requestId=2;
    if(change==='epoch')f.s.d.inputEpoch=5;
    if(change==='shared')f.s.d.shared=true;
    if(change==='engine')f.s.d.instance='aaaaaaaa-1234-1234-1234-123456789012';
    await until(()=>f.viewer.failures.length);assert.equal(f.commands.some(([epoch])=>epoch===4),false);
  });
});
test('route replacement cancels delayed pause; stale UI and extra target fields are rejected',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canSelect);const viewId=f.controller.snapshot().viewId;
  for(const body of [{viewId,display:'absent'},{viewId,display:'right',stream:7},{viewId:'old',display:'right'}])assert.throws(()=>f.controller.apply(body));
  f.local(false);f.apply();await until(()=>f.commands.at(-1)[0]===3);f.host.routeId='replacement';f.viewer.finish('CANCELLED');f.controller.reconcile();await delay(30);
  assert.equal(f.posts.length,0);assert.equal(f.input.phase,'closed');assert.equal(f.controller.snapshot().phase,'idle');
});
test('wrong TLS pin sends no HTTP and pairing revocation closes the viewer',async t=>{
  const f=await fixture(t);await until(()=>f.controller.snapshot().canSelect);f.block();await until(()=>f.viewer.failures.length);assert.equal(f.viewer.failures[0],'UNPAIRED');
  const wrong=await fixture(t);await until(()=>wrong.controller.snapshot().canSelect);wrong.controller.dispose();await delay(20);const count=wrong.reads.length;
  wrong.session.host.certificate=wrong.host.certificate=identities.wrong.cert;wrong.controller.reconcile();await until(()=>wrong.viewer.failures.length);
  assert.equal(wrong.viewer.failures[0],'HOST_CERT_CHANGED');assert.equal(wrong.reads.length,count);
});
test('parser rejects contradictory guarded metadata, duplicates and unsafe identifiers',()=>{
  for(const change of [{revision:Number.MAX_SAFE_INTEGER+1},{displays:['left','left']},{displays:['bad\n']},{requestStream:3,inputEpoch:0},
    {inputEpoch:2,requestStream:3,requestId:1,result:'pending',requested:'right'},{result:'applied',requestId:0},{accepted:'true'},{shared:null}]){
    assert.throws(()=>protocol.state({...states().d,...change}),{code:'DISPLAY_INVALID_RESPONSE'});
  }
  assert.equal(protocol.state({...states().d,inputEpochSelection:undefined}).inputEpochSelection,false);
});
