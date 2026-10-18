'use strict';
// Disposable native CI: real paired transport, original worker windows and
// filtered encoded generations. This does not inspect decoded client pixels.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const CASES=['paired-privacy-filtered-encoding-renew-stop','paired-privacy-expiry-without-client-requests',
  'paired-privacy-revocation-reaps-native-mask'];
const REPEAT_CASE='paired-privacy-repeated-native-activation-and-recovery';
function create({directory,base,nativeChildren,hostState,admin,first,second,identities,until,report,setStage}){
  assert.equal(process.platform,'darwin');assert.equal(process.env.GITHUB_ACTIONS,'true');
  const protocol=require(path.join(directory,'privacy-protocol.cjs'));
  const {jsonRequest}=require(path.join(directory,'paired-transport.cjs'));
  const binary=path.join(directory,'host-companion/runtime/cliprelay-host-network');
  const companion=nativeChildren.find(child=>child.spawnfile===binary);
  assert.ok(companion&&companion.exitCode===null);
  const auditor=path.join(base,'audit-privacy-windows');
  const built=spawnSync('/usr/bin/clang++',['-fobjc-arc',path.join(__dirname,'privacy_fixture/audit.mm'),
    '-framework','Foundation','-framework','CoreGraphics','-o',auditor],{encoding:'utf8',timeout:60000});
  assert.equal(built.status,0,'PRIVACY_AUDITOR_BUILD_FAILED');
  const engine=()=>jsonRequest({address:'127.0.0.1',port:48790,path:'/api/cliprelay/privacy',method:'GET',
    identity:identities.wrong,trust:{cert:second.certificate},headers:{Authorization:hostState.authorization()},timeout:3000,limit:8192});
  function workers(){
    assert.equal(companion.exitCode,null);assert.equal(companion.signalCode,null);
    const children=spawnSync('/usr/bin/pgrep',['-P',String(companion.pid)],{encoding:'utf8',timeout:3000});
    assert.ok(children.status===0||children.status===1);
    if(children.status===1)return [];
    const pids=children.stdout.trim().split(/\s+/);assert.ok(pids.every(pid=>/^[1-9][0-9]*$/.test(pid)));
    const inspected=spawnSync('/bin/ps',['-ww','-o','pid=,ppid=,command=','-p',pids.join(',')],{encoding:'utf8',timeout:3000});
    assert.ok(inspected.status===0||inspected.status===1);
    return inspected.stdout.split('\n').flatMap(line=>{
      const value=line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
      return value&&Number(value[2])===companion.pid&&value[3].startsWith(binary+' --managed-privacy --owner-pid '+companion.pid+' --state-dir ')?[Number(value[1])]:[];
    });
  }
  function masks(pid){
    const result=spawnSync(auditor,[String(pid)],{encoding:'utf8',timeout:3000,maxBuffer:16384});
    assert.equal(result.status,0,'PRIVACY_WINDOW_AUDIT_FAILED');
    return JSON.parse(result.stdout);
  }
  const progress=receiver=>{assert.equal(receiver.exit,null);assert.equal(receiver.error,null);return receiver.events.filter(e=>e.event==='progress').at(-1);};
  const record=report.privacy={passed:false,actualEncodedReadiness:false,decodedPixelsVerified:false,screenContentSaved:false,cycles:[],repetitions:[]};
  async function start(receiver,observations=record.cycles){
    const before=await admin();assert.equal(before.phase,'active');assert.equal(before.streams.length,1);
    const binding={instance:before.instance,stream:before.streams[0].id,lease:crypto.randomBytes(16).toString('hex')};
    const started=Date.now(),state=await protocol.request(first,identities.client,'start',binding);
    const acknowledged=Date.now();
    assert.equal(state.active,true);assert.equal(state.lease,binding.lease);
    const filtered=await engine();
    assert.equal(filtered.authorized,true);assert.equal(filtered.ready,true);assert.equal(filtered.lease,binding.lease);
    assert.equal(filtered.stream,binding.stream);assert.ok(filtered.generation>before.generation&&filtered.firstFrame>0);
    const original=workers();assert.equal(original.length,1);
    const windows=masks(original[0]);assert.ok(windows.length>0&&windows.every(window=>window.onScreen&&window.alpha>0));
    const received=progress(receiver).received;
    const flowing=await until(()=>progress(receiver),value=>value?.received>received+3&&value.received>=filtered.firstFrame,5000);
    const observed={activationMs:Date.now()-started,remainingMs:state.expiresMs,generation:filtered.generation,
      firstFrame:filtered.firstFrame,received:flowing.received,maskWindows:windows.length};
    observations.push(observed);record.actualEncodedReadiness=true;
    return {binding,pid:original[0],filtered,observed,acknowledged};
  }
  async function restored(receiver,held){
    await until(()=>workers(),value=>!value.includes(held.pid),6000);
    assert.equal(masks(held.pid).length,0);
    await until(engine,value=>!value.retained&&!value.authorized&&!value.ready,6000);
    if(receiver){
      const state=await until(admin,value=>value.phase==='active'&&value.generation>held.filtered.generation&&
        value.streams.length===1&&value.streams[0].id===held.binding.stream&&value.streams[0].firstFrame>0,10000);
      await until(()=>progress(receiver),value=>value?.rendered>=state.streams[0].firstFrame&&value.renderedAgeMs<2000,10000);
      held.observed.recoveredGeneration=state.generation;held.observed.recoveredFrame=state.streams[0].firstFrame;
    }
  }
  return {
    async exercise(receiver){
      setStage('privacy-renew-stop');
      const held=await start(receiver),renewed=await protocol.request(first,identities.client,'renew',held.binding);
      assert.equal(renewed.active,true);assert.equal(renewed.lease,held.binding.lease);assert.deepEqual(workers(),[held.pid]);
      const stopped=await protocol.request(first,identities.client,'stop',held.binding);assert.equal(stopped.active,false);
      await restored(receiver,held);report.cases.push(CASES[0]);
      for(let cycle=0;cycle<3;cycle++){
        setStage('privacy-repeated-activation-'+(cycle+1));
        const repeated=await start(receiver,record.repetitions);
        const restoredState=await protocol.request(first,identities.client,'stop',repeated.binding);assert.equal(restoredState.active,false);
        await restored(receiver,repeated);assert.deepEqual(workers(),[]);
      }
      report.cases.push(REPEAT_CASE);
      setStage('privacy-independent-expiry');
      const expired=await start(receiver);
      // These are native process observations, not public status/renew calls.
      await until(()=>workers(),value=>!value.includes(expired.pid),20000);
      expired.observed.expiryMs=Date.now()-expired.acknowledged;
      assert.ok(expired.observed.expiryMs>=expired.observed.remainingMs-1000,'PRIVACY_ENDED_BEFORE_EXPIRY');
      await restored(receiver,expired);
      await assert.rejects(protocol.request(first,identities.client,'renew',expired.binding),{code:'PRIVACY_EXPIRED'});
      await assert.rejects(protocol.request(first,identities.client,'start',expired.binding),{code:'PRIVACY_EXPIRED'});
      assert.deepEqual(workers(),[]);report.cases.push(CASES[1]);
      setStage('privacy-before-revocation');return start(receiver);
    },
    async revoked(held){
      await restored(null,held);report.cases.push(CASES[2]);record.passed=true;
    }
  };
}
module.exports={create,CASES,REPEAT_CASE};
