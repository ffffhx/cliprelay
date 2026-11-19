'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {StreamStatistics}=require('../electron/mac/stream-statistics.cjs');
const sample=(elapsedMs,receivedFrames,renderedFrames,videoBytes)=>({elapsedMs,receivedFrames,renderedFrames,videoBytes});
test('measures actual frames and video bytes over native time, independent of pipe arrival time',()=>{
  const s=new StreamStatistics();
  assert.equal(s.update(sample(500,10,8,10000),100),true);
  assert.equal(s.snapshot(100).phase,'loading');
  // Multiple reports can arrive together; native sample time still spans 1 s.
  assert.equal(s.update(sample(1500,70,53,1510000),100),true);
  assert.deepEqual(s.snapshot(100),{phase:'live',bitrateMbps:12,fps:45});
  assert.equal(s.update(sample(2500,70,53,1510000),1100),true);
  assert.deepEqual(s.snapshot(1100),{phase:'live',bitrateMbps:0,fps:0});
});
test('stale and discontinuous measurements become unavailable and recover with a fresh interval',()=>{
  const s=new StreamStatistics();s.update(sample(0,0,0,0),0);s.update(sample(1000,60,60,1000000),1000);
  assert.deepEqual(s.snapshot(4000),{phase:'stale',bitrateMbps:null,fps:null});
  s.update(sample(9000,500,490,8000000),9000);assert.equal(s.snapshot(9000).phase,'loading');
  s.update(sample(10000,560,550,9000000),10000);assert.deepEqual(s.snapshot(10000),{phase:'live',bitrateMbps:8,fps:60});
});
test('rejects invalid or regressing native counters before publishing rates',()=>{
  for(const bad of [sample(-1,0,0,0),sample(1,1,2,0),sample(1,1,1,Infinity),sample(1,1,1,1.5),sample(1,1,1,Number.MAX_SAFE_INTEGER+1)])assert.equal(new StreamStatistics().update(bad,0),false);
  for(const bad of [sample(100,20,15,500),sample(101,19,15,500),sample(101,20,14,500),sample(101,20,15,499)]){
    const s=new StreamStatistics();s.update(sample(100,20,15,500),0);assert.equal(s.update(bad,100),false);
  }
});
