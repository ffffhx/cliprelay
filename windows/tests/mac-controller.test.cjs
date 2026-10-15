'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {identities}=require('./mac-pairing-fixture.cjs');
const {PairedStore}=require('../electron/mac/paired-store.cjs');
const {PairedController}=require('../electron/mac/paired-controller.cjs');
const host={id:crypto.createHash('sha256').update(new crypto.X509Certificate(identities.host.cert).raw).digest('hex'),name:'PC',address:'127.0.0.1',port:48789,certificate:identities.host.cert,clientId:'a'.repeat(32),enabled:true};
class Receiver{constructor(options){this.options=options;}refresh(){}close(){}}
function fixture(options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-mac-controller-'));
  const store=new PairedStore(directory,{}, {legacySelected:true});store.cachedIdentity=identities.client;
  let value='old',reads=0;const writes=[],sent=[];
  const clipboard={availableFormats:()=>['text/plain'],readText:()=>{reads++;return value;},writeText:text=>{writes.push(text);value=text;},readImage:()=>({isEmpty:()=>true})};
  const controller=new PairedController({store,clipboard,localName:'Test Mac',Receiver,copySelection:async()=>{value='selection 中文';},send:async(...args)=>sent.push(args),...options});
  return {store,controller,writes,sent,get reads(){return reads;},close:()=>{controller.close();const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(resolved).startsWith('cliprelay-mac-controller-'));fs.rmSync(resolved,{recursive:true,force:true});}};
}
test('removing or pausing a paired host never selects plaintext or reads the clipboard',async()=>{
  const f=fixture();try{
    f.store.add(host);f.controller.enable(host.id,false);await assert.rejects(f.controller.sendCurrent(),{code:'PAIRING_REQUIRED'});assert.equal(f.reads,0);
    f.controller.remove(host.id);assert.equal(f.store.data.legacySelected,false);await assert.rejects(f.controller.sendCurrent(),{code:'PAIRING_REQUIRED'});assert.equal(f.reads,0);
    f.controller.selectLegacy();assert.equal(f.store.data.legacySelected,true);
  }finally{f.close();}
});
test('selected-text hotkey restores local text and sends through the selected paired route',async()=>{
  const f=fixture();try{
    f.store.add(host);assert.equal(await f.controller.sendCurrent(true),true);assert.deepEqual(f.writes,['old']);assert.equal(f.sent.length,1);assert.equal(f.sent[0][0].id,host.id);assert.deepEqual(f.sent[0][2],{kind:'text',text:'selection 中文'});
  }finally{f.close();}
});
test('failed encrypted send keeps the paired selection and never falls back to legacy',async()=>{
  let attempts=0;const f=fixture({send:async()=>{attempts++;throw Object.assign(new Error('changed'),{code:'HOST_CERT_CHANGED'});}});
  try{f.store.add(host);await assert.rejects(f.controller.sendCurrent(),{code:'HOST_CERT_CHANGED'});assert.equal(attempts,1);assert.equal(f.store.data.selected,host.id);assert.equal(f.store.data.legacySelected,false);}
  finally{f.close();}
});
test('cancelled pairing cannot be persisted even if an underlying operation returns success late',async()=>{
  let started,release;const began=new Promise(resolve=>{started=resolve;});const pending=new Promise(resolve=>{release=resolve;});
  const f=fixture({pair:async options=>{options.onVerification({verification:'AAAA BBBB CCCC',expires:123});started();await pending;return host;}});
  try{
    f.controller.startPair({address:'127.0.0.1',port:48789,label:'PC'});await began;
    const visible=JSON.stringify(f.controller.snapshot());assert.ok(!visible.includes('PRIVATE KEY'));assert.ok(!visible.includes('CERTIFICATE'));assert.ok(visible.includes('AAAA BBBB CCCC'));
    f.controller.cancelPair();release();await f.controller.pairTask;assert.equal(f.store.hosts().length,0);assert.equal(f.controller.snapshot().pairing.state,'error');
  }finally{f.close();}
});
