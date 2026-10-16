'use strict';
// Real packaged controller/native trust changes with disposable client certs.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),https=require('node:https');
const {snapshot,encryptedStorage}=require('./test_macos_host_state.cjs');
async function main(){
  assert.equal(process.platform,'darwin');const directory=path.resolve(process.argv[2]);
  const {HostController}=require(path.join(directory,'host-controller.cjs'));
  const {pairHost}=require(path.join(directory,'pairing.cjs'));
  const {exchange}=require(path.join(directory,'paired-transport.cjs'));
  const {identities}=require('../windows/tests/mac-pairing-fixture.cjs');
  const protectedDirectories=[path.join(os.homedir(),'.config','sunshine'),path.join(os.homedir(),'Library','Application Support','ClipRelay','host')];
  const before=protectedDirectories.map(snapshot),originalHome=process.env.HOME;
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-packaged-host-clients-')));
  const controller=new HostController({directory,stateDirectory:path.join(base,'Private clients'),safeStorage:encryptedStorage(),localName:'Client management fixture'});
  const cases=[],children=[],runtimes=[];let stage='start',agent,firstSocket;
  async function start(){
    await controller.action('host-start');await controller.startTask;assert.equal(controller.snapshot().phase,'running');
    const session=controller.owner.session;children.push(session.engine.current.child,session.companion.current.child);runtimes.push(path.dirname(session.companion.ipcPath()));
  }
  function reaped(){for(const child of children){assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);}for(const runtime of runtimes)assert.equal(fs.existsSync(runtime),false);}
  async function pair(identity,name){
    return pairHost({address:'127.0.0.1',port:48789,identity,name,onVerification:async verification=>{
      const status=await controller.action('host-status'),request=status.requests.find(item=>item.verification===verification.verification);
      assert.ok(request);assert.equal(request.expires,verification.expires);
      await controller.action('host-pair-approve',{id:request.id,generation:request.generation,verification:request.verification});
    }});
  }
  const status=async()=>{const result=await controller.action('host-status');assert.equal(result.clients.phase,'ready');return result.clients;};
  const revoke=async(current,uuid)=>controller.action('host-client-revoke',{viewId:current.viewId,uuid});
  function reusedRequest(){
    return new Promise((resolve,reject)=>{
      const req=https.request({host:'127.0.0.1',port:48791,path:'/not-a-command',method:'GET',agent},res=>{
        const socket=res.socket;res.resume();res.once('end',()=>resolve({status:res.statusCode,socket}));res.once('error',reject);
      });req.once('error',reject);req.setTimeout(3000,()=>req.destroy(Error('CONTROL_REQUEST_TIMEOUT')));req.end();
    });
  }
  try{
    await start();assert.deepEqual((await status()).devices,[]);
    stage='pair-two';const a=await pair(identities.client,'Disposable client A');await pair(identities.wrong,'Disposable client B');
    const current=await status();assert.equal(current.devices.length,2);
    const first=current.devices.find(device=>device.name==='Disposable client A'),second=current.devices.find(device=>device.name==='Disposable client B');
    assert.ok(first?.enabled);assert.ok(second?.enabled);assert.notEqual(first.uuid,second.uuid);cases.push('packaged-two-client-pairing-and-list');
    const control=identity=>({address:'127.0.0.1',port:48791,path:'/not-a-command',method:'GET',identity,trust:{cert:a.certificate},acceptStatuses:[404],timeout:3000,limit:2048});
    const expected=new crypto.X509Certificate(a.certificate).raw;
    agent=new https.Agent({keepAlive:true,maxSockets:1,maxCachedSessions:0,cert:identities.client.cert,key:identities.client.key,ca:a.certificate,
      minVersion:'TLSv1.2',checkServerIdentity:(_host,cert)=>cert.raw?.equals(expected)?undefined:Error('HOST_CERT_CHANGED')});
    const beforeRevoke=await reusedRequest();assert.equal(beforeRevoke.status,404);firstSocket=beforeRevoke.socket;
    stage='revoke-first';const revoked=await revoke(current,first.uuid);assert.deepEqual(revoked.clients.devices,[second]);assert.equal(revoked.clients.error,null);
    await exchange(control(identities.wrong));cases.push('live-client-disable-then-remove-preserves-other-client');
    stage='reused-control';const afterRevoke=await reusedRequest();assert.equal(afterRevoke.status,403);assert.equal(afterRevoke.socket,firstSocket);
    await assert.rejects(exchange(control(identities.client)));cases.push('revocation-rejects-new-and-reused-control-connections');agent.destroy();
    stage='restart';await controller.action('host-stop');reaped();await start();const restarted=await status();
    assert.notEqual(restarted.viewId,current.viewId);assert.deepEqual(restarted.devices,[second]);
    await assert.rejects(revoke(current,second.uuid),{code:'HOST_CLIENTS_STALE'});
    await assert.rejects(exchange(control(identities.client)));await exchange(control(identities.wrong));cases.push('restart-preserves-revocation-and-rejects-old-view');
    stage='re-pair';await pair(identities.client,'Disposable client A');const rejoined=await status();
    const replacement=rejoined.devices.find(device=>device.name==='Disposable client A');assert.ok(replacement?.enabled);assert.notEqual(replacement.uuid,first.uuid);
    await assert.rejects(revoke(rejoined,first.uuid),{code:'HOST_CLIENTS_STALE'});await exchange(control(identities.client));cases.push('re-pair-creates-new-identity-old-decision-rejected');
    stage='lost-reply';const transport=controller.clients.request;let lost=false;
    controller.clients.request=async options=>{
      const result=await transport(options);
      if(options.operation==='unpair' && options.uuid===replacement.uuid){assert.equal(lost,false);lost=true;throw Error('DISPOSABLE_LOST_REPLY');}
      return result;
    };
    const confirmed=await revoke(rejoined,replacement.uuid);assert.equal(lost,true);assert.equal(confirmed.clients.error,null);assert.deepEqual(confirmed.clients.devices,[second]);
    controller.clients.request=transport;cases.push('unpair-lost-reply-confirmed-by-native-list');
    stage='revoke-all';await revoke(await status(),second.uuid);
    assert.deepEqual((await status()).devices,[]);await assert.rejects(exchange(control(identities.client)));await assert.rejects(exchange(control(identities.wrong)));
    cases.push('last-client-revocation-removes-all-trust');
    stage='close';await controller.close();reaped();assert.equal(controller.snapshot().phase,'closed');cases.push('owner-close-reaps-both-native-processes');
    assert.deepEqual(protectedDirectories.map(snapshot),before);assert.equal(process.env.HOME,originalHome);
  }catch(error){console.error(JSON.stringify({stage,code:error.code || 'PACKAGED_CLIENT_MANAGEMENT_FAILED',host:controller.snapshot().phase,clients:controller.snapshot().clients.phase}));throw error;}
  finally{
    agent?.destroy();await controller.close();for(const child of children)assert.ok(child.exitCode!==null || child.signalCode!==null);
    assert.deepEqual(protectedDirectories.map(snapshot),before);assert.ok(base.startsWith(fs.realpathSync(os.tmpdir())+path.sep));
    assert.ok(path.basename(base).startsWith('cliprelay-packaged-host-clients-'));fs.rmSync(base,{recursive:true,force:true});
  }
  process.stdout.write(JSON.stringify({protocol:1,passed:true,cases,actualChildStarts:children.length,realClientPairings:3,
    revokePreservesOtherClient:true,reusedTLSRefused:true,newTLSRefused:true,revocationPersisted:true,newPairingRequired:true,lostReplyConfirmed:true,
    ownedChildrenReaped:true,defaultStateUnchanged:true,nativeWorkers:false,keychainValidated:false,nativeRequestsExecuted:false,streamStarted:false,systemInputInjected:false,
    scope:'Actual packaged two-client management, pinned native admin changes and reused/new control TLS on disposable macOS CI. No user GUI, Keychain or active video-stream termination acceptance.'})+'\n');
}
main().catch(()=>{process.exitCode=1;});
