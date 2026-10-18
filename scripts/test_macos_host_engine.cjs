'use strict';
// Starts the actual packaged engine on a disposable macOS CI machine. Native
// startup can probe displays/encoders. There is no streaming client, input
// injection, permission request, real Keychain storage or user application UI.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {snapshot,encryptedStorage}=require('./test_macos_host_state.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){
  const deadline=Date.now()+15000;
  while(!predicate()){if(Date.now()>deadline)throw Object.assign(new Error('PACKAGED_HOST_WAIT_TIMEOUT'),{code:'PACKAGED_HOST_WAIT_TIMEOUT'});await pause(25);}
}
async function main(){
  assert.equal(process.platform,'darwin');
  const engineDirectory=path.resolve(process.argv[2]),appDirectory=path.dirname(engineDirectory);
  const {HostState,configuration}=require(path.join(appDirectory,'host-state.cjs'));
  const {HostEngine}=require(path.join(appDirectory,'host-engine.cjs'));
  const {hostStatus}=require(path.join(appDirectory,'host-admin.cjs'));
  const pin=JSON.parse(fs.readFileSync(path.join(appDirectory,'host-engine-pin.json'),'utf8'));
  const protectedDirectories=[path.join(os.homedir(),'.config','sunshine'),path.join(os.homedir(),'Library','Application Support','ClipRelay','host')];
  const protectedBefore=protectedDirectories.map(snapshot),originalHome=process.env.HOME;
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-packaged-host-engine-')));
  const directory=path.join(base,'Owned Mac host #1'),state=new HostState({directory,safeStorage:encryptedStorage()});
  const children=[],phases=[],cases=[];let stage='prepare',identity,certificate,authorization,privateFiles,unexpectedExit;
  // Fixed CI-only loopback configuration. All state validation, permission
  // preflight, process ownership, HTTPS authentication and monitoring are real.
  const fixtureState={
    prepare(hostName){const result=state.prepare(hostName);state.write('sunshine.conf',configuration(hostName)+'bind_address = 127.0.0.1\n');return result;},
    environment:parent=>state.environment(parent),read:(file,limit)=>state.read(file,limit),
    authorization:()=>state.authorization(),close:()=>state.close()
  };
  const engine=new HostEngine({directory:engineDirectory,pin,state:fixtureState,
    onUpdate:value=>phases.push({phase:value.phase,error:value.error}),
    launch(file,args,settings){
      assert.equal(settings.env.HOME,originalHome);
      const child=spawn(file,args,settings);children.push(child);return child;
    }
  });
  async function start(){
    const status=await engine.start('Packaged CI Mac');
    assert.equal(status.phase,'running');
    const reply=await hostStatus({state});
    assert.deepEqual(reply,{protocol:1,pid:children.at(-1).pid,ownerPid:process.pid,owned:true,screenRecording:true,inputControl:true});
    return status;
  }
  function reaped(child){assert.ok(child.exitCode!==null || child.signalCode!==null);assert.equal(engine.current,null);}
  try{
    stage='authenticated-start';await start();cases.push('packaged-authenticated-start');
    identity=state.id;certificate=state.read('cacert.pem',16384);authorization=state.authorization();
    stage='eof-stop';await engine.stop();reaped(children[0]);
    assert.equal(children[0].exitCode,0);assert.equal(children[0].signalCode,null);assert.equal(engine.snapshot().phase,'stopped');
    cases.push('packaged-eof-stop');
    stage='explicit-restart';await start();assert.equal(state.id,identity);assert.deepEqual(state.read('cacert.pem',16384),certificate);
    assert.equal(state.authorization(),authorization);assert.notEqual(children[0].pid,children[1].pid);cases.push('packaged-explicit-restart');
    stage='unexpected-exit';assert.equal(children[1].kill('SIGTERM'),true);await until(()=>engine.current===null);reaped(children[1]);
    // Native SIGTERM closes listeners before completing cleanup. Either the
    // connection check or the child close event can observe the failure first.
    // Both must withdraw readiness and retain ownership until actual reaping.
    unexpectedExit={phase:engine.snapshot().phase,error:engine.snapshot().error,
      exitCode:children[1].exitCode,signalCode:children[1].signalCode};
    assert.equal(unexpectedExit.phase,'failed');
    assert.ok(['HOST_ENGINE_EXITED','HOST_ADMIN_UNAVAILABLE'].includes(unexpectedExit.error));
    assert.equal(unexpectedExit.exitCode,0);assert.equal(unexpectedExit.signalCode,null);cases.push('packaged-unexpected-exit');
    stage='close';await start();await engine.close();reaped(children[2]);
    assert.equal(children[2].exitCode,0);assert.equal(children[2].signalCode,null);assert.equal(engine.snapshot().phase,'closed');
    await assert.rejects(engine.start('Closed'),{code:'HOST_ENGINE_CLOSED'});cases.push('packaged-close');
    state.checkFiles();privateFiles=fs.readdirSync(directory).sort();
    assert.equal(process.env.HOME,originalHome);assert.deepEqual(protectedDirectories.map(snapshot),protectedBefore);
  }catch(error){
    // Do not print native logs, credentials, certificate material or state paths.
    console.error(JSON.stringify({stage,code:error.code || 'PACKAGED_HOST_ENGINE_CHECK_FAILED',phases,
      children:children.map(child=>({exitCode:child.exitCode,signalCode:child.signalCode}))}));throw error;
  }finally{
    await engine.close();
    for(const child of children)reaped(child);
    assert.deepEqual(protectedDirectories.map(snapshot),protectedBefore);
    assert.ok(base.startsWith(fs.realpathSync(os.tmpdir())+path.sep));
    assert.ok(path.basename(base).startsWith('cliprelay-packaged-host-engine-'));
    fs.rmSync(base,{recursive:true,force:true});
  }
  process.stdout.write(JSON.stringify({protocol:1,passed:true,cases,privateFiles,unexpectedExit,hostStarted:true,ownedChildrenReaped:true,
    stateFilesPrivate:true,defaultStateUnchanged:true,homeChanged:false,nativeRequestsExecuted:false,
    streamStarted:false,systemInputInjected:false,keychainValidated:false,
    scope:'Actual packaged engine startup, pinned authenticated process identity, EOF stop, explicit restart, unexpected exit and final close on disposable macOS CI. Startup display/encoder probes may run; no streaming client, system input, permission request, Keychain or user GUI acceptance.'})+'\n');
}
if(require.main===module){main().catch(()=>{process.exitCode=1;});}
