'use strict';
// Shared by actual installed Windows and packaged Mac acceptance. All identities
// and endpoints belong to the disposable CI fixture, never the user's host.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate,timeout=7000){
  const deadline=Date.now()+timeout;
  while(true){const value=await read();if(predicate(value))return value;if(Date.now()>deadline)throw Error('NATIVE_CLEANUP_WAIT_TIMEOUT');await pause(30);}
}
function nativeWaiter(exchange,identity,id,{managed=true,signal,timeout=135000}={}){
  const query=new URLSearchParams({uniqueid:id,uuid:crypto.randomUUID(),devicename:'Disposable native cleanup fixture',
    updateState:'1',phrase:'getservercert',salt:crypto.randomBytes(16).toString('hex'),clientcert:Buffer.from(identity.cert).toString('hex'),
    ...(managed?{cliprelay_pairing:id}:{})});
  return exchange({address:'127.0.0.1',port:48789,path:'/pair?'+query,method:'GET',plain:true,signal,timeout,limit:32768});
}
async function verifyNativeCleanup({jsonRequest,exchange,identity,listNative,listManaged,reject}){
  const trust={bootstrap:true},base={address:'127.0.0.1',port:48792,identity,trust,timeout:4000,limit:2048};
  const fingerprint=crypto.createHash('sha256').update(new crypto.X509Certificate(identity.cert).raw).digest('hex');
  const reports=[];let previous;
  for(const reason of ['reject','client-cancel','expire']){
    // A successful old cleanup can finish just after its public status changes.
    // A conflict is the documented response while that generation is reserved.
    const ticket=await until(async()=>{
      try{return await jsonRequest({...base,path:'/v1/pair',headers:{'X-ClipRelay-Pairing-Feedback':'1','X-ClipRelay-Pairing-Native':'1'},
        body:{name:'Native cleanup '+reason,nonce:'e'.repeat(32),pin:'1234'}});}
      catch(error){if(error.code==='HTTP_409')return null;throw error;}
    },value=>value!==null);
    assert.equal(ticket.native.protocol,1);assert.match(ticket.native.id,/^[0-9a-f]{32}$/);
    if(previous){
      assert.equal(ticket.id,previous.id);assert.notEqual(ticket.native.id,previous.native.id);
      await assert.rejects(exchange({...base,path:'/v1/pair/'+ticket.id,method:'DELETE',headers:{'X-ClipRelay-Pairing-Receipt':previous.feedback.receipt}}),{code:'UPDATE_HOST'});
    }
    const owner=new AbortController();let ended=false;
    const waiting=nativeWaiter(exchange,identity,ticket.native.id,{signal:owner.signal}).then(value=>{ended=true;return {value};},error=>{ended=true;return {error};});
    try{
      const native=await until(listNative,entries=>entries.some(entry=>entry.managed_id===ticket.native.id));
      const entry=native.find(entry=>entry.managed_id===ticket.native.id);
      assert.equal(entry.client_fingerprint,fingerprint);assert.equal(ended,false,'Native response must actually be waiting');
      const local=(await listManaged()).find(entry=>entry.id===ticket.id);assert.ok(local);
      const start=Date.now();
      if(reason==='reject')await reject(local);
      if(reason==='client-cancel')await exchange({...base,path:'/v1/pair/'+ticket.id,method:'DELETE',headers:{'X-ClipRelay-Pairing-Receipt':ticket.feedback.receipt},acceptStatuses:[204]});
      const state=reason==='reject'?'rejected':reason==='expire'?'expired':'cancelled';
      await until(()=>jsonRequest({...base,path:'/v1/pair/status',body:{id:ticket.id,receipt:ticket.feedback.receipt}}),value=>value.state===state,reason==='expire'?125000:7000);
      const feedbackAt=Date.now();
      await until(()=>ended,value=>value,5000);
      const result=await waiting;if(result.error)throw result.error;
      assert.match(result.value,/<root\b[^>]*status_code="(?:400|408)"/);assert.match(result.value,/<paired>0<\/paired>/);
      await until(listNative,entries=>!entries.some(entry=>entry.managed_id===ticket.native.id));
      const elapsed=Date.now()-start;
      if(reason==='expire')assert.ok(elapsed>=110000 && elapsed<130000);else assert.ok(elapsed<5000);
      const late=await nativeWaiter(exchange,identity,ticket.native.id,{timeout:3000});
      assert.match(late,/<root\b[^>]*status_code="403"/);assert.match(late,/<paired>0<\/paired>/);
      assert.equal((await listNative()).some(entry=>entry.managed_id===ticket.native.id),false);
      reports.push({reason,elapsedMs:elapsed,responseAfterFeedbackMs:Date.now()-feedbackAt,heldNativeResponseCompleted:true,lateNativeRequestRefused:true});
    }finally{owner.abort();await waiting;}
    previous=ticket;
  }
  return {protocol:1,passed:true,cases:reports,freshNativeIdentityOnNonceReuse:true,staleReceiptRefused:true};
}
async function holdManagedPairing({jsonRequest,exchange,identity,listNative}){
  const ticket=await jsonRequest({address:'127.0.0.1',port:48792,path:'/v1/pair',identity,trust:{bootstrap:true},timeout:4000,limit:2048,
    headers:{'X-ClipRelay-Pairing-Feedback':'1','X-ClipRelay-Pairing-Native':'1'},
    body:{name:'Owner shutdown cleanup fixture',nonce:crypto.randomBytes(16).toString('hex'),pin:'1234'}});
  assert.equal(ticket.native.protocol,1);
  const owner=new AbortController();let ended=false;
  const waiting=nativeWaiter(exchange,identity,ticket.native.id,{signal:owner.signal})
    .then(value=>{ended=true;return {value};},error=>{ended=true;return {error};});
  try{
    await until(listNative,entries=>entries.some(entry=>entry.managed_id===ticket.native.id));assert.equal(ended,false);
    return {abort:()=>owner.abort(),waiting,async verify(){
      await until(()=>ended,value=>value,5000);const result=await waiting;if(result.error)throw result.error;
      assert.match(result.value,/<root\b[^>]*status_code="400"/);assert.match(result.value,/<paired>0<\/paired>/);return true;
    }};
  }catch(error){owner.abort();await waiting;throw error;}
}
async function verifyAutonomousExpiry({exchange,identity,register,abandon,listNative,engineIdentity,readTrust}){
  const engine=await engineIdentity(),trust=await readTrust(),started=Date.now();
  const id=await register();assert.match(id,/^[0-9a-f]{32}$/);
  const owner=new AbortController();let ended=false;
  const waiting=nativeWaiter(exchange,identity,id,{signal:owner.signal})
    .then(value=>{ended=true;return {value};},error=>{ended=true;return {error};});
  try{
    await until(listNative,entries=>entries.some(entry=>entry.managed_id===id));
    assert.equal(ended,false,'Fault must occur while the native response is held');
    const fault=await abandon(id);
    assert.equal(ended,false,'Abandonment must not perform native cleanup');
    // Deliberately issue no pairing request, status poll, or cancellation until
    // the native HTTP response itself ends. Old lazy expiry cannot pass this.
    const result=await waiting;if(result.error)throw result.error;
    const elapsedMs=Date.now()-started;
    assert.match(result.value,/<root\b[^>]*status_code="408"/);assert.match(result.value,/<paired>0<\/paired>/);
    assert.ok(elapsedMs>=118000 && elapsedMs<130000,`Unexpected native lifetime: ${elapsedMs}`);
    assert.equal(await engineIdentity(),engine,'Engine must survive the fault');
    assert.deepEqual(await readTrust(),trust,'Expiry must preserve existing paired clients');
    assert.equal((await listNative()).some(entry=>entry.managed_id===id),false);
    const late=await nativeWaiter(exchange,identity,id,{timeout:3000});
    assert.match(late,/<root\b[^>]*status_code="403"/);assert.match(late,/<paired>0<\/paired>/);
    return {passed:true,fault,elapsedMs,productionLifetimeMs:120000,noPairingAPITrafficDuringWait:true,
      nativeExpiryStatus:408,lateNativeStatus:403,engineUnchanged:true,trustUnchanged:true};
  }finally{owner.abort();await waiting;}
}
module.exports={verifyNativeCleanup,nativeWaiter,holdManagedPairing,verifyAutonomousExpiry};
