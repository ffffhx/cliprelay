'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {request}=require('../electron/mac/clipboard-protocol.cjs');
const host={address:'127.0.0.1',port:10,certificate:'pin'},identity={key:'key',cert:'client'},revision='a'.repeat(64),next='b'.repeat(64);
test('versioned clipboard uses the selected TLS pin and validates unchanged observations',async()=>{
  const controller=new AbortController();
  const result=await request(host,identity,{op:'observe',revision},controller.signal,async options=>{assert.equal(options.trust.cert,host.certificate);assert.equal(options.identity,identity);assert.equal(options.signal,controller.signal);assert.equal(options.port,12);assert.equal(options.path,'/v1/clipboard');assert.deepEqual(options.body,{op:'observe',revision});return {ok:true,revision,changed:false};});
  assert.deepEqual(result,{revision,changed:false});
  assert.deepEqual(await request(host,identity,{op:'observe',revision},null,async()=>({ok:true,revision:next,changed:true,kind:'text',text:'new text'})),{revision:next,changed:true,payload:{kind:'text',text:'new text'}});
});
test('invalid observations cannot masquerade as unchanged, disclose extra fields or revive an old revision',async()=>{
  for(const result of [{ok:true,changed:false,revision:next},{ok:true,changed:false,revision,text:'unexpected'},{ok:true,changed:true,revision,kind:'text',text:'old'},{ok:true,changed:true,revision:next,kind:'empty',data:'unexpected'},{ok:true,changed:true,revision:'bad',kind:'empty'},{ok:true,changed:true,revision:next,kind:'text',text:'new',private:'field'}]){
    await assert.rejects(request(host,identity,{op:'observe',revision},null,async()=>result));
  }
});
test('old hosts and conflict responses never cause an unconditional automatic write',async()=>{
  let calls=0;await assert.rejects(request(host,identity,{op:'observe'},null,async()=>{calls++;return {ok:false,code:'CLIPBOARD_BAD_REQUEST'};}),{code:'CLIPBOARD_SYNC_UNSUPPORTED'});assert.equal(calls,1);
  await assert.rejects(request(host,identity,{op:'write',id:'c'.repeat(32),kind:'text',text:'x'},null,()=>assert.fail('missing precondition reached network')),{code:'INVALID_CLIPBOARD'});
  await assert.rejects(request(host,identity,{op:'write',id:'c'.repeat(32),kind:'text',text:'x',expect:revision},null,async()=>{calls++;return {ok:false,code:'CLIPBOARD_CHANGED'};}),{code:'CLIPBOARD_CHANGED'});assert.equal(calls,2);
});
