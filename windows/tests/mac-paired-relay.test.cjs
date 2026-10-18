'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {identities,fixture}=require('./mac-pairing-fixture.cjs');
const {PairedStore}=require('../electron/mac/paired-store.cjs');
const {receiveDelivery,sendClipboard,validateText,jpegSize}=require('../electron/mac/paired-relay.cjs');
const {pairHost}=require('../electron/mac/pairing.cjs');
const digest=body=>crypto.createHash('sha256').update(body).digest('hex');
function storage(){
  const key=crypto.randomBytes(32);
  return {isEncryptionAvailable:()=>true,encryptString:value=>{const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);const data=Buffer.concat([cipher.update(value),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),data]);},decryptString:value=>{const cipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));cipher.setAuthTag(value.subarray(12,28));return Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString();}};
}
function temp(){return fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-mac-paired-'));}
function remove(directory){assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(directory).startsWith('cliprelay-mac-paired-'));fs.rmSync(directory,{recursive:true,force:true});}
const host={id:digest(new crypto.X509Certificate(identities.host.cert).raw),name:'Fixture PC',address:'127.0.0.1',port:48789,certificate:identities.host.cert,clientId:'a'.repeat(32),enabled:true};
function message(text='fixture',kind='json'){
  const body=kind==='json'?Buffer.from(JSON.stringify(typeof text==='string'?{text}:text)):text;
  const id='b'.repeat(32),sha256=digest(body),events=[];
  return {meta:{ok:true,state:'queued',kind,id,sha256,size:body.length},events,request:async command=>{events.push(command.op);if(command.op==='read')return {ok:true,id,offset:command.offset,data:body.subarray(command.offset,command.offset+7).toString('base64')};return {ok:true,id,state:command.op==='ack'?'delivered':'rejected'};}};
}
test('encrypted identity persists once, keychain failure never falls back to plaintext',async()=>{
  const directory=temp(),vault=storage();let generated=0;
  try{
    const store=new PairedStore(directory,vault,{generate:async()=>{generated++;return identities.client;}});
    await Promise.all([store.identity(),store.identity()]);assert.equal(generated,1);
    const raw=fs.readFileSync(path.join(directory,'state.json'),'utf8');assert.ok(!raw.includes('PRIVATE KEY'));assert.ok(!raw.includes(Buffer.from(identities.client.key).toString('base64')));
    const loaded=new PairedStore(directory,vault);assert.equal((await loaded.identity()).key,identities.client.key);
    await assert.rejects(new PairedStore(directory,{isEncryptionAvailable:()=>false}).identity(),{code:'KEYCHAIN_UNAVAILABLE'});
  }finally{remove(directory);}
});
test('lost acknowledgement survives restart without overwriting a newer clipboard',async()=>{
  const directory=temp(),vault=storage(),m=message('new 中文');let applied=0;
  try{
    let store=new PairedStore(directory,vault);store.add(host);
    const options={active:()=>true,apply:async()=>{applied++;},receipts:store.receipts(host.id),request:async command=>{if(command.op==='ack')throw new Error('lost reply');return m.request(command);}};
    await assert.rejects(receiveDelivery(m.meta,options),/lost reply/);assert.equal(applied,1);
    store=new PairedStore(directory,vault);
    await receiveDelivery(m.meta,{...options,receipts:store.receipts(host.id),request:m.request});assert.equal(applied,1);assert.equal(m.events.at(-1),'ack');
    assert.ok(!fs.readFileSync(path.join(directory,'state.json'),'utf8').includes('new 中文'));
  }finally{remove(directory);}
});
test('uncertain write and receipt failures reject replay; failures before journaling never apply',async()=>{
  const directory=temp(),vault=storage(),m=message();let applied=0;
  try{
    const store=new PairedStore(directory,vault);store.add(host);
    await assert.rejects(receiveDelivery(m.meta,{request:m.request,receipts:store.receipts(host.id),active:()=>true,apply:async()=>{applied++;throw new Error('crash after write');}}),/crash/);
    await receiveDelivery(m.meta,{request:m.request,receipts:new PairedStore(directory,vault).receipts(host.id),active:()=>true,apply:async()=>{applied++;}});
    assert.equal(applied,1);assert.equal(m.events.at(-1),'reject');
    const another=message();another.meta.id='c'.repeat(32);
    await assert.rejects(receiveDelivery(m.meta,{request:m.request,receipts:{state:()=>'',save:()=>{throw new Error('disk full');}},active:()=>true,apply:async()=>{applied++;}}),/disk full/);assert.equal(applied,1);
  }finally{remove(directory);}
});
test('corrupt payloads and cancelled deliveries never reach the clipboard',async()=>{
  for(const alter of [m=>m.meta.sha256='0'.repeat(64),m=>m.meta.size=30*1024*1024,m=>{const old=m.request;m.request=async command=>command.op==='read'?{ok:true,id:m.meta.id,data:'%%%'}:old(command);}]){
    const m=message();alter(m);let applied=false;
    await assert.rejects(receiveDelivery(m.meta,{request:m.request,receipts:{state:()=>'',save:()=>{}},active:()=>true,apply:async()=>{applied=true;}}));assert.equal(applied,false);
  }
  const m=message();await assert.rejects(receiveDelivery(m.meta,{request:m.request,receipts:{state:()=>''},active:()=>false,apply:async()=>assert.fail()}),{code:'CANCELLED'});assert.deepEqual(m.events,[]);
  for(const text of ['', '\0', '\ud800', '\udfff','x'.repeat(1048577)])assert.throws(()=>validateText(text));
  assert.equal(validateText('A😀中文'),'A😀中文');
});
test('probe has no durable write, ID reuse conflicts, and JPEG dimensions are bounded before decode',async()=>{
  const m=message({text:'probe',probe:true});
  await receiveDelivery(m.meta,{request:m.request,receipts:{state:()=>'',save:()=>assert.fail('probe journal')},active:()=>true,apply:async()=>assert.fail('probe apply')});assert.equal(m.events.at(-1),'ack');
  const directory=temp();try{
    const store=new PairedStore(directory,storage());store.add(host);store.receipts(host.id).save(m.meta.id,m.meta.sha256,'pending');
    assert.throws(()=>store.receipts(host.id).state(m.meta.id,'e'.repeat(64)),{code:'RELAY_ID_CONFLICT'});
  }finally{remove(directory);}
  const jpeg=Buffer.from([255,216,255,192,0,8,8,0,3,0,2,0,255,218]);assert.deepEqual(jpegSize(jpeg),{width:2,height:3});jpeg.writeUInt16BE(32000,7);jpeg.writeUInt16BE(32000,9);assert.throws(()=>jpegSize(jpeg),{code:'IMAGE_TOO_LARGE'});
});
test('real pinned mutually authenticated clipboard send works after complete pairing',async()=>{
  const f=await fixture();f.approve();
  try{
    const paired=await pairHost({address:'127.0.0.1',name:'Test Mac',identity:f.client,ports:f.ports});
    paired.port=f.ports.secure-2;
    await sendClipboard(paired,f.client,{kind:'text',text:'paired fixture 中文'});
    assert.equal(f.writes.length,1);assert.equal(f.writes[0].text,'paired fixture 中文');assert.equal(f.writes[0].op,'write');assert.match(f.writes[0].id,/^[a-f0-9]{32}$/);
  }finally{await f.close();}
});
