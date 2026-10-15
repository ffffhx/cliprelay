'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),https=require('node:https'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const {StreamViewer,envelope}=require('../electron/mac/stream-viewer.cjs');
const instance='12345678-1234-1234-1234-123456789012';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<300;i++){if(check())return;await delay(5);}throw Error('viewer input test deadline');}
const childCode=`
let bytes=Buffer.alloc(0),ready=false,telemetry=false;
const report=value=>process.stdout.write(JSON.stringify(value)+'\\n');
process.stdin.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);
  if(!ready&&bytes.length>=4&&bytes.length>=4+bytes.readUInt32BE()){
    const size=4+bytes.readUInt32BE(),session=JSON.parse(bytes.subarray(4,size));bytes=bytes.subarray(size);ready=true;telemetry=!!session.telemetry;
    process.send({init:true,inputEpochs:session.inputEpochs===true,telemetry});report({version:1,event:'connected'});
    if(telemetry)report({version:1,event:'progress',received:20,rendered:20,width:1280,height:720,receivedAgeMs:0,renderedAgeMs:0});
  }
  while(ready&&bytes.length>=16){const frame=bytes.subarray(0,16);bytes=bytes.subarray(16);
    if(frame.subarray(0,4).toString()!=='CRIC')process.exit(8);
    const epoch=frame.readUInt32BE(8),op=frame[5];process.send({epoch,op});
    if(!settings.ignoreLocal)report({version:1,event:'input',epoch,stage:op===3?'acknowledged':'submitted'});
  }
});
process.stdin.on('end',()=>process.exit(0));setTimeout(()=>process.exit(9),6000);
`;
async function fixture(t,options={}){
  let requests=0,hang=false,streamID=2;const commands=[],children=[],initial=[];
  const input={protocol:1,supported:true,instance,streams:[]};
  const server=https.createServer({key:identities.host.key,cert:identities.host.cert,requestCert:true,rejectUnauthorized:false},(req,res)=>{
    requests++;assert.ok(req.socket.getPeerCertificate().raw);if(hang)return;
    if(options.unsupported){res.writeHead(404);res.end();return;}
    res.end(JSON.stringify(req.url==='/v1/input-state'?input:{protocol:1,supported:true,instance,phase:'active',generation:2,capture:{id:'left'},
      streams:input.streams.map(s=>({id:s.id,generation:2,firstFrame:10,width:1280,height:720}))}));
  });
  const port=await listen(server),cert=options.wrongPin?identities.wrong.cert:identities.host.cert;
  const host={id:crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest('hex'),clientId:'a'.repeat(32),name:'Input fixture',enabled:true,address:'127.0.0.1',port:port-2,certificate:cert,routeId:'first'};
  const store={data:{legacySelected:false},host,selected(){return {...this.host};},async identity(){return identities.client;}};
  const viewer=new StreamViewer({directory:'.',store,resolveExecutable:()=>process.execPath,resolveTelemetry:()=>options.telemetry!==false,
    resolveInput:()=>options.capability!==false,inputPollMs:5,inputTimeoutMs:options.timeoutMs||3000,retryDelays:[5],
    spawnProcess:(file,args,config)=>{
      const child=spawn(file,['-e','const settings='+JSON.stringify({ignoreLocal:!!options.ignoreLocal})+';'+childCode],{
        ...config,env:{...config.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},stdio:['pipe','pipe','ignore','ipc']});
      children.push(child);child.on('message',value=>{
        if(value.init){initial.push(value);input.streams=[{id:++streamID,epoch:0,acknowledged:0,enabled:false,paused:false,pending:false,closed:false,failed:false,exclusive:true}];}
        else{commands.push([value.epoch,value.op]);if(value.op!==3)Object.assign(input.streams[0],{enabled:true,epoch:value.epoch,acknowledged:value.epoch,paused:value.op===1});}
      });return child;
    }});
  t.after(async()=>{viewer.stop();await until(()=>!viewer.child);await close(server);});
  return {viewer,store,host,input,commands,children,initial,get requests(){return requests;},setHang(value){hang=value;}};
}
test('real owned child negotiates epochs and completes the local/host/presentation handshake',async t=>{
  const f=await fixture(t);await f.viewer.open();await until(()=>f.viewer.snapshot().input.phase==='active');
  assert.deepEqual(f.initial,[{init:true,inputEpochs:true,telemetry:true}]);assert.deepEqual(f.commands,[[1,1],[1,3],[2,2],[2,3]]);
  assert.equal(f.viewer.snapshot().input.epoch,2);assert.equal(f.children.length,1);
  await f.viewer.currentSession().input.pause();assert.equal(f.viewer.snapshot().input.phase,'paused');
  const old=f.viewer.record;f.viewer.stop();await until(()=>!f.viewer.child);assert.equal(old.input.closed,true);assert.equal(f.viewer.phase,'idle');
});
test('epoch capability requires telemetry and unsupported hosts retain the legacy envelope',async t=>{
  for(const options of [{capability:false},{telemetry:false},{unsupported:true}])await t.test(JSON.stringify(options),async t=>{
    const f=await fixture(t,options);await f.viewer.open();await until(()=>f.initial.length===1&&f.viewer.phase==='running');
    assert.equal(f.initial[0].inputEpochs,false);assert.equal(f.viewer.snapshot().input.phase,'unavailable');assert.deepEqual(f.commands,[]);
    assert.equal(f.requests,options.unsupported?1:0);
  });
});
test('renderer stream options cannot request epochs or fabricate telemetry',async t=>{
  const f=await fixture(t,{capability:false});
  for(const options of [{inputEpochs:true},{telemetry:true}])await assert.rejects(f.viewer.open(options),{code:'INVALID_STREAM_OPTIONS'});
  assert.equal(f.children.length,0);
  assert.throws(()=>envelope(f.host,identities.client,{},false,true),{code:'INVALID_STREAM_OPTIONS'});
});
test('wrong pinned host certificate prevents spawning a native viewer',async t=>{
  const f=await fixture(t,{wrongPin:true});await assert.rejects(f.viewer.open(),{code:'HOST_CERT_CHANGED'});
  assert.equal(f.requests,0);assert.equal(f.children.length,0);
});
test('stop aborts a pending capability read and prevents a late child from starting',async t=>{
  const f=await fixture(t);f.setHang(true);const opening=f.viewer.open();await until(()=>f.requests>0);f.viewer.stop();
  await assert.rejects(opening,{code:'CANCELLED'});assert.equal(f.children.length,0);assert.equal(f.viewer.phase,'idle');
});
test('missing local acknowledgment closes the child lease without automatic recovery',async t=>{
  const f=await fixture(t,{ignoreLocal:true,timeoutMs:250});await f.viewer.open();await until(()=>f.viewer.phase==='error');
  assert.equal(f.viewer.error,'INPUT_TIMEOUT');assert.equal(f.children.length,1);assert.deepEqual(f.commands,[[1,1]]);
});
test('replacement routes discard old input events and initialize a fresh command sequence',async t=>{
  const f=await fixture(t);await f.viewer.open();await until(()=>f.viewer.snapshot().input.phase==='active');
  const old=f.viewer.record;f.store.host.routeId='second';f.viewer.reconcile();
  await until(()=>f.children.length===2&&f.viewer.snapshot().input.phase==='active');
  assert.equal(old.input.closed,true);f.viewer.events(old,Buffer.from('{"version":1,"event":"input","epoch":99,"stage":"acknowledged"}\n'));
  assert.equal(f.viewer.snapshot().input.epoch,2);assert.equal(f.viewer.error,'');assert.deepEqual(f.commands.slice(-4),[[1,1],[1,3],[2,2],[2,3]]);
});
