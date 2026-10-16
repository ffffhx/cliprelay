'use strict';
// Disposable CI only: actual installed SYSTEM owner and encrypted loopback
// video. The native receiver counts compressed frames; it presents/saves none.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
assert.equal(process.platform,'win32');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.ok(process.env.RUNNER_TEMP);
const installed=path.join(process.env.LOCALAPPDATA,'ClipRelay'),state=path.join(process.env.ProgramData,'ClipRelay','Remote');
const receiver=process.env.CLIPRELAY_STREAM_TEST_RECEIVER;assert.ok(receiver&&path.isAbsolute(receiver)&&fs.statSync(receiver).isFile());
const reportPath=path.resolve(process.argv[2]);
const {pairHost}=require(path.join(installed,'electron/mac/pairing.cjs'));
const {exchange,jsonRequest}=require(path.join(installed,'electron/mac/paired-transport.cjs'));
const {xmlValue}=require(path.join(installed,'electron/mac/paired-crypto.cjs'));
const {identities}=require('./mac-pairing-fixture.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const receivers=[];
function control(command,allowUnavailable=false){
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection('\\\\.\\pipe\\ClipRelay.Remote.Control.v1');let bytes=0,buffer='',done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(Error('CONTROL_TIMEOUT')),25000);
    socket.once('error',error=>finish(error));socket.once('end',()=>finish(Error('CONTROL_EOF')));
    socket.once('connect',()=>socket.write(JSON.stringify(command)+'\n'));
    socket.on('data',chunk=>{
      bytes+=chunk.length;if(bytes>65536){finish(Error('CONTROL_LIMIT'));return;}buffer+=chunk.toString('utf8');
      if(!buffer.includes('\n'))return;
      try{const value=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));assert.equal(typeof value.ok,'boolean');if(allowUnavailable&&!value.ok){finish(null,null);return;}assert.equal(value.ok,true,'Service rejected '+command.action);finish(null,value.data);}catch(error){finish(error);}
    });
  });
}
async function until(read,predicate,timeout=15000){
  const deadline=Date.now()+timeout;
  while(true){const value=await read();if(predicate(value))return value;if(Date.now()>=deadline)throw Error('RUNTIME_WAIT_TIMEOUT');await pause(100);}
}
function startReceiver(info,url,key,iv){
  const directory=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'cliprelay-stream-'));
  const file=path.join(directory,'received.json'),stopFile=path.join(directory,'stop');
  const child=spawn(receiver,[xmlValue(info,'appversion'),xmlValue(info,'GfeVersion'),url,key,iv,file,stopFile],{cwd:path.dirname(receiver),windowsHide:true,stdio:['ignore','pipe','pipe']});
  let ended=null,bytes=0;const completion=new Promise(resolve=>{
    child.once('error',error=>{ended={error:error.code||'SPAWN_FAILED'};resolve(ended);});
    child.once('close',(code,signal)=>{ended={code,signal};resolve(ended);});
  });
  for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{bytes+=data.length;if(bytes>2*1024*1024)child.kill();});
  const item={child,file,stopFile,get ended(){return ended;},completion,
    read(){try{assert.ok(fs.statSync(file).size<=16384);return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(['ENOENT','EACCES','EBUSY'].includes(error.code)||error instanceof SyntaxError)return null;throw error;}},
    async finish(){if(ended)return;fs.writeFileSync(stopFile,'stop');let timer;try{await Promise.race([completion,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('RECEIVER_STOP_TIMEOUT')),10000);})]);}finally{clearTimeout(timer);if(!ended){child.kill();await completion;}}}
  };
  receivers.push(item);return item;
}
async function main(){
  const report={protocol:1,passed:false,sourceCommit:process.env.GITHUB_SHA,cases:[],streamStarted:false,decodedOrPresented:false,screenContentSaved:false,inputInjected:false,clipboardWritten:false};
  let stage='initial',primaryError,trust,adminPassword,first,second,enginePid;
  const initial=await control({action:'status'});assert.equal(initial.enabled,false);
  try{
    stage='enable';await control({action:'enable'});
    const ready=await until(()=>control({action:'status'}),value=>value.ready,65000);enginePid=ready.pid;
    await until(()=>control({action:'lanPairings'},true),value=>Array.isArray(value?.pairings));
    assert.deepEqual((await control({action:'clients'})).named_certs,[]);
    const pair=(identity,name)=>pairHost({address:'127.0.0.1',name,identity,onVerification:async value=>{
      const result=await until(()=>control({action:'lanPairings'}),result=>result.pairings.some(item=>item.verification===value.verification));
      const request=result.pairings.find(item=>item.verification===value.verification);
      await control({action:'lanPairApprove',id:request.id,generation:request.generation,verification:request.verification});
    }});
    stage='pair-two-clients';const host=await pair(identities.client,'Streaming revocation client');trust={cert:host.certificate};
    const preserved=await pair(identities.wrong,'Preserved streaming client');
    assert.deepEqual(new crypto.X509Certificate(preserved.certificate).raw,new crypto.X509Certificate(host.certificate).raw);
    adminPassword=JSON.parse(fs.readFileSync(path.join(state,'service.json'),'utf8')).adminPassword;assert.ok(typeof adminPassword==='string'&&adminPassword.length>=32);
    const admin=()=>jsonRequest({address:'127.0.0.1',port:48790,path:'/api/cliprelay/displays',method:'GET',identity:identities.client,trust,timeout:3000,limit:65536,
      headers:{Authorization:'Basic '+Buffer.from('cliprelay:'+adminPassword).toString('base64')}});
    const nvhttp=(identity,name,parameters={})=>exchange({address:'127.0.0.1',port:48784,path:'/'+name+'?'+new URLSearchParams({...parameters,uniqueid:'cliprelay-stream-fixture',uuid:crypto.randomUUID()}),
      method:'GET',identity,trust,timeout:30000,limit:65536});
    const owner=identity=>new crypto.X509Certificate(identity.cert).fingerprint256.replaceAll(':','').toLowerCase();
    async function begin(identity){
      const info=await nvhttp(identity,'serverinfo'),apps=await nvhttp(identity,'applist');
      const appId=xmlValue(apps,'ID');assert.match(appId,/^[1-9][0-9]*$/);
      const key=crypto.randomBytes(16).toString('hex'),keyId=crypto.randomInt(1,0x7fffffff),iv=Buffer.alloc(16);iv.writeUInt32BE(keyId);
      const resume=xmlValue(info,'currentgame')!=='0';
      const launch=await nvhttp(identity,resume?'resume':'launch',{appid:appId,mode:'1280x720x30',sops:0,rikey:key,rikeyid:keyId,
        localAudioPlayMode:1,surroundAudioInfo:196610,remoteControllersBitmap:0,gcmap:0,gcpersist:0,corever:1});
      assert.equal(xmlValue(launch,resume?'resume':'gamesession'),'1');
      const url=xmlValue(launch,'sessionUrl0');assert.match(url,/^rtsp(?:enc)?:\/\/127\.0\.0\.1:[0-9]+/);
      const item=startReceiver(info,url,key,iv.toString('hex'));
      const sample=await until(async()=>{
        assert.equal(item.ended,null,'Native receiver exited before receiving frames');
        return {native:await admin(),received:item.read()};
      },value=>value.received?.connected&&value.received.frames>=3&&value.native.phase==='active'&&value.native.streams.length===1&&
        value.native.streams[0].owner===owner(identity)&&value.native.streams[0].firstFrame>0&&value.received.lastFrame>=value.native.streams[0].firstFrame,30000);
      report.streamStarted=true;
      return {item,sample,owner:owner(identity)};
    }
    stage='first-real-frames';first=await begin(identities.client);
    report.firstFrames=first.sample.received.frames;report.firstStreamId=first.sample.native.streams[0].id;
    report.cases.push('installed-service-pairs-two-identities-and-receives-real-encrypted-frames');
    const clients=await control({action:'clients'});assert.equal(clients.named_certs.length,2);
    const target=clients.named_certs.find(value=>value.name==='Streaming revocation client'),other=clients.named_certs.find(value=>value.name==='Preserved streaming client');assert.ok(target?.enabled&&other?.enabled);
    await pause(250);assert.equal(first.item.ended,null);assert.equal(fs.existsSync(first.item.stopFile),false);
    stage='revoke-active-stream';const revokedAt=Date.now();await control({action:'unpair',uuid:target.uuid,viewId:clients.viewId});
    await until(()=>first.item.ended,value=>value!==null,10000);
    assert.deepEqual(first.item.ended,{code:1,signal:null});
    const final=first.item.read();assert.ok(final);
    report.termination=final.termination;report.terminationCode=final.terminationCode;report.hostTerminationReceived=final.hostTerminationReceived;
    assert.equal(final.connected,false);assert.equal(final.termination,1);assert.ok(final.frames>=report.firstFrames);
    assert.equal(final.hostTerminationReceived,true);assert.equal(final.terminationCode,0);
    assert.equal(fs.existsSync(first.item.stopFile),false,'Receiver was locally stopped before revocation evidence');
    const idle=await until(admin,value=>value.phase==='idle'&&value.streams.length===0,10000);
    assert.equal(idle.instance,first.sample.native.instance);assert.equal((await control({action:'status'})).pid,enginePid);
    report.revocationMs=Date.now()-revokedAt;assert.ok(report.revocationMs<15000);
    report.engineUnchanged=true;report.receiverStoppedByHost=true;
    assert.deepEqual((await control({action:'clients'})).named_certs,[other]);
    await assert.rejects(nvhttp(identities.client,'serverinfo'),error=>error.code==='UNPAIRED'||error.code==='ECONNRESET'||/^ERR_SSL_/.test(error.code||''));
    report.cases.push('service-revocation-terminates-active-video-without-local-stop-or-engine-restart');
    stage='preserved-client-real-frames';second=await begin(identities.wrong);
    assert.equal(second.sample.native.instance,first.sample.native.instance);assert.notEqual(second.sample.native.streams[0].id,report.firstStreamId);
    report.secondFrames=second.sample.received.frames;report.secondStreamId=second.sample.native.streams[0].id;report.preservedClientStreams=true;
    report.cases.push('preserved-certificate-establishes-a-new-real-stream-on-the-same-engine');
    stage='second-clean-stop';await second.item.finish();assert.deepEqual(second.item.ended,{code:0,signal:null});
    await nvhttp(identities.wrong,'cancel');await until(admin,value=>value.phase==='idle'&&value.streams.length===0);
    const remaining=await control({action:'clients'});await control({action:'unpair',uuid:other.uuid,viewId:remaining.viewId});
    assert.deepEqual((await control({action:'clients'})).named_certs,[]);report.cases.push('owned-receivers-stop-and-final-device-trust-is-removed');
  }catch(error){primaryError=error;report.failure={stage,name:error.name,code:error.code||'',message:error.message.slice(0,240)};}
  finally{
    try{
      for(const item of receivers)await item.finish();
      await control({action:'disable'});const status=await control({action:'status'});assert.equal(status.enabled,false);assert.equal(status.running,false);
      report.disabledAfterTest=true;report.receiversExited=receivers.every(item=>item.ended!==null);
    }catch(error){report.cleanupFailure={name:error.name,code:error.code||''};primaryError ||= error;}
    report.passed=!primaryError;
    fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  }
  process.stdout.write(JSON.stringify(report)+'\n');if(primaryError)process.exitCode=1;
}
main().catch(error=>{process.stderr.write(JSON.stringify({stage:'fixture-entry',name:error.name,code:error.code||''})+'\n');process.exitCode=1;});
