// A foreground GitHub Action owns every child for the whole experiment. The
// toolkit publishes only public certificates/route metadata while jobs run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import {spawn,execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {DefaultArtifactClient} from '@actions/artifact';

assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.GITHUB_REPOSITORY,'ffffhx/cliprelay');
const role=process.env.CLIPRELAY_BRIDGE_ROLE,pair=process.env.CLIPRELAY_BRIDGE_PAIR;
assert.ok(['host','viewer'].includes(role));assert.ok(['linux','x64','arm64'].includes(pair));
const run=Number(process.env.GITHUB_RUN_ID),attempt=Number(process.env.GITHUB_RUN_ATTEMPT),commit=process.env.GITHUB_SHA;
assert.ok(Number.isSafeInteger(run)&&run>0&&Number.isSafeInteger(attempt)&&attempt>0);assert.match(commit,/^[a-f0-9]{40}$/);
const root=fs.realpathSync(process.env.GITHUB_WORKSPACE),runner=fs.realpathSync(process.env.RUNNER_TEMP);
const sourceDirectory=path.dirname(fileURLToPath(import.meta.url));
assert.equal(sourceDirectory,path.join(root,'scripts/ci_audio_bridge'));
const state=fs.mkdtempSync(path.join(runner,'cliprelay-audio-bridge-action-'));
const binary=fs.realpathSync(process.env.CLIPRELAY_BRIDGE_BINARY);
assert.equal(binary,path.join(runner,'cliprelay-audio-bridge'));
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const receipt=JSON.parse(fs.readFileSync(process.env.CLIPRELAY_BRIDGE_RECEIPT,'utf8'));
assert.equal(receipt.commit,commit);assert.equal(receipt.binarySha256,hash(fs.readFileSync(binary)));
for(const [name,digest] of Object.entries(receipt.sources))assert.equal(hash(fs.readFileSync(path.join(root,name))),digest);
const machine=hash(process.platform==='linux'?fs.readFileSync('/proc/sys/kernel/random/boot_id'):
  execFileSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{timeout:3000}));
const artifact=new DefaultArtifactClient(),exec=promisify(execFile);
const common={protocol:1,run,attempt,commit,role,pair,machine};
const artifactName=(kind,side)=>`ClipRelay-Audio-Bridge-${kind}-${side}-${pair}-${attempt}`;
const childEnv=Object.fromEntries(['PATH','HOME','TMPDIR','RUNNER_TEMP','GITHUB_ACTIONS','GITHUB_REPOSITORY','GITHUB_RUN_ID','GITHUB_SHA','GITHUB_RUN_ATTEMPT']
  .filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]));
