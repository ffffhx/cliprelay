'use strict';
const fs=require('node:fs');
const {makeRequest,sendClipboard,receiveDelivery}=require('../electron/mac/paired-relay.cjs');
const {hash}=require('../electron/mac/paired-crypto.cjs');
(async()=>{
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  const host=input.host,identity=input.identity,request=makeRequest(host,identity),receipts=new Map(),received=[];
  for(let index=0;index<2;index++){
    const meta=await request({op:'poll'});
    await receiveDelivery(meta,{request,active:()=>true,receipts:{state:(id,digest)=>{const value=receipts.get(id);if(value && value.hash!==digest)throw new Error('conflict');return value?.state || '';},save:(id,digest,state)=>receipts.set(id,{hash:digest,state})},apply:async value=>received.push({kind:value.kind,text:value.text,sha256:hash(value.body).toString('hex')})});
  }
  const text='Mac fixture 中文 👩‍💻\nquoted " & <';
  await sendClipboard(host,identity,{kind:'text',text});
  const clipboard=makeRequest(host,identity,undefined,'/v1/clipboard',45000);
  if((await clipboard({op:'read'})).text!==text)throw new Error('C# clipboard text changed');
  await sendClipboard(host,identity,{kind:'png',bytes:Buffer.from(input.png,'base64')});
  if((await clipboard({op:'read'})).data!==input.png)throw new Error('C# clipboard PNG changed');
  process.stdout.write(JSON.stringify({received,clipboardText:true,clipboardPng:true}));
})().catch(error=>{process.stderr.write(String(error.code || error.message));process.exitCode=1;});
