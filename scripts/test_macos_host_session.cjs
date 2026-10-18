'use strict';
// Disposable macOS CI only: actual packaged engine and companion, isolated
// private state and fixture encryption. No pairing approval or video client.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {snapshot,encryptedStorage}=require('./test_macos_host_state.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const deadline=Date.now()+25000;while(!predicate()){if(Date.now()>deadline)throw Error('PACKAGED_SESSION_WAIT_TIMEOUT');await pause(25);}}
async function main(){
  assert.equal(process.platform,'darwin');const appDirectory=path.resolve(process.argv[2]);
  const {HostState,configuration}=require(path.join(appDirectory,'host-state.cjs'));
  const {HostEngine}=require(path.join(appDirectory,'host-engine.cjs'));
  const {HostCompanion}=require(path.join(appDirectory,'host-companion.cjs'));
  const {HostSession}=require(path.join(appDirectory,'host-session.cjs'));
  const protectedDirectories=[path.join(os.homedir(),'.config','sunshine'),path.join(os.homedir(),'Library','Application Support','ClipRelay','host')];
  const protectedBefore=protectedDirectories.map(snapshot),originalHome=process.env.HOME;
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-packaged-host-session-')));
  const state=new HostState({directory:path.join(base,'Owned Mac host #1'),safeStorage:encryptedStorage()});
  const children=[],runtimes=[],cases=[],phases=[],sockets=[];let stage='prepare';
  const fixtureState={directory:state.directory,
    prepare(name){const result=state.prepare(name);state.write('sunshine.conf',configuration(name)+'bind_address = 127.0.0.1\n');return result;},
    environment:parent=>state.environment(parent),read:(file,limit)=>state.read(file,limit),authorization:()=>state.authorization(),
    companionInitialization:()=>state.companionInitialization(),close:()=>state.close()};
  function launch(role){return (file,args,settings)=>{
    assert.equal(settings.env.HOME,originalHome);const child=spawn(file,args,settings);children.push({role,child});return child;
  };}
  const pin=name=>JSON.parse(fs.readFileSync(path.join(appDirectory,name+'-pin.json'),'utf8'));
  const engine=new HostEngine({directory:path.join(appDirectory,'host-engine'),pin:pin('host-engine'),state:fixtureState,launch:launch('engine')});
  const companion=new HostCompanion({directory:path.join(appDirectory,'host-companion'),pin:pin('host-companion'),state:fixtureState,launch:launch('companion')});
  const fileTransfer=JSON.parse(fs.readFileSync(path.join(appDirectory,'host-companion','manifest.json'),'utf8')).fileTransfer===1;
  const clipboardExchange=JSON.parse(fs.readFileSync(path.join(appDirectory,'host-companion','manifest.json'),'utf8')).clipboardExchange===1;
  const session=new HostSession({engine,companion,onUpdate:value=>phases.push(value)});
  async function start(){
    assert.equal((await session.start('Packaged CI Mac')).phase,'running');
    assert.equal(engine.snapshot().phase,'running');assert.equal(companion.snapshot().phase,'running');
    assert.equal(session.snapshot().nativeWorkers,false);assert.equal(session.snapshot().fileTransfer,fileTransfer);assert.equal(session.snapshot().clipboardExchange,clipboardExchange);runtimes.push(path.dirname(companion.ipcPath()));
  }
  function reaped(){
    assert.equal(session.current,null);assert.equal(engine.current,null);assert.equal(companion.current,null);
    for(const {child} of children){assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);}
    for(const directory of runtimes)assert.equal(fs.existsSync(directory),false);
  }
  async function hold(options){
    const socket=net.createConnection(options);sockets.push(socket);socket.on('error',()=>{});await once(socket,'connect');
    socket.resume();return socket;
  }
  try{
    stage='both-start';await start();cases.push('packaged-engine-and-companion-start');
    const identity=state.id,certificate=state.read('cacert.pem',16384),authorization=state.authorization();
    assert.deepEqual(Object.keys(session.snapshot()).sort(),['clipboardExchange','error','fileTransfer','nativeWorkers','phase']);cases.push('public-snapshot-without-credentials-or-ipc');
    stage='active-listener-stop';const ipc=await hold({path:companion.ipcPath()}),tls=await hold({host:'127.0.0.1',port:48792});
    const ipcClosed=once(ipc,'close'),tlsClosed=once(tls,'close');
    await session.stop();await Promise.all([ipcClosed,tlsClosed]);reaped();cases.push('joined-eof-stop-with-open-listeners');
    stage='restart';await start();assert.equal(state.id,identity);assert.deepEqual(state.read('cacert.pem',16384),certificate);assert.equal(state.authorization(),authorization);
    assert.notEqual(runtimes[0],runtimes[1]);cases.push('explicit-restart-preserves-private-identity');
    stage='companion-exit';assert.equal(children.at(-1).child.kill('SIGTERM'),true);await until(()=>session.current===null);reaped();
    assert.equal(session.snapshot().phase,'failed');assert.equal(session.snapshot().error,'HOST_COMPANION_EXITED');cases.push('companion-exit-stops-engine');
    stage='engine-exit';await start();assert.equal(children.at(-2).child.kill('SIGTERM'),true);await until(()=>session.current===null);reaped();
    assert.equal(session.snapshot().phase,'failed');assert.ok(['HOST_ENGINE_EXITED','HOST_ADMIN_UNAVAILABLE'].includes(session.snapshot().error));cases.push('engine-exit-stops-companion');
    stage='final-close';await start();await session.close();reaped();assert.equal(session.snapshot().phase,'closed');
    await assert.rejects(session.start('Closed'),{code:'HOST_SESSION_CLOSED'});assert.throws(()=>state.authorization(),{code:'HOST_STATE_NOT_PREPARED'});
    cases.push('permanent-close-after-both-children-reaped');state.checkFiles();
    assert.deepEqual(protectedDirectories.map(snapshot),protectedBefore);assert.equal(process.env.HOME,originalHome);
  }catch(error){
    console.error(JSON.stringify({stage,code:error.code || 'PACKAGED_HOST_SESSION_CHECK_FAILED',phases,
      children:children.map(({role,child})=>({role,exitCode:child.exitCode,signalCode:child.signalCode}))}));throw error;
  }finally{
    for(const socket of sockets)socket.destroy();await session.close();
    for(const {child} of children)assert.ok(child.exitCode!==null || child.signalCode!==null);
    assert.deepEqual(protectedDirectories.map(snapshot),protectedBefore);
    assert.ok(base.startsWith(fs.realpathSync(os.tmpdir())+path.sep));assert.ok(path.basename(base).startsWith('cliprelay-packaged-host-session-'));
    fs.rmSync(base,{recursive:true,force:true});
  }
  process.stdout.write(JSON.stringify({protocol:1,passed:true,cases,actualChildStarts:children.length,ownedChildrenReaped:true,
    runtimeDirectoriesRemoved:true,stateFilesPrivate:true,defaultStateUnchanged:true,homeChanged:false,
    nativeWorkers:false,keychainValidated:false,nativeRequestsExecuted:false,streamStarted:false,systemInputInjected:false,
    scope:'Actual packaged engine plus companion ownership and failure propagation on disposable macOS CI. Fixture encryption; no permission requests, native auxiliary workers, pairing approval, stream, system input or user GUI acceptance.'})+'\n');
}
main().catch(()=>{process.exitCode=1;});
