'use strict';
const assert=require('node:assert/strict');
const CASES=['paired-host-actual-encrypted-video-and-opus-packets','fresh-decoded-silence-1000Hz-1600Hz-silence',
  'receiver-EOF-releases-native-stream','default-audio-devices-rate-and-buffer-preserved',
  'owned-processes-reaped-and-default-profile-preserved'];
const SOURCES=['scripts/privacy_fixture/decode.c','scripts/audio_fixture/opus.h','scripts/audio_fixture/tone.mm',
  'scripts/audio_fixture/CMakeLists.txt','scripts/build_macos_audio_fixture.py','engine/desktop-client/upstream.json'];
function validate(value,{testCommit,architecture,hostScope,applicationCommit=null}){
  assert.equal(value?.protocol,1);assert.equal(value.passed,true);assert.equal(value.testCommit,testCommit);
  assert.equal(value.architecture,architecture);assert.equal(value.hostScope,hostScope);
  assert.ok(['development-components','complete-app-host'].includes(hostScope));
  assert.equal(value.componentOnly,hostScope==='development-components');assert.equal(value.applicationCommit,applicationCommit);
  if(hostScope==='complete-app-host')assert.equal(applicationCommit,testCommit);
  assert.equal(value.source,'owned-synthetic-tone');assert.equal(value.receiver,'standalone-opus-and-software-h264');
  for(const key of ['productionPlaybackVerified','productionPermissionUIVerified','microphoneInjectionVerified','keychainValidated','audioSamplesSaved'])
    assert.equal(value[key],false);
  for(const key of ['encryptedRTSP','hostRequiresEncryption','hostAudioRequested','ownedChildrenReaped'])assert.equal(value[key],true);
  assert.equal(value.failure,undefined);assert.equal(value.cleanupErrors,undefined);assert.deepEqual(value.cases,CASES);
  assert.deepEqual(value.routeAfter,value.routeBefore);
  assert.deepEqual(Object.keys(value.routeBefore).sort(),['frames','input','output','rate']);
  for(const n of Object.values(value.routeBefore))assert.ok(Number.isSafeInteger(n)&&n>0);
  assert.equal(value.exits?.length,2);
  for(const exit of value.exits)assert.deepEqual(exit,{exit:{code:0,signal:null},error:null});
  assert.ok(Array.isArray(value.ciAudioConsent)&&value.ciAudioConsent.length<=8);
  assert.ok(value.ciAudioConsent.filter(v=>v.pressed===true).length<=1);
  for(const decision of value.ciAudioConsent){
    assert.equal(decision.event,'audio-consent');assert.equal(decision.ownedEngineVerified,true);
    assert.equal(decision.scope,'disposable-CI-hosted-compute-agent-system-audio');
    if(decision.pressed){assert.equal(decision.trusted,true);assert.equal(decision.attempted,true);assert.equal(decision.candidates,1);assert.equal(decision.actionStatus,0);}
  }
  assert.deepEqual(value.observations?.map(v=>[v.stage,v.frequency]),[['quiet-baseline',0],['low',1000],['high',1600],['quiet',0]]);
  let lastWindow=0,lastSamples=0,lastFrame=0,lastSource=0;
  for(const phase of value.observations){
    assert.ok(Number.isSafeInteger(phase.afterWindow)&&phase.afterWindow>=lastWindow);
    assert.ok(Number.isSafeInteger(phase.sourceCallbacks)&&phase.sourceCallbacks>lastSource);lastSource=phase.sourceCallbacks;
    assert.equal(phase.windows?.length,2);
    for(const window of phase.windows){
      assert.ok(Number.isSafeInteger(window.decoded)&&window.decoded>lastFrame);
      assert.ok(Number.isSafeInteger(window.received)&&window.received>=window.decoded);
      assert.ok(Number.isSafeInteger(window.ageMs)&&window.ageMs>=0&&window.ageMs<2000);assert.equal(window.errors,0);
      const a=window.audio;assert.equal(a.errors,0);
      assert.ok(Number.isSafeInteger(a.windows)&&a.windows>lastWindow&&a.windows>=phase.afterWindow+2);
      assert.ok(Number.isSafeInteger(a.samples)&&a.samples>lastSamples&&a.samples>=a.windows*24000);
      assert.ok(Number.isSafeInteger(a.packets)&&a.packets>0);
      assert.ok(Number.isSafeInteger(a.ageMs)&&a.ageMs>=0&&a.ageMs<1000);
      for(const key of ['low','high','rms'])assert.ok(Number.isFinite(a[key])&&a[key]>=0);
      if(phase.frequency===0)assert.ok(a.low<.001&&a.high<.001&&a.rms<.001);
      else{
        const [target,other]=phase.frequency===1000?['low','high']:['high','low'];
        assert.ok(a[target]>.005&&a[other]<a[target]*.15&&a.rms>.003);
      }
      lastWindow=a.windows;lastSamples=a.samples;lastFrame=window.decoded;
    }
  }
  const fixture=value.fixture;assert.equal(fixture?.protocol,1);assert.equal(fixture.testCommit,testCommit);
  assert.equal(fixture.architecture,architecture);assert.match(fixture.commonCommit,/^[a-f0-9]{40}$/);
  for(const key of ['libavcodecVersion','libopusVersion'])assert.match(fixture[key],/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/);
  assert.deepEqual(Object.keys(fixture.sources).sort(),[...SOURCES].sort());
  for(const hash of Object.values(fixture.sources))assert.match(hash,/^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(fixture.binarySha256).sort(),['decoder','tone']);
  for(const hash of Object.values(fixture.binarySha256))assert.match(hash,/^[a-f0-9]{64}$/);
}
module.exports={validate,CASES,SOURCES};
