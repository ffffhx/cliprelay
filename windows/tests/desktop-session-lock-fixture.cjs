'use strict';
const assert=require('node:assert/strict');
const {SessionLockController}=require('../electron/mac/session-lock-controller.cjs');
const protocol=require('../electron/mac/session-lock-protocol.cjs');
const {jsonRequest}=require('../electron/mac/paired-transport.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<500;i++){if(check())return;await delay(10);}throw Error('session lock fixture deadline');}
async function main(){
  let raw='';for await(const chunk of process.stdin)raw+=chunk;
  const {host,identity}=JSON.parse(raw),calls=[];
  const event=event=>jsonRequest({address:host.address,port:host.port+2,path:'/fixture-event',method:'POST',body:{event},identity,trust:{cert:host.certificate},timeout:2000});
  const store={selected:()=>host,identity:async()=>identity};
  const viewer={session:{host,telemetry:true},currentSession(){return this.session;},snapshot(){return {progress:{received:200,rendered:200,width:1280,height:720,receivedAgeMs:0,renderedAgeMs:0}};},reconcile(code){throw Error(code);}};
  const controller=new SessionLockController({store,viewer,pollMs:20,request:async(...args)=>{calls.push({op:args[2],binding:args[3]});return protocol.request(...args);}});
  const set=enabled=>controller.setEnabled({viewId:controller.snapshot().viewId,enabled});
  try{
    controller.reconcile();await until(()=>controller.snapshot().canArm);set(true);await until(()=>controller.snapshot().armed);
    const original=calls.find(c=>c.op==='arm').binding;
    await event('cancel-pending');set(false);await until(()=>controller.snapshot().error==='LOCK_CANCEL_PENDING');assert.equal(controller.snapshot().canArm,false);
    await event('cancel-ready');await until(()=>controller.snapshot().canArm);
    await assert.rejects(protocol.request(host,identity,'arm',original),{code:'LOCK_EXPIRED'});
    set(true);await until(()=>controller.snapshot().armed);viewer.session=null;controller.reconcile();await event('end');
    await until(()=>controller.snapshot().phase==='requested');assert.equal(controller.snapshot().canDisarm,false);
    await assert.rejects(protocol.request(host,identity,'disarm',calls.filter(c=>c.op==='arm').at(-1).binding),{code:'LOCK_ALREADY_REQUESTED'});
    await event('confirm');await until(()=>controller.snapshot().phase==='locked');await delay(60);await controller.close();
    assert.equal(calls.filter(c=>c.op==='arm').length,2);assert.ok(calls.every(c=>!['renew','commit'].includes(c.op)));
    console.log(JSON.stringify({passed:true,cancelConfirmed:true,oneShot:true}));
  }finally{await controller.close();}
}
main().catch(error=>{console.error('desktop session lock fixture failed:',error.code||error.message);process.exitCode=1;});
