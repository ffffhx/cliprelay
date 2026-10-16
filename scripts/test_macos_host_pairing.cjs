'use strict';
// Actual packaged Mac controller -> private companion IPC -> native engine PIN
// exchange with a disposable synthetic client. No user GUI or streaming client.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {snapshot,encryptedStorage}=require('./test_macos_host_state.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate){const deadline=Date.now()+15000;while(true){const value=await read();if(predicate(value))return value;if(Date.now()>deadline)throw Error('PACKAGED_PAIRING_WAIT_TIMEOUT');await pause(25);}}
async function main(){
  assert.equal(process.platform,'darwin');const directory=path.resolve(process.argv[2]);
  const {HostController}=require(path.join(directory,'host-controller.cjs'));
  const {pairHost}=require(path.join(directory,'pairing.cjs'));
  const {jsonRequest,exchange}=require(path.join(directory,'paired-transport.cjs'));
  const {identities}=require('../windows/tests/mac-pairing-fixture.cjs');
  const protectedDirectories=[path.join(os.homedir(),'.config','sunshine'),path.join(os.homedir(),'Library','Application Support','ClipRelay','host')];
  const before=protectedDirectories.map(snapshot),originalHome=process.env.HOME;
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-packaged-host-pairing-'))),stateDirectory=path.join(base,'Private CI host');
  const controller=new HostController({directory,stateDirectory,safeStorage:encryptedStorage(),localName:'Packaged pairing fixture'});
  const cases=[],children=[],runtimes=[];let stage='start',rejectionFeedbackMs,expiryWaitMs;
  const data=request=>({id:request.id,generation:request.generation,verification:request.verification});
  async function start(){
    assert.equal((await controller.action('host-start')).phase,'starting');await controller.startTask;
    assert.equal(controller.snapshot().phase,'running');const session=controller.owner.session;
    children.push(session.engine.current.child,session.companion.current.child);runtimes.push(path.dirname(session.companion.ipcPath()));
  }
  function reaped(){for(const child of children){assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);}for(const file of runtimes)assert.equal(fs.existsSync(file),false);}
  const bootstrap=()=>jsonRequest({address:'127.0.0.1',port:48792,path:'/v1/pair',identity:identities.client,trust:{bootstrap:true},
    body:{name:'Rejected disposable client',nonce:'a'.repeat(32),pin:'1234'},timeout:3000,limit:2048});
  function contains(value,certificate){
    if(typeof value==='string'){try{return new crypto.X509Certificate(value).raw.equals(new crypto.X509Certificate(certificate).raw);}catch{return false;}}
    return !!value && typeof value==='object' && Object.values(value).some(item=>contains(item,certificate));
  }
  try{
    await start();assert.deepEqual((await controller.action('host-status')).requests,[]);cases.push('packaged-host-controller-start');
    stage='reject';await bootstrap();const first=(await controller.action('host-status')).requests[0];assert.ok(first);
    await controller.action('host-pair-reject',data(first));
    const second=await until(async()=>{await bootstrap();return (await controller.action('host-status')).requests[0];},request=>request && request.generation!==first.generation);
    assert.equal(first.id,second.id);await assert.rejects(controller.action('host-pair-approve',data(first)),{code:'HOST_PAIR_STALE'});
    await assert.rejects(controller.action('host-pair-approve',{...data(second),verification:second.verification==='FFFF FFFF FFFF'?'AAAA AAAA AAAA':'FFFF FFFF FFFF'}),{code:'HOST_PAIR_STALE'});
    await controller.action('host-pair-reject',data(second));assert.equal(fs.existsSync(path.join(stateDirectory,'lan-pairing')),false);
    cases.push('private-rejection-and-stale-generation-refusal');
    await until(()=>controller.action('host-status'),value=>value.requests.length===0);
    stage='remote-rejection-feedback';let rejectedAt;
    await assert.rejects(pairHost({address:'127.0.0.1',port:48789,name:'Rejected feedback client',identity:identities.client,
      onVerification:async verification=>{
        const status=await until(()=>controller.action('host-status'),value=>value.requests.some(request=>request.verification===verification.verification));
        rejectedAt=Date.now();await controller.action('host-pair-reject',data(status.requests.find(request=>request.verification===verification.verification)));
      }}),{code:'PAIRING_REJECTED'});
    rejectionFeedbackMs=Date.now()-rejectedAt;assert.ok(rejectionFeedbackMs<5000);cases.push('remote-rejection-feedback-joins-waiting-client');
    await until(()=>controller.action('host-status'),value=>value.requests.length===0);
    stage='remote-expiry-feedback';let waitingAt;
    // Exercise the production two-minute expiry, without shortening the host's
    // deadline or replacing its actual public TLS/status implementation.
    await assert.rejects(pairHost({address:'127.0.0.1',port:48789,name:'Expired feedback client',identity:identities.client,
      onVerification:()=>{waitingAt=Date.now();}}),{code:'PAIRING_EXPIRED'});
    expiryWaitMs=Date.now()-waitingAt;assert.ok(expiryWaitMs>=110000 && expiryWaitMs<130000);
    await until(()=>controller.action('host-status'),value=>value.requests.length===0);
    await assert.rejects(exchange({address:'127.0.0.1',port:48791,path:'/not-a-command',method:'GET',identity:identities.client,
      trust:{cert:controller.owner.session.engine.state.read('cacert.pem',16384)},acceptStatuses:[404],timeout:3000,limit:2048}));
    cases.push('remote-expiry-feedback-joins-waiting-client');
    stage='real-pairing';let compared=false,approved=false;
    const pairing=await pairHost({address:'127.0.0.1',port:48789,name:'Disposable packaged client',identity:identities.client,
      onVerification:async verification=>{
        const status=await until(()=>controller.action('host-status'),value=>value.requests.some(request=>request.verification===verification.verification));
        const current=status.requests.find(request=>request.verification===verification.verification);assert.equal(current.expires,verification.expires);compared=true;
        await controller.action('host-pair-approve',data(current));approved=true;
      }});
    assert.equal(compared,true);assert.equal(approved,true);
    const state=controller.owner.session.engine.state,certificate=state.read('cacert.pem',16384);
    assert.deepEqual(new crypto.X509Certificate(pairing.certificate).raw,new crypto.X509Certificate(certificate).raw);
    await until(()=>JSON.parse(state.read('clients.json',4*1024*1024)),clients=>contains(clients,identities.client.cert));
    cases.push('both-code-comparison-and-real-native-certificate-pairing');
    stage='paired-tls';const control={address:'127.0.0.1',port:48791,path:'/not-a-command',method:'GET',identity:identities.client,
      trust:{cert:pairing.certificate},acceptStatuses:[404],timeout:3000,limit:2048};
    await exchange(control);await assert.rejects(exchange({...control,identity:identities.wrong}));cases.push('paired-client-tls-accepted-and-other-client-refused');
    stage='restart';await controller.action('host-stop');reaped();await start();
    assert.deepEqual(state.read('cacert.pem',16384),certificate);assert.ok(contains(JSON.parse(state.read('clients.json',4*1024*1024)),identities.client.cert));
    await exchange(control);assert.deepEqual((await controller.action('host-status')).requests,[]);cases.push('restart-retains-approved-client-with-no-stale-requests');
    stage='close';await controller.close();reaped();assert.equal(controller.snapshot().phase,'closed');cases.push('application-owner-close-reaps-both-processes');
    assert.deepEqual(protectedDirectories.map(snapshot),before);assert.equal(process.env.HOME,originalHome);
  }catch(error){console.error(JSON.stringify({stage,code:error.code || 'PACKAGED_HOST_PAIRING_FAILED',host:controller.snapshot().phase}));throw error;}
  finally{
    await controller.close();for(const child of children)assert.ok(child.exitCode!==null || child.signalCode!==null);
    assert.deepEqual(protectedDirectories.map(snapshot),before);assert.ok(base.startsWith(fs.realpathSync(os.tmpdir())+path.sep));
    assert.ok(path.basename(base).startsWith('cliprelay-packaged-host-pairing-'));fs.rmSync(base,{recursive:true,force:true});
  }
  process.stdout.write(JSON.stringify({protocol:1,passed:true,cases,actualChildStarts:children.length,realNativePairing:true,pairedClientPersisted:true,
    remoteRejectionFeedback:true,remoteExpiryFeedback:true,rejectionFeedbackMs,expiryWaitMs,
    unauthorizedClientRefused:true,ownedChildrenReaped:true,defaultStateUnchanged:true,nativeWorkers:false,keychainValidated:false,
    nativeRequestsExecuted:false,streamStarted:false,systemInputInjected:false,
    scope:'Actual packaged main controller, private approval IPC and native certificate pairing with a disposable client on macOS CI. Fixture encryption; no user GUI, Keychain, permission request, video stream or system input.'})+'\n');
}
main().catch(()=>{process.exitCode=1;});
