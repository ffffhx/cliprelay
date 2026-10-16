'use strict';
const {fault}=require('./paired-transport.cjs');
const states=new Set(['waiting','approving','handshake','rejected','expired','cancelled']);
const terminal={rejected:'PAIRING_REJECTED',expired:'PAIRING_EXPIRED',cancelled:'PAIRING_CANCELLED_REMOTE'};
function ticket(value){
  if(value.feedback===undefined)return null;
  const feedback=value.feedback;
  if(!feedback || typeof feedback!=='object' || Array.isArray(feedback) || Object.keys(feedback).sort().join(',')!=='protocol,receipt' ||
    feedback.protocol!==1 || typeof feedback.receipt!=='string' || !/^[0-9a-f]{32}$/.test(feedback.receipt) ||
    !Number.isSafeInteger(value.expires) || value.expires<=0)throw fault('PAIRING_STATUS_INVALID');
  return {id:value.id,receipt:feedback.receipt,expires:value.expires};
}
function state(value,bound){
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join(',')!=='expires,id,protocol,receipt,state' ||
    value.protocol!==1 || value.id!==bound.id || value.receipt!==bound.receipt || value.expires!==bound.expires || !states.has(value.state))throw fault('PAIRING_STATUS_INVALID');
  if(terminal[value.state])throw fault(terminal[value.state]);
  return value.state;
}
function delay(signal,ms){
  if(signal.aborted)return Promise.reject(fault('CANCELLED'));
  return new Promise((resolve,reject)=>{
    const finish=()=>{signal.removeEventListener('abort',abort);resolve();};
    const timer=setTimeout(finish,ms);
    const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(fault('CANCELLED'));};
    signal.addEventListener('abort',abort,{once:true});
  });
}
async function monitor({bound,read,signal,pollMs=750}){
  const transient=new Set(['TIMEOUT','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','HTTP_429','HTTP_503']);let failures=0;
  while(!signal.aborted){
    let result;
    try{result=await read();}
    catch(error){
      if(signal.aborted)throw fault('CANCELLED');
      if(error.code==='HOST_CERT_CHANGED')throw error;
      if(transient.has(error.code) && ++failures<3){await delay(signal,pollMs);continue;}
      throw fault('PAIRING_STATUS_UNAVAILABLE');
    }
    failures=0;
    if(signal.aborted)throw fault('CANCELLED');
    // Approval and PIN forwarding are observations only. The existing native
    // certificate, PIN and signature exchange remains the sole success proof.
    state(result,bound);
    await delay(signal,pollMs);
  }
}
module.exports={ticket,state,monitor};
