'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validate,CASES,SOURCES}=require('../audio_fixture/receipt.cjs');
const commit='a'.repeat(40),hash='b'.repeat(64),options={testCommit:commit,architecture:'x64',hostScope:'complete-app-host',applicationCommit:commit};
function valid(){
  let windows=2,samples=48000,frame=10;
  return {protocol:1,passed:true,testCommit:commit,applicationCommit:commit,architecture:'x64',hostScope:'complete-app-host',componentOnly:false,
    source:'owned-synthetic-tone',receiver:'standalone-opus-and-software-h264',productionPlaybackVerified:false,productionPermissionUIVerified:false,
    microphoneInjectionVerified:false,keychainValidated:false,audioSamplesSaved:false,encryptedRTSP:true,hostRequiresEncryption:true,
    hostAudioRequested:true,ownedChildrenReaped:true,cases:[...CASES],routeBefore:{output:48,input:49,rate:44100,frames:512},
    routeAfter:{output:48,input:49,rate:44100,frames:512},exits:[{exit:{code:0,signal:null},error:null},{exit:{code:0,signal:null},error:null}],
    ciAudioConsent:[],observations:[['quiet-baseline',0],['low',1000],['high',1600],['quiet',0]].map(([stage,frequency],i)=>{
      const afterWindow=windows;++windows;samples+=24000;
      return {stage,frequency,afterWindow,sourceCallbacks:(i+1)*100,windows:[0,1].map(()=>{
        ++windows;samples+=24000;frame+=10;return {received:frame,decoded:frame,ageMs:20,errors:0,
          audio:{packets:samples/240,samples,windows,ageMs:50,errors:0,low:frequency===1000?.04:0,high:frequency===1600?.04:0,rms:frequency?.028:0}};
      })};
    }),fixture:{protocol:1,testCommit:commit,architecture:'x64',commonCommit:'c'.repeat(40),libavcodecVersion:'63.1.101',libopusVersion:'1.6',
      binarySha256:{decoder:hash,tone:hash},sources:Object.fromEntries(SOURCES.map(name=>[name,hash]))}};
}
test('accepts fresh decoded tone transitions, process cleanup and unchanged routes',()=>validate(valid(),options));
test('rejects empty Opus streams even with passing video and success flags',()=>{
  const value=valid();value.observations[0].windows[0].audio.packets=0;assert.throws(()=>validate(value,options));
});
test('rejects frozen windows and repeated old samples',()=>{
  for(const field of ['windows','samples']){const value=valid(),phase=value.observations[1];phase.windows[1].audio[field]=phase.windows[0].audio[field];assert.throws(()=>validate(value,options));}
});
test('rejects wrong frequency, lingering feedback, NaN and missing quiet recovery',()=>{
  for(const change of [v=>v.observations[1].windows[0].audio.low=0,v=>v.observations[2].windows[0].audio.low=.04,
    v=>v.observations[1].windows[0].audio.rms=NaN,v=>v.observations[3].windows[0].audio.rms=.02]){
    const value=valid();change(value);assert.throws(()=>validate(value,options));
  }
});
test('rejects component evidence, stale binaries and unsupported shipping claims',()=>{
  for(const change of [v=>v.componentOnly=true,v=>v.hostScope='development-components',v=>v.fixture.testCommit='d'.repeat(40),
    v=>v.fixture.architecture='arm64',v=>delete v.fixture.sources[SOURCES[0]],v=>v.productionPlaybackVerified=true,v=>v.productionPermissionUIVerified=true]){
    const value=valid();change(value);assert.throws(()=>validate(value,options));
  }
});
test('rejects changed default routes, incomplete cleanup and unencrypted transport',()=>{
  for(const change of [v=>v.routeAfter.rate=48000,v=>v.exits[0].exit.signal='SIGKILL',v=>v.ownedChildrenReaped=false,v=>v.hostRequiresEncryption=false]){
    const value=valid();change(value);assert.throws(()=>validate(value,options));
  }
});
test('rejects consent actions without exact owned-dialog identification',()=>{
  const value=valid();value.ciAudioConsent=[{event:'audio-consent',ownedEngineVerified:true,scope:'disposable-CI-hosted-compute-agent-system-audio',
    pressed:true,trusted:true,attempted:true,candidates:2,actionStatus:0}];assert.throws(()=>validate(value,options));
});