const children=[],servers=[],sockets=new Set();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,accept,timeout=15000){const end=Date.now()+timeout;while(true){const value=await read();if(accept(value))return value;assert.ok(Date.now()<end,'BRIDGE_WAIT_TIMEOUT');await pause(100);}}
function launch(file,args,{json=true}={}){
  const child=spawn(file,args,{env:childEnv,stdio:['pipe','pipe','pipe']});
  const item={child,exit:null,error:null,events:[],buffer:'',route:null};children.push(item);
  child.stdin.on('error',()=>{});child.once('error',()=>{item.error='CHILD_SPAWN_FAILED';});child.once('close',(code,signal)=>{item.exit={code,signal};});
  function data(bytes){
    if(!json){item.buffer=(item.buffer+bytes.toString('utf8')).slice(-16384);item.route??=item.buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];return;}
    item.buffer+=bytes.toString('utf8');if(item.buffer.length>32768){item.error='CHILD_OUTPUT_LIMIT';child.kill('SIGKILL');return;}
    while(item.buffer.includes('\n')){
      const end=item.buffer.indexOf('\n'),line=item.buffer.slice(0,end);item.buffer=item.buffer.slice(end+1);
      try{assert.ok(item.events.length<2000);item.events.push(JSON.parse(line));}catch{item.error='CHILD_OUTPUT_INVALID';child.kill('SIGKILL');return;}
    }
  }
  child.stdout.on('data',data);if(json)child.stderr.resume();else child.stderr.on('data',data);
  return item;
}
function alive(item){assert.equal(item.error,null);assert.equal(item.exit,null,'BRIDGE_CHILD_EXIT');return item.events.at(-1);}
async function stop(item,connector=false){
  if(!item||item.exit)return;
  if(connector)item.child.kill('SIGTERM');else item.child.stdin.end();
  try{await until(()=>item.exit,Boolean,6000);}finally{if(!item.exit){item.child.kill('SIGKILL');await until(()=>item.exit,Boolean,3000);}}
}
function identity(){
  const value=JSON.parse(execFileSync(binary,['init'],{env:childEnv,timeout:5000,maxBuffer:16384,encoding:'utf8'}));
  assert.equal(value.event,'identity');assert.equal(value.version,1);
  assert.equal(value.certificateSha256,hash(new crypto.X509Certificate(value.certificate).raw));return value;
}
async function publish(kind,value){
  const directory=path.join(state,kind);fs.mkdirSync(directory);const file=path.join(directory,'public.json');
  fs.writeFileSync(file,JSON.stringify({...common,kind,...value})+'\n');
  const result=await artifact.uploadArtifact(artifactName(kind,role),[file],directory,{retentionDays:1});
  assert.ok(result.id>0);return result.id;
}
async function downloaded(args){
  const result=await exec('python3',[path.join(sourceDirectory,'fetch.py'),...args],{
    env:{...process.env,CLIPRELAY_BRIDGE_STATE:state},timeout:80000,maxBuffer:32768});
  const value=JSON.parse(result.stdout);assert.equal(value.error,undefined);return value;
}
async function readPublic(kind,side){
  const record=await until(async()=>{const value=await downloaded(['public',artifactName(kind,side)]);if(!value.available)await pause(2000);return value;},v=>v.available,180000);
  const v=record.state;
  for(const [key,value] of Object.entries({protocol:1,run,attempt,commit,role:side,pair,kind}))assert.equal(v[key],value);
  assert.notEqual(v.machine,machine);assert.match(v.machine,/^[a-f0-9]{64}$/);
  return record;
}
async function bridge(own,peer,route){
  const item=launch(binary,['serve']);item.child.stdin.write(JSON.stringify({version:1,role,directory:own.directory,peerCertificate:peer.certificate,...(route?{url:route}:{})})+'\n');
  const ready=await until(()=>alive(item),v=>v?.event==='ready');
  assert.equal(ready.certificateSha256,own.certificateSha256);assert.equal(ready.peerCertificateSha256,peer.certificateSha256);
  return {item,ready};
}
async function bridgeState(item){
  alive(item);const after=item.events.length;item.child.stdin.write('state\n');
  return until(()=>{alive(item);return item.events.slice(after).find(v=>v.event==='state');},Boolean,3000);
}
async function listen(server,port){servers.push(server);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}
function track(socket){sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});}
async function request(endpoint,method='GET'){
  const response=await fetch('http://127.0.0.1:48830/'+endpoint,{method,signal:AbortSignal.timeout(5000),headers:{Connection:'close'}});
  assert.equal(response.status,200);return response.json();
}
async function rejectUntrusted(own,peer,route){
  const wrong=identity();assert.notEqual(wrong.certificateSha256,own.certificateSha256);
  const {item}=await bridge(wrong,peer,route);
  try{
    await new Promise((resolve,reject)=>{
      const client=net.connect({host:'127.0.0.1',port:48789});track(client);let bytes=0;
      client.setTimeout(7000,()=>client.destroy(new Error('REJECTION_TIMEOUT')));
      client.once('connect',()=>client.write('untrusted-fixture'));
      client.on('data',data=>{bytes+=data.length});client.once('error',error=>{if(error.code==='ECONNRESET'&&bytes===0)resolve();else reject(error)});
      client.once('close',()=>{if(bytes)reject(new Error('UNTRUSTED_RESPONSE'));else resolve();});
    });
  }finally{await stop(item);assert.deepEqual(item.exit,{code:0,signal:null});assert.equal(item.events.at(-1)?.listenersClosed,true);}
}

