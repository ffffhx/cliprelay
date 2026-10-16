'use strict';
// Run only after the real package installer on a disposable Windows CI runner.
// The installed SYSTEM service owns the native engine and host helper. This
// test opens no GUI, starts no stream and never writes to the clipboard.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
assert.equal(process.platform,'win32');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.ok(process.env.RUNNER_TEMP);
const reportPath=path.resolve(process.argv[2]);
const installed=path.join(process.env.LOCALAPPDATA,'ClipRelay'),state=path.join(process.env.ProgramData,'ClipRelay','Remote');
const {pairHost}=require(path.join(installed,'electron','mac','pairing.cjs'));
const {jsonRequest,exchange}=require(path.join(installed,'electron','mac','paired-transport.cjs'));
const {identities}=require('./mac-pairing-fixture.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function control(command){
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection('\\\\.\\pipe\\ClipRelay.Remote.Control.v1');let bytes=0,buffer='',done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(Error('INSTALLED_CONTROL_TIMEOUT')),25000);
    socket.once('error',error=>finish(error));socket.once('end',()=>finish(Error('INSTALLED_CONTROL_EOF')));
    socket.once('connect',()=>socket.write(JSON.stringify(command)+'\n'));
    socket.on('data',chunk=>{
      bytes+=chunk.length;if(bytes>1024*1024){finish(Error('INSTALLED_CONTROL_LIMIT'));return;}buffer+=chunk.toString('utf8');
      if(!buffer.includes('\n'))return;
      try{const reply=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));assert.equal(typeof reply.ok,'boolean');finish(null,reply);}catch(error){finish(error);}
    });
  });
}
async function request(command){const reply=await control(command);assert.equal(reply.ok,true,JSON.stringify({action:command.action,error:reply.error}));return reply.data;}
async function until(read,predicate,timeout=15000){const deadline=Date.now()+timeout;while(true){const value=await read();if(predicate(value))return value;if(Date.now()>deadline)throw Error('INSTALLED_PAIRING_WAIT_TIMEOUT');await pause(100);}}
const decision=(action,value)=>({action,id:value.id,generation:value.generation,verification:value.verification});
const bootstrap=()=>jsonRequest({address:'127.0.0.1',port:48792,path:'/v1/pair',identity:identities.client,trust:{bootstrap:true},
  headers:{'X-ClipRelay-Pairing-Feedback':'1'},body:{name:'Disposable installed pairing client',nonce:'a'.repeat(32),pin:'1234'},timeout:3000,limit:2048});
async function main(){
  const cases=[];let stage='initial-state',rejectionFeedbackMs;
  const initial=await request({action:'status'});assert.equal(initial.enabled,false,'Fresh CI installation must start disabled');
  try{
    stage='start';await request({action:'enable'});
    await until(()=>request({action:'status'}),value=>value.ready===true,65000);
    await until(()=>control({action:'lanPairings'}),value=>value.ok===true,15000);
    assert.deepEqual((await request({action:'clients'})).named_certs,[]);
    cases.push('installed-system-service-started-native-host-and-managed-helper');
    stage='generation';const firstTicket=await bootstrap();assert.equal(firstTicket.feedback.protocol,1);
    const first=(await request({action:'lanPairings'})).pairings[0];assert.ok(first);assert.equal(first.verification,firstTicket.verification);
    await request(decision('lanPairReject',first));
    await until(()=>request({action:'lanPairings'}),value=>value.pairings.length===0);
    const secondTicket=await bootstrap();const second=(await request({action:'pairings'})).pairings.find(value=>value.automatic);
    assert.ok(second);assert.equal(second.id,first.id);assert.notEqual(second.generation,first.generation);
    assert.notEqual(secondTicket.feedback.receipt,firstTicket.feedback.receipt);
    assert.equal((await control(decision('lanPairApprove',first))).ok,false);
    const wrong={...second,verification:second.verification==='FFFF FFFF FFFF'?'AAAA AAAA AAAA':'FFFF FFFF FFFF'};
    assert.equal((await control(decision('lanPairApprove',wrong))).ok,false);
    assert.equal((await request({action:'lanPairings'})).pairings[0].state,'waiting');
    await request(decision('lanPairReject',second));
    await until(()=>request({action:'lanPairings'}),value=>value.pairings.length===0);
    assert.equal(fs.existsSync(path.join(state,'lan-pairing')),false);
    cases.push('installed-generation-and-code-bound-decisions-without-approval-files');
    stage='rejection-feedback';let rejectedAt;
    await assert.rejects(pairHost({address:'127.0.0.1',name:'Rejected installed client',identity:identities.client,
      onVerification:async value=>{
        const pending=await until(()=>request({action:'lanPairings'}),result=>result.pairings.some(item=>item.verification===value.verification));
        rejectedAt=Date.now();await request(decision('lanPairReject',pending.pairings.find(item=>item.verification===value.verification)));
      }}),{code:'PAIRING_REJECTED'});
    rejectionFeedbackMs=Date.now()-rejectedAt;assert.ok(rejectionFeedbackMs<5000);
    cases.push('installed-rejection-reaches-packaged-desktop-consumer');
    await until(()=>request({action:'lanPairings'}),value=>value.pairings.length===0);
    stage='native-pair';
    const paired=await pairHost({address:'127.0.0.1',name:'Approved installed client',identity:identities.client,
      onVerification:async value=>{
        const pending=await until(()=>request({action:'pairings'}),result=>result.pairings.some(item=>item.verification===value.verification));
        await request(decision('lanPairApprove',pending.pairings.find(item=>item.verification===value.verification)));
      }});
    assert.ok(paired.certificate);assert.ok((await request({action:'clients'})).named_certs.length>0);
    cases.push('installed-approval-completes-real-native-certificate-pairing');
    stage='authorization';
    // 48792 admits unpaired bootstrap clients; authorization is enforced by
    // the separate paired control listener on 48791 before HTTP dispatch.
    const options={address:'127.0.0.1',port:48791,path:'/v1/installed-pairing-fixture',method:'GET',trust:{cert:paired.certificate},timeout:3000,limit:2048,acceptStatuses:[404]};
    await exchange({...options,identity:identities.client});
    await assert.rejects(exchange({...options,identity:identities.wrong}),error=>
      error.code==='UNPAIRED' || error.code==='ECONNRESET' || /^ERR_SSL_/.test(error.code || ''));
    cases.push('paired-certificate-admitted-and-unpaired-certificate-refused');
  }catch(error){process.stderr.write(JSON.stringify({stage,error:error.message,code:error.code})+'\n');throw error;}
  finally{
    await request({action:'disable'});
    const stopped=await request({action:'status'});assert.equal(stopped.enabled,false);assert.equal(stopped.running,false);
    assert.deepEqual((await request({action:'lanPairings'})).pairings,[]);
  }
  cases.push('installed-owner-disable-stops-engine-and-withdraws-requests');
  const report={protocol:1,passed:true,cases,rejectionFeedbackMs,installedSystemService:true,packagedDesktopConsumer:true,
    realNativePairing:true,privateCurrentGenerationDecisions:true,pairedCertificateVerified:true,remoteRejectionFeedback:true,
    noApprovalFiles:true,disabledAfterTest:true,streamStarted:false,clipboardWritten:false,userGuiControlled:false,
    scope:'Real installed Windows SYSTEM service, helper pipe, native certificate pairing and packaged desktop consumer on a disposable CI runner. No video stream, real phone or GUI acceptance.'};
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify(report)+'\n');
}
main().catch(()=>{process.exitCode=1;});
