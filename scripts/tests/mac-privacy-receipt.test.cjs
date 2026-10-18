'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validate}=require('../privacy_fixture/receipt.cjs');
const commit='a'.repeat(40),hash='b'.repeat(64),options={testCommit:commit,architecture:'x64',hostScope:'complete-app-host'};
function valid(){return {passed:true,decodedPixelsVerified:true,decoder:'standalone-software-h264',productionQtPixelsVerified:false,
  hostScope:'complete-app-host',source:'owned-solid-color-window',screenContentSaved:false,encryptedRTSP:true,hostRequiresVideoEncryption:true,
  localSampleSize:[16,16],decodedSampleCount:9,
  observations:[{stage:'before',remote:'red',local:'red',frame:7,generation:11},
    {stage:'masked',remote:'green',local:'black',frame:15,generation:12,firstFrame:12},
    {stage:'restored',remote:'blue',local:'blue',frame:23,generation:13}],
  fixture:{protocol:1,testCommit:commit,architecture:'x64',commonCommit:'c'.repeat(40),libavcodecVersion:'62.11.100',
    binarySha256:{decoder:hash,colors:hash},sources:Object.fromEntries(['scripts/privacy_fixture/decode.c','scripts/privacy_fixture/colors.mm',
      'scripts/privacy_fixture/CMakeLists.txt','scripts/build_privacy_pixel_fixtures.py','engine/desktop-client/upstream.json'].map(name=>[name,hash]))}};}
test('accepts fresh decoded changes and opposite local masking from matching native fixture',()=>validate(valid(),options));
test('rejects frozen pre-mask frames even when a report claims success',()=>{
  const v=valid();v.observations[1].frame=7;assert.throws(()=>validate(v,options));
});
test('rejects black remote output or a visible local source during masking',()=>{
  for(const [key,color] of [['remote','black'],['local','green']]){const v=valid();v.observations[1][key]=color;assert.throws(()=>validate(v,options));}
});
test('rejects unchanged capture generation and missing restoration',()=>{
  const v=valid();v.observations[1].generation=11;assert.throws(()=>validate(v,options));
  const missing=valid();missing.observations.pop();assert.throws(()=>validate(missing,options));
});
test('rejects a component-only receipt presented as complete-app evidence',()=>{
  const v=valid();v.hostScope='development-components';assert.throws(()=>validate(v,options));
});
test('rejects stale fixture commit, wrong architecture or missing native source provenance',()=>{
  for(const change of [v=>v.fixture.testCommit='d'.repeat(40),v=>v.fixture.architecture='arm64',v=>delete v.fixture.sources['scripts/privacy_fixture/decode.c']]){
    const v=valid();change(v);assert.throws(()=>validate(v,options));
  }
});
test('rejects unencrypted transport and unsupported Qt pixel claims',()=>{
  for(const change of [v=>v.encryptedRTSP=false,v=>v.hostRequiresVideoEncryption=false,v=>v.productionQtPixelsVerified=true]){
    const v=valid();change(v);assert.throws(()=>validate(v,options));
  }
});