const report={...common,passed:false,scope:'Disposable cross-job transport for separate audio environments. Synthetic bytes only; not audio playback, production relay or WAN resilience validation.',
  audioPlaybackVerified:false,productionRelayVerified:false,fixture:receipt,cases:[]};
let connector,activeBridge,stage='identity';
async function main(){
  try{
    const own=identity();report.identitySha256=own.certificateSha256;
    report.identityArtifact=await publish('identity',{certificate:own.certificate,certificateSha256:own.certificateSha256});
    stage='peer-identity';const peerRecord=await readPublic('identity',role==='host'?'viewer':'host'),peer=peerRecord.state;
    assert.equal(peer.certificateSha256,hash(new crypto.X509Certificate(peer.certificate).raw));report.peerIdentity=peerRecord;
    if(role==='host'){
      stage='host-bridge';const started=await bridge(own,peer);activeBridge=started.item;
      let accepted=0,udpReceived=0,done=false;
      const tcp=net.createServer(socket=>{accepted++;track(socket);socket.pipe(socket);});await listen(tcp,48789);
      const udp=dgram.createSocket('udp4');servers.push(udp);udp.on('message',(data,remote)=>{udpReceived++;udp.send(data,remote.port,remote.address)});
      await new Promise((resolve,reject)=>{udp.once('error',reject);udp.bind(48798,'127.0.0.1',resolve)});
      const control=http.createServer((req,res)=>{
        (async()=>{
          assert.equal(req.headers['content-length']||'0','0');
          if(req.url==='/stats'&&req.method==='GET')res.end(JSON.stringify({accepted,udpReceived,bridge:(await bridgeState(activeBridge)).counters,machine}));
          else if(req.url==='/done'&&req.method==='POST'){res.once('finish',()=>{done=true});res.end(JSON.stringify({done:true}));}
          else{res.statusCode=404;res.end();}
        })().catch(()=>{res.statusCode=500;res.end();});
      });control.on('connection',track);await listen(control,48830);
      stage='connector';report.connector=await downloaded(['connector']);
      const config=path.join(state,'cloudflared.yml');fs.writeFileSync(config,'{}\n');
      connector=launch(report.connector.path,['tunnel','--config',config,'--no-autoupdate','--url','http://'+started.ready.address,'--protocol','http2','--metrics','127.0.0.1:0'],{json:false});
      const publicURL=await until(()=>{alive(connector);return connector.route},Boolean,45000);
      await until(async()=>{
        alive(connector);try{const response=await fetch(publicURL+'/',{signal:AbortSignal.timeout(3000)});return response.status===404&&response.headers.get('x-cliprelay-fixture')==='audio-bridge-v1';}catch{return false}
      },Boolean,60000);
      report.routeArtifact=await publish('route',{url:publicURL.replace('https:','wss:')+'/bridge',certificateSha256:own.certificateSha256});
      stage='remote-exchange';await until(()=>{alive(activeBridge);alive(connector);return done},Boolean,180000);
      report.host={accepted,udpReceived,bridge:(await bridgeState(activeBridge)).counters};
      assert.equal(accepted,1);assert.equal(udpReceived,6);assert.ok(report.host.bridge.Rejected>=1);
      report.cases.push('untrusted-peer-rejected-before-echo-backend','separate-job-TCP-and-datagrams-received');
    }else{
      stage='route';const routeRecord=await readPublic('route','host'),route=routeRecord.state;
      assert.equal(route.certificateSha256,peer.certificateSha256);report.route=routeRecord;
      stage='reject-untrusted';await rejectUntrusted(own,peer,route.url);
      stage='viewer-bridge';activeBridge=(await bridge(own,peer,route.url)).item;
      const before=await request('stats');assert.equal(before.accepted,0);assert.equal(before.udpReceived,0);assert.ok(before.bridge.Rejected>=1);assert.equal(before.machine,peer.machine);
      report.cases.push('untrusted-peer-rejected-before-echo-backend');
      stage='TCP-roundtrip';const payload=crypto.randomBytes(2*1024*1024),expected=hash(payload);
      const tcp=await new Promise((resolve,reject)=>{
        const socket=net.connect({host:'127.0.0.1',port:48789});track(socket);const digest=crypto.createHash('sha256');let bytes=0;
        socket.setTimeout(20000,()=>socket.destroy(new Error('TCP_TIMEOUT')));socket.once('error',reject);
        socket.once('connect',()=>socket.end(payload));socket.on('data',data=>{bytes+=data.length;digest.update(data);if(bytes>payload.length)socket.destroy(new Error('TCP_OVERFLOW'))});
        socket.once('end',()=>resolve({bytes,sha256:digest.digest('hex')}));
      });assert.deepEqual(tcp,{bytes:payload.length,sha256:expected});report.tcp=tcp;report.cases.push('cross-job-TCP-content-and-half-close');
      stage='UDP-roundtrip';const udp=dgram.createSocket('udp4');servers.push(udp);await new Promise(resolve=>udp.bind(0,'127.0.0.1',resolve));
      report.datagrams=[];
      for(const size of [0,1,17,1400,8192,65507]){
        const payload=crypto.randomBytes(size),received=await new Promise((resolve,reject)=>{
          const timeout=setTimeout(()=>{udp.off('message',message);reject(new Error('UDP_TIMEOUT'))},5000);
          const message=data=>{clearTimeout(timeout);resolve(data)};udp.once('message',message);udp.send(payload,48798,'127.0.0.1',error=>{if(error){clearTimeout(timeout);udp.off('message',message);reject(error)}});
        });assert.deepEqual(received,payload);report.datagrams.push({bytes:size,sha256:hash(received)});
      }
      report.cases.push('cross-job-UDP-boundaries-through-production-forwarder');
      assert.equal((await request('stats')).udpReceived,6);assert.deepEqual(await request('done','POST'),{done:true});
    }
    stage='cleanup';
    await stop(activeBridge);assert.deepEqual(activeBridge.exit,{code:0,signal:null});assert.equal(activeBridge.events.at(-1)?.listenersClosed,true);
    report.bridgeClosed=activeBridge.events.at(-1);
    if(role==='host')assert.equal(report.bridgeClosed.counters.Active,0);
    if(connector){await stop(connector,true);assert.ok(connector.exit.code===0||connector.exit.signal==='SIGTERM');}
    for(const socket of sockets)socket.destroy();
    for(const server of servers)await new Promise(resolve=>server.close(resolve));servers.length=0;
    assert.ok(children.every(item=>item.exit));report.cases.push('owned-children-and-sockets-closed');report.passed=true;
  }catch(error){
    report.failure={stage,code:error.code||error.name,location:error.stack?.match(/index\.mjs:\d+:\d+/)?.[0]};process.exitCode=1;
  }finally{
    for(const child of children)try{await stop(child,child===connector)}catch{report.cleanupFailed=true;report.passed=false;process.exitCode=1}
    for(const socket of sockets)socket.destroy();
    for(const server of servers)try{await new Promise(resolve=>server.close(resolve))}catch{report.cleanupFailed=true;report.passed=false;process.exitCode=1}
    report.exits=children.map(item=>item.exit);
    const file=path.join(state,'result.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
    await artifact.uploadArtifact(`ClipRelay-Audio-Bridge-Result-${role}-${pair}-${attempt}`,[file],state,{retentionDays:14});
    console.log(JSON.stringify({role,passed:report.passed,stage,cases:report.cases}));
  }
}
main().catch(()=>{console.error('CI_AUDIO_BRIDGE_ACTION_FAILED');process.exitCode=1});
