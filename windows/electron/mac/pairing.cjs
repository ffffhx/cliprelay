'use strict';
const crypto=require('node:crypto');
const {exchange,jsonRequest,endpoint,fault}=require('./paired-transport.cjs');
const {hash,fromHex,signature,aes,xmlValue}=require('./paired-crypto.cjs');
const feedback=require('./pairing-feedback.cjs');

async function pairHost({address,port=48789,name,identity,signal,onVerification=()=>{},expectedCert,ports={},deviceCode}){
  const target=endpoint(address,port);
  if(typeof name!=='string' || !name.trim() || Buffer.byteLength(name)>128 || /[\r\n\0]/.test(name))throw fault('INVALID_NAME');
  const nonce=crypto.randomBytes(16).toString('hex'),pin=String(crypto.randomInt(10000)).padStart(4,'0');
  const trust={cert:expectedCert,bootstrap:!expectedCert};
  const owner=new AbortController(),cancel=()=>owner.abort();
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  const base={address:target.address,identity,trust,signal:owner.signal};
  let id,bound,monitorTask,feedbackError,readFeedback;
  try{
    if(deviceCode!==undefined&&!/^[0-9]{8}$/.test(deviceCode))throw fault('INVALID_PAIRING_CODE');
    const bootstrap=await jsonRequest({...base,port:ports.bootstrap || port+3,path:'/v1/pair',body:{nonce,name,pin,...(deviceCode?{deviceCode}:{})},headers:{'X-ClipRelay-Pairing-Feedback':'1','X-ClipRelay-Pairing-Native':'1'},acceptStatuses:[200,403,429,503],timeout:6000,limit:2048});
    if(['DEVICE_CODE_REQUIRED','DEVICE_CODE_INVALID','DEVICE_CODE_RATE_LIMIT','DEVICE_ACCESS_UNAVAILABLE'].includes(bootstrap?.code))throw fault(bootstrap.code);
    const digest=hash('cliprelay-lan-pair-v1\n',new crypto.X509Certificate(trust.cert).raw,new crypto.X509Certificate(identity.cert).raw,nonce).toString('hex');
    const verification=digest.slice(0,12).toUpperCase().match(/.{4}/g).join(' ');
    id=digest.slice(0,32);
    if(bootstrap.id!==id || bootstrap.verification!==verification)throw fault('PAIRING_CODE_MISMATCH');
    bound=feedback.ticket(bootstrap);
    const nativeID=feedback.nativeTicket(bootstrap),sessionID=nativeID || id;
    readFeedback=()=>jsonRequest({...base,port:ports.bootstrap || port+3,path:'/v1/pair/status',body:{id,receipt:bound.receipt},timeout:4000,limit:2048});
    if(bound)monitorTask=feedback.monitor({bound,signal:owner.signal,read:readFeedback})
      .catch(error=>{if(!owner.signal.aborted){feedbackError=error;owner.abort();}});
    await onVerification({verification,expires:bootstrap.expires});
    if(owner.signal.aborted)throw fault('CANCELLED');
    const command=async(data,timeout=10000,secure=false)=>{
      const query=new URLSearchParams({uniqueid:sessionID,uuid:crypto.randomUUID(),devicename:'ClipRelay-'+sessionID,updateState:'1',
        ...(nativeID?{cliprelay_pairing:nativeID}:{}),...data});
      const reply=await exchange({...base,port:secure?(ports.secure || port-5):(ports.http || port),path:'/pair?'+query,method:'GET',plain:!secure,timeout,limit:32768});
      if(xmlValue(reply,'paired')!=='1')throw fault('PAIRING_FAILED');return reply;
    };
    const salt=crypto.randomBytes(16),key=hash(salt,pin).subarray(0,16);
    const certReply=await command({phrase:'getservercert',salt:salt.toString('hex'),clientcert:Buffer.from(identity.cert).toString('hex')},125000);
    const returned=new crypto.X509Certificate(fromHex(xmlValue(certReply,'plaincert'),128,16384));
    const hostCert=new crypto.X509Certificate(trust.cert);
    if(!returned.raw.equals(hostCert.raw))throw fault('HOST_CERT_CHANGED');
    const challenge=crypto.randomBytes(16);
    const response=await command({clientchallenge:aes(challenge,key).toString('hex')});
    const decoded=aes(fromHex(xmlValue(response,'challengeresponse'),48),key,true);
    const clientSecret=crypto.randomBytes(16);
    const secretReply=await command({serverchallengeresp:aes(hash(decoded.subarray(32,48),signature(identity.cert),clientSecret),key).toString('hex')});
    const secret=fromHex(xmlValue(secretReply,'pairingsecret'),64,8192),serverSecret=secret.subarray(0,16);
    if(!crypto.verify('sha256',serverSecret,hostCert.publicKey,secret.subarray(16)))throw fault('PAIRING_SIGNATURE_INVALID');
    if(!crypto.timingSafeEqual(hash(challenge,signature(hostCert),serverSecret),decoded.subarray(0,32)))throw fault('PAIRING_PIN_MISMATCH');
    await command({clientpairingsecret:Buffer.concat([clientSecret,crypto.sign('sha256',clientSecret,identity.key)]).toString('hex')});
    await command({phrase:'pairchallenge'},10000,true);
    if(owner.signal.aborted)throw fault('CANCELLED');
    return {...target,id:hash(hostCert.raw).toString('hex'),name:target.address,certificate:hostCert.toString(),clientId:sessionID,enabled:true};
  }catch(error){
    // Native cleanup can finish before the next status poll. Read the same
    // pinned, receipt-bound status once to preserve its terminal explanation.
    // This never retries a mutation or substitutes for certificate proof.
    if(bound && error.code==='PAIRING_FAILED' && !owner.signal.aborted){
      try{feedback.state(await readFeedback(),bound);}
      catch(observed){if(['PAIRING_REJECTED','PAIRING_EXPIRED','PAIRING_CANCELLED_REMOTE','PAIRING_STATUS_INVALID','HOST_CERT_CHANGED'].includes(observed.code))feedbackError=observed;}
    }
    throw feedbackError || error;
  }finally{
    owner.abort();await monitorTask;signal?.removeEventListener('abort',cancel);
    if(id)await exchange({...base,signal:undefined,port:ports.bootstrap || port+3,path:'/v1/pair/'+id,method:'DELETE',
      headers:bound?{'X-ClipRelay-Pairing-Receipt':bound.receipt}:{},timeout:2000,limit:2048}).catch(()=>{});
  }
}
module.exports={pairHost};
