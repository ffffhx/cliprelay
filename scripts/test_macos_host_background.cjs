'use strict';
// Real private host polling and persisted opt-in, without a user window or OS
// notification. The notification callback is observed as a bounded event.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {snapshot,encryptedStorage}=require('./test_macos_host_state.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate){const deadline=Date.now()+15000;for(;;){const value=await read();if(predicate(value))return value;if(Date.now()>deadline)throw Error('BACKGROUND_WAIT_TIMEOUT');await pause(25);}}
async function main(){
  assert.equal(process.platform,'darwin');const directory=path.resolve(process.argv[2]);
  const {HostController}=require(path.join(directory,'host-controller.cjs'));
  const {loadConfig,saveConfig}=require(path.join(directory,'config.cjs'));
  const {jsonRequest}=require(path.join(directory,'paired-transport.cjs'));
  const {identities}=require('../windows/tests/mac-pairing-fixture.cjs');
  const protectedDirectories=[path.join(os.homedir(),'.config','sunshine'),path.join(os.homedir(),'Library','Application Support','ClipRelay','host')];
  const before=protectedDirectories.map(snapshot),originalHome=process.env.HOME;
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-packaged-host-background-'))),preferences=path.join(base,'Preferences'),stateDirectory=path.join(base,'Host state');
  const storage=encryptedStorage(),controllers=[],children=[],runtimes=[],notices=[],cases=[];let observedReads=0,stage='default';
  function reopen(){
    let config=loadConfig(preferences,{legacy:()=>({}),defaults:()=>({}),hostname:()=> 'Disposable background Mac'});
    const controller=new HostController({directory,stateDirectory,safeStorage:storage,localName:config.deviceName,autoStart:config.hostAutoStart,
      saveAutoStart:enabled=>{const next={...config,hostAutoStart:enabled};saveConfig(preferences,next);config=next;},
      onPairingRequest:value=>{assert.deepEqual(Object.keys(value),['count']);notices.push(value);},
      onUpdate:value=>{if(value.phase==='running' && !value.error && value.requests.length)observedReads++;}});
    controllers.push(controller);return controller;
  }
  function reaped(){for(const child of children){assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);}for(const runtime of runtimes)assert.equal(fs.existsSync(runtime),false);}
  const decision=request=>({id:request.id,generation:request.generation,verification:request.verification});
  const bootstrap=()=>jsonRequest({address:'127.0.0.1',port:48792,path:'/v1/pair',identity:identities.client,trust:{bootstrap:true},
    body:{name:'Background disposable client',nonce:'a'.repeat(32),pin:'1234'},timeout:3000,limit:2048});
  try{
    const defaults=loadConfig(preferences,{legacy:()=>({}),defaults:()=>({}),hostname:()=> 'Disposable background Mac'});
    assert.equal(defaults.hostAutoStart,true);cases.push('fresh-config-default-startup-enabled');
    // Exercise an explicit saved opt-out, rather than the obsolete default-off policy.
    saveConfig(preferences,{...defaults,hostAutoStart:false});
    const initial=reopen();await initial.launch();assert.equal(initial.snapshot().autoStart,false);assert.equal(initial.snapshot().phase,'stopped');
    assert.equal(initial.owner.session.current,null);assert.equal(initial.monitor.record,undefined);cases.push('saved-opt-out-does-not-start-host');
    await initial.action('host-set-auto-start',{enabled:true});assert.equal(loadConfig(preferences).hostAutoStart,true);assert.equal(initial.snapshot().phase,'stopped');
    await initial.close();cases.push('explicit-opt-in-persists-without-starting-now');
    stage='opt-in-start';const controller=reopen();await controller.launch();await controller.startTask;assert.equal(controller.snapshot().phase,'running');
    const session=controller.owner.session;children.push(session.engine.current.child,session.companion.current.child);runtimes.push(path.dirname(session.companion.ipcPath()));
    cases.push('reopen-opt-in-starts-actual-owned-host');
    stage='background-request';controller.releaseWindow();await bootstrap();await until(()=>notices.length,value=>value===1);
    const first=controller.snapshot().requests[0];assert.ok(first);assert.deepEqual(notices,[{count:1}]);
    assert.equal(fs.existsSync(path.join(stateDirectory,'lan-pairing')),false);cases.push('background-pairing-observed-after-settings-close');
    const firstReads=observedReads;await bootstrap();await until(()=>observedReads,value=>value>=firstReads+2);assert.equal(notices.length,1);
    await controller.action('host-pair-reject',decision(first));
    stage='replacement-generation';await until(async()=>{await bootstrap();return controller.snapshot().requests[0];},request=>request && request.generation!==first.generation);
    await until(()=>notices.length,value=>value===2);const replacement=controller.snapshot().requests[0];assert.equal(replacement.id,first.id);
    assert.notEqual(replacement.generation,first.generation);assert.deepEqual(notices,[{count:1},{count:1}]);cases.push('same-generation-dedup-and-new-generation-notification');
    stage='stop';await controller.action('host-stop');reaped();assert.equal(controller.monitor.record,null);assert.equal(controller.monitor.tasks.size,0);
    assert.deepEqual(controller.snapshot().requests,[]);cases.push('stop-joins-monitor-and-native-children');
    await controller.action('host-set-auto-start',{enabled:false});assert.equal(loadConfig(preferences).hostAutoStart,false);await controller.close();
    stage='opt-out-reopen';const disabled=reopen();await disabled.launch();assert.equal(disabled.snapshot().phase,'stopped');assert.equal(disabled.owner.session.current,null);
    cases.push('opt-out-persists-and-reopen-stays-stopped');await disabled.close();assert.equal(notices.length,2);reaped();
    assert.deepEqual(protectedDirectories.map(snapshot),before);assert.equal(process.env.HOME,originalHome);cases.push('close-without-late-notification-or-default-state-change');
  }catch(error){console.error(JSON.stringify({stage,code:error.code || 'PACKAGED_BACKGROUND_FAILED',notices:notices.length}));throw error;}
  finally{
    for(const controller of controllers)await controller.close();for(const child of children)assert.ok(child.exitCode!==null || child.signalCode!==null);
    assert.deepEqual(protectedDirectories.map(snapshot),before);assert.ok(base.startsWith(fs.realpathSync(os.tmpdir())+path.sep));
    assert.ok(path.basename(base).startsWith('cliprelay-packaged-host-background-'));fs.rmSync(base,{recursive:true,force:true});
  }
  process.stdout.write(JSON.stringify({protocol:1,passed:true,cases,actualChildStarts:children.length,observedNoticeEvents:notices.length,
    backgroundRequestsObserved:true,requestNotificationsDeduplicated:true,startupOptInPersisted:true,defaultStartupEnabled:true,savedOptOutRespected:true,optOutReopenStopped:true,
    ownedChildrenReaped:true,defaultStateUnchanged:true,nativeWorkers:false,keychainValidated:false,nativeRequestsExecuted:false,
    nativeNotificationsDisplayed:false,guiValidated:false,streamStarted:false,systemInputInjected:false,
    scope:'Actual packaged private polling with no settings window, generation-specific notification events, saved startup opt-in and opt-out on disposable macOS CI. Notification callback observation only; no OS notification, user GUI, Keychain or video stream acceptance.'})+'\n');
}
main().catch(()=>{process.exitCode=1;});
