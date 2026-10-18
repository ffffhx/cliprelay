'use strict';
const assert=require('node:assert/strict');
const PIXEL_CASE='owned-color-decoded-through-encrypted-stream-while-local-display-masked';
function validate(value,{testCommit,architecture,hostScope}){
  assert.equal(value?.passed,true);assert.equal(value.decodedPixelsVerified,true);
  assert.equal(value.decoder,'standalone-software-h264');assert.equal(value.productionQtPixelsVerified,false);
  assert.equal(value.hostScope,hostScope);assert.equal(value.source,'owned-solid-color-window');
  assert.equal(value.screenContentSaved,false);assert.equal(value.encryptedRTSP,true);assert.equal(value.hostRequiresVideoEncryption,true);
  assert.deepEqual(value.localSampleSize,[16,16]);assert.equal(value.decodedSampleCount,9);
  assert.equal(value.observations?.length,3);const [before,masked,restored]=value.observations;
  assert.deepEqual(value.observations.map(v=>v.stage),['before','masked','restored']);
  assert.deepEqual(value.observations.map(v=>v.remote),['red','green','blue']);
  assert.deepEqual(value.observations.map(v=>v.local),['red','black','blue']);
  for(const v of value.observations)for(const name of ['frame','generation'])assert.ok(Number.isSafeInteger(v[name])&&v[name]>0);
  assert.ok(before.generation<masked.generation&&masked.generation<restored.generation);
  assert.ok(Number.isSafeInteger(masked.firstFrame)&&before.frame<masked.firstFrame&&masked.firstFrame<=masked.frame&&masked.frame<restored.frame);
  const fixture=value.fixture;assert.equal(fixture?.protocol,1);assert.equal(fixture.testCommit,testCommit);
  assert.equal(fixture.architecture,architecture);assert.match(fixture.commonCommit,/^[a-f0-9]{40}$/);
  assert.match(fixture.libavcodecVersion,/^[0-9]+\.[0-9]+\.[0-9]+$/);
  assert.deepEqual(Object.keys(fixture.sources).sort(),['scripts/privacy_fixture/decode.c','scripts/privacy_fixture/colors.mm',
    'scripts/privacy_fixture/CMakeLists.txt','scripts/build_privacy_pixel_fixtures.py','engine/desktop-client/upstream.json'].sort());
  for(const hash of Object.values(fixture.sources))assert.match(hash,/^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(fixture.binarySha256).sort(),['colors','decoder']);
  for(const hash of Object.values(fixture.binarySha256))assert.match(hash,/^[a-f0-9]{64}$/);
}
module.exports={validate,PIXEL_CASE};
