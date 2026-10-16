'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {identities,fixture}=require('./mac-pairing-fixture.cjs');
const {pairHost}=require('../electron/mac/pairing.cjs');
const {message}=require('../electron/mac/paired-controller.cjs');
const feedback=require('../electron/mac/pairing-feedback.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const end=Date.now()+4000;while(!check()){assert.ok(Date.now()<end,'feedback test deadline');await delay(5);}}
const options=f=>({address:'127.0.0.1',name:'Feedback fixture',identity:f.client,ports:f.ports});

test('managed rejection, expiry and cancellation promptly join the waiting native exchange',async t=>{
  for(const [state,code] of [['rejected','PAIRING_REJECTED'],['expired','PAIRING_EXPIRED'],['cancelled','PAIRING_CANCELLED_REMOTE']])await t.test(state,async t=>{
    const f=await fixture({feedback:true});t.after(()=>f.close());
    const pairing=pairHost(options(f)),outcome=assert.rejects(pairing,{code});
    await until(()=>f.trace.includes('get-cert'));const started=Date.now();f.setFeedback(state);await outcome;
    assert.ok(Date.now()-started<2500);assert.equal(f.authorized,false);assert.equal(f.deleted,true);assert.equal(f.cancelReceipt,f.receipt);
    assert.deepEqual(f.trace,['get-cert']);const reads=f.statusReads;await delay(30);assert.equal(f.statusReads,reads);
    assert.notEqual(message({code}),message({code:'unknown'}));
  });
});
test('approving and handshake feedback cannot replace native certificate proof',async t=>{
  const f=await fixture({feedback:true});t.after(()=>f.close());const pairing=pairHost(options(f));
  await until(()=>f.statusReads>0&&f.trace.includes('get-cert'));f.setFeedback('approving');await until(()=>f.statusReads>=2);
  f.setFeedback('handshake');await until(()=>f.statusReads>=3);assert.equal(f.authorized,false);
  f.approve();assert.equal((await pairing).certificate,f.host.cert);assert.equal(f.authorized,true);assert.equal(f.deleted,true);
});
test('malformed or replaced feedback cannot advance the native proof',async t=>{
  for(const change of [{receipt:'0'.repeat(32)},{id:'0'.repeat(32)},{expires:1},{state:'paired'},{protocol:2},{extra:true}])await t.test(JSON.stringify(change),async t=>{
    const f=await fixture({feedback:true,onStatus:({res,value})=>res.end(JSON.stringify({...value,...change}))});t.after(()=>f.close());
    await assert.rejects(pairHost(options(f)),{code:'PAIRING_STATUS_INVALID'});assert.equal(f.authorized,false);assert.ok(!f.trace.includes('client-proof'));
  });
});
test('caller cancellation aborts an in-flight status read before pairing owner returns',async t=>{
  let closed=false;const f=await fixture({feedback:true,onStatus:({res})=>res.once('close',()=>closed=true)});t.after(()=>f.close());
  const abort=new AbortController(),pairing=pairHost({...options(f),signal:abort.signal}),outcome=assert.rejects(pairing,{code:'CANCELLED'});
  await until(()=>f.statusReads===1);abort.abort();await outcome;await until(()=>closed);
  assert.equal(f.deleted,true);assert.equal(f.authorized,false);
});
test('changed status TLS certificate receives no status HTTP or client proof',async t=>{
  const f=await fixture({feedback:true});t.after(()=>f.close());
  await assert.rejects(pairHost({...options(f),onVerification:()=>f.replaceCertificate(identities.wrong)}),{code:'HOST_CERT_CHANGED'});
  assert.equal(f.statusReads,0);assert.ok(!f.trace.includes('client-proof'));
});
test('unavailable advertised status fails explicitly; older hosts need no status endpoint',async t=>{
  const f=await fixture({feedback:true,onStatus:({res})=>{res.writeHead(404);res.end();}});t.after(()=>f.close());
  await assert.rejects(pairHost(options(f)),{code:'PAIRING_STATUS_UNAVAILABLE'});assert.equal(f.authorized,false);
  const old=await fixture();t.after(()=>old.close());old.approve();await pairHost(options(old));assert.equal(old.statusReads,0);assert.equal(old.authorized,true);
});
test('feedback capability rejects malformed metadata and never exposes private generation',()=>{
  assert.equal(feedback.ticket({}),null);
  for(const value of [null,{},[],{protocol:1,receipt:'bad'},{protocol:1,receipt:'a'.repeat(32),generation:'private'}])assert.throws(()=>feedback.ticket({feedback:value,expires:123}),{code:'PAIRING_STATUS_INVALID'});
  assert.throws(()=>feedback.ticket({feedback:{protocol:1,receipt:'a'.repeat(32)},expires:'123'}),{code:'PAIRING_STATUS_INVALID'});
});
test('transient status failures retry within a fixed bound without losing rejection',async t=>{
  for(const failures of [1,3]){
    let reads=0;const f=await fixture({feedback:true,onStatus:({res,value})=>{if(++reads<=failures)res.destroy();else res.end(JSON.stringify({...value,state:'rejected'}));}});t.after(()=>f.close());
    await assert.rejects(pairHost(options(f)),{code:failures===1?'PAIRING_REJECTED':'PAIRING_STATUS_UNAVAILABLE'});
    assert.equal(reads,Math.min(failures+1,3));assert.equal(f.authorized,false);assert.equal(f.deleted,true);
  }
});
