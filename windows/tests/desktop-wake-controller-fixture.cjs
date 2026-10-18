'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WakeController}=require('../electron/mac/wake-controller.cjs');
const protocol=require('../electron/mac/wake-protocol.cjs');
const {jsonRequest}=require('../electron/mac/paired-transport.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<500;i++){if(check())return;await delay(10);}throw Error('desktop wake controller deadline');}
async function main(){
  let raw='';for await(const chunk of process.stdin)raw+=chunk;const {target,helper,identity}=JSON.parse(raw);
  for(const [index,host] of [target,helper].entries())Object.assign(host,{id:crypto.createHash('sha256').update(new crypto.X509Certificate(host.certificate).raw).digest('hex'),clientId:String(index+1).repeat(32),enabled:true});
  const store={hosts:()=>[target,helper],selected:()=>target,identity:async()=>identity},calls=[];
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-wake-interop-'));
  const controller=new WakeController({store,directory,pollMs:20,request:async(...args)=>{calls.push({id:args[0].id,op:args[2],body:args[3]});return protocol.request(...args);}});
  const action=(name,extra={})=>controller.action(name,{viewId:controller.snapshot().viewId,...extra});
  const online=online=>jsonRequest({address:helper.address,port:helper.port+2,path:'/fixture-event',method:'POST',body:{online},identity,trust:{cert:helper.certificate},timeout:2000});
  try{
    controller.reconcile();action('wake-prepare');await until(()=>controller.snapshot().phase==='choosing');let state=controller.snapshot();
    action('wake-save',{adapter:state.adapters[0].id,helper:state.helpers[0].id,sameLan:true});await until(()=>controller.snapshot().configured);
    await online(false);action('wake-send');await until(()=>controller.snapshot().canRetry);assert.equal(controller.snapshot().packetSent,false);
    assert.equal(calls.filter(c=>c.op==='send').length,1);action('wake-retry');await until(()=>controller.snapshot().packetSent);
    const writes=calls.filter(c=>c.op==='send');assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);assert.equal(controller.snapshot().phase,'waiting');
    await online(true);await until(()=>controller.snapshot().phase==='online');assert.equal(calls.filter(c=>c.op==='send').length,2);
    console.log(JSON.stringify({passed:true,replayed:true,online:true}));
  }finally{controller.close();fs.rmSync(path.join(directory,'wake.json'),{force:true});fs.rmdirSync(directory);}
}
main().catch(error=>{console.error('desktop wake controller fixture failed:',error.code||error.message);process.exitCode=1;});
