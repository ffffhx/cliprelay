'use strict';
const assert=require('node:assert/strict');
const {AudioMuteController}=require('../electron/mac/audio-mute-controller.cjs');
const {PrivacyController}=require('../electron/mac/privacy-controller.cjs');
const protocol=require('../electron/mac/audio-mute-protocol.cjs');
const {jsonRequest}=require('../electron/mac/paired-transport.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<500;i++){if(check())return;await delay(10);}throw Error('audio fixture deadline');}
async function main(){
  let raw='';for await(const chunk of process.stdin)raw+=chunk;
  const {host,identity}=JSON.parse(raw);
  const store={host,selected(){return this.host;},async identity(){return identity;}};
  const viewer={session:{host:{...host},telemetry:true},currentSession(){return this.session;},
    snapshot(){return {progress:{received:200,rendered:200,width:1280,height:720,receivedAgeMs:0,renderedAgeMs:0}};},reconcile(code){throw Error(code);}};
  let renews=0;
  const audio=new AudioMuteController({store,viewer,pollMs:20,renewMs:80,request:async(...args)=>{const value=await protocol.request(...args);if(args[2]==='renew')renews++;return value;}});
  const privacy=new PrivacyController({store,viewer,pollMs:20,renewMs:80});
  const set=(controller,enabled)=>controller.setEnabled({viewId:controller.snapshot().viewId,enabled});
  const fixture=kind=>jsonRequest({address:host.address,port:host.port+2,path:'/fixture/'+kind,method:'POST',body:{},identity,trust:{cert:host.certificate},timeout:2000});
  let stage='initial-readiness';
  try{
    audio.reconcile();privacy.reconcile();await until(()=>audio.snapshot().canEnable&&privacy.snapshot().canEnable);
    stage='initial-enable-and-renew';
    set(privacy,true);set(audio,true);await until(()=>privacy.snapshot().active&&audio.snapshot().active&&renews>=2);
    stage='hold-recovery';
    await fixture('hold-recovery');set(audio,false);await until(()=>audio.snapshot().error==='AUDIO_RECOVERY_PENDING');
    assert.equal(audio.snapshot().phase,'restoring');assert.equal(audio.snapshot().canEnable,false);assert.equal(privacy.snapshot().active,true);
    stage='release-recovery';
    await fixture('release-recovery');await until(()=>audio.snapshot().canEnable);assert.equal(privacy.snapshot().active,true);
    stage='second-enable';
    set(audio,true);await until(()=>audio.snapshot().active);
    stage='capture-generation-change';
    const viewId=audio.snapshot().viewId;await fixture('new-audio');await until(()=>audio.snapshot().canEnable);
    assert.equal(audio.snapshot().active,false);assert.equal(privacy.snapshot().active,true);assert.notEqual(audio.snapshot().viewId,viewId);
    stage='third-enable';
    set(audio,true);await until(()=>audio.snapshot().active);
    stage='route-replacement';
    store.host={...host,routeId:'replacement'};viewer.session={host:{...store.host},telemetry:true};audio.reconcile();privacy.reconcile();
    await until(()=>audio.snapshot().canEnable&&privacy.snapshot().canEnable);assert.equal(audio.snapshot().active,false);assert.equal(privacy.snapshot().active,false);
    console.log(JSON.stringify({passed:true,independent:true,generationRestored:true,recoveryPending:true}));
  }catch(error){
    // Only public controller state and source locations: never log the input
    // fixture object, which carries the disposable client's private key.
    console.error(JSON.stringify({stage,code:error.code || error.name,audio:audio.snapshot(),privacy:privacy.snapshot(),renews,
      locations:String(error.stack || '').split('\n').filter(line=>/^\s+at /.test(line)).slice(0,3)}));throw error;
  }finally{await Promise.all([audio.close(),privacy.close()]);}
}
main().catch(()=>{console.error('desktop audio fixture failed');process.exitCode=1;});
