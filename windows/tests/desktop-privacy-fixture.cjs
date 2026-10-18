'use strict';
const assert=require('node:assert/strict');
const {PrivacyController}=require('../electron/mac/privacy-controller.cjs');
const protocol=require('../electron/mac/privacy-protocol.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<400;i++){if(check())return;await delay(10);}throw Error('privacy fixture deadline');}
async function main(){
  let raw='';for await(const chunk of process.stdin)raw+=chunk;
  const {host,identity}=JSON.parse(raw);
  const store={host,selected(){return this.host;},async identity(){return identity;}};
  const viewer={session:{host:{...host},telemetry:true},currentSession(){return this.session;},
    snapshot(){return {progress:{received:200,rendered:200,width:1280,height:720,receivedAgeMs:0,renderedAgeMs:0}};},reconcile(code){throw Error(code);}};
  let renews=0;
  const controller=new PrivacyController({store,viewer,pollMs:20,renewMs:80,request:async(...args)=>{const value=await protocol.request(...args);if(args[2]==='renew')renews++;return value;}});
  const enable=()=>controller.setEnabled({viewId:controller.snapshot().viewId,enabled:true});
  try{
    controller.reconcile();await until(()=>controller.snapshot().canEnable);enable();await until(()=>controller.snapshot().active);
    await until(()=>renews>=2);assert.equal(controller.snapshot().active,true);
    controller.setEnabled({viewId:controller.snapshot().viewId,enabled:false});await until(()=>controller.snapshot().canEnable);
    enable();await until(()=>controller.snapshot().active);const viewId=controller.snapshot().viewId;
    store.host={...host,routeId:'replacement'};viewer.session={host:{...store.host},telemetry:true};controller.reconcile();
    await until(()=>controller.snapshot().canEnable);assert.equal(controller.snapshot().active,false);assert.notEqual(controller.snapshot().viewId,viewId);
    console.log(JSON.stringify({passed:true,routeRestored:true}));
  }finally{await controller.close();}
}
main().catch(()=>{console.error('desktop privacy fixture failed');process.exitCode=1;});
