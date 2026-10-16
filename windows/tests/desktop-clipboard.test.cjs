'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {clipboardAccess,captureSelection}=require('../electron/mac/clipboard-access.cjs');
const {PairedController}=require('../electron/mac/paired-controller.cjs');
const {receive,sendSelection}=require('../electron/mac/relay.cjs');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
class Item{constructor(values){this.values=values;this.types=Object.keys(values);}async getType(type){return this.values[type];}}
function fixture(){
  let items=[],reads=0;const writes=[];
  const clipboard={has:async type=>items.some(item=>item.types.includes(type)),read:async()=>{reads++;return items;},readText:async()=>{const item=items.find(item=>item.types.includes('text/plain'));return item?await item.values['text/plain'].text():'';},writeText:async text=>{writes.push(text);items=[new Item({'text/plain':new Blob([text])})];},write:async values=>{writes.push(values);items=values;}};
  const access=clipboardAccess({clipboard,ClipboardItem:Item});
  return {clipboard,access,writes,set:values=>{items=values;},get reads(){return reads;}};
}
test('asynchronous clipboard reads request only text/PNG and preserve Unicode',async()=>{
  const f=fixture();const seen=[];f.set([{types:['text/plain','electron application/osclipboard;format="FileNameW"'],getType:async type=>{seen.push(type);assert.equal(type,'text/plain');return new Blob(['中文 👋\ntext']);}}]);
  assert.deepEqual(await f.access.readPayload(),{kind:'text',text:'中文 👋\ntext'});assert.deepEqual(seen,['text/plain']);
  f.set([new Item({'text/uri-list':new Blob(['file:///private'])})]);assert.deepEqual(await f.access.readPayload(),{kind:'empty'});
});
test('text and image limits apply before reading blobs or decoding images',async()=>{
  const f=fixture();for(const type of ['text/plain','image/png']){
    f.set([{types:[type],getType:async()=>({size:9*1024*1024,arrayBuffer:()=>assert.fail('oversized blob was read')})}]);
    await assert.rejects(f.access.readPayload(),{code:type==='image/png'?'IMAGE_TOO_LARGE':'INVALID_TEXT'});
  }
  const bytes=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.write('IHDR',12);bytes.writeUInt32BE(8000,16);bytes.writeUInt32BE(1,20);
  f.set([new Item({'image/png':new Blob([bytes])})]);await assert.rejects(f.access.readPayload(),{code:'IMAGE_TOO_LARGE'});
});
test('cancelled asynchronous read cannot request a blob, copy a selection, restore or send',async()=>{
  const gate=deferred(),f=fixture();let active=true;f.clipboard.read=()=>gate.promise;
  const read=f.access.readPayload(()=>active);active=false;gate.resolve([{types:['text/plain'],getType:()=>assert.fail('read after cancel')}]);await assert.rejects(read,{code:'CANCELLED'});
  active=true;const textGate=deferred();f.clipboard.has=async()=>true;f.clipboard.readText=()=>textGate.promise;
  const selection=captureSelection(f.access,()=>assert.fail('copy after cancel'),{active:()=>active});await Promise.resolve();active=false;textGate.resolve('old');await assert.rejects(selection,{code:'CANCELLED'});assert.equal(f.writes.length,0);
});
test('selected-text restoration awaits writes and preserves a later local copy',async()=>{
  const f=fixture();await f.clipboard.writeText('old');let text='old';f.clipboard.readText=async()=>text;
  const result=await captureSelection(f.access,async()=>{text='selected';},{delay:async()=>{}});assert.equal(result.text,'selected');assert.deepEqual(f.writes,['old','old']);
  let reads=0;f.clipboard.readText=async()=>['old','selected','new local copy'][reads++];
  await captureSelection(f.access,async()=>{},{delay:async()=>{}});assert.deepEqual(f.writes,['old','old']);
});
test('paired delivery waits for write completion before acknowledgment and queue release',async()=>{
  const f=fixture(),gate=deferred(),events=[];f.clipboard.writeText=async()=>{events.push('write');await gate.promise;events.push('committed');};
  class Receiver{constructor(options){this.apply=options.apply;}close(){}}
  const controller=new PairedController({store:{},clipboard:f.clipboard,Receiver,notify:()=>events.push('notice')});
  const applied=controller.receiver.apply({kind:'json',text:'incoming'},()=>true);const next=controller.withClipboard(()=>events.push('next'));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['write']);gate.resolve();await applied;await next;assert.deepEqual(events,['write','committed','notice','next']);controller.close();
});
test('paired send uses resolved ClipboardItems and cancels after a route replacement during read',async()=>{
  const f=fixture();f.set([new Item({'text/plain':new Blob(['synthetic text'])})]);const host={id:'h',clientId:'c',certificate:'pin',enabled:true,address:'host',port:1};let selected=host;const sent=[];
  class Receiver{refresh(){}close(){}}
  const controller=new PairedController({store:{selected:()=>selected,data:{},identity:async()=>({})},clipboard:f.clipboard,Receiver,send:async(_h,_i,p)=>sent.push(p)});
  assert.equal(await controller.sendCurrent(),true);assert.deepEqual(sent,[{kind:'text',text:'synthetic text'}]);
  const gate=deferred(),began=deferred();f.clipboard.read=()=>{began.resolve();return gate.promise;};const pending=controller.sendCurrent();await began.promise;selected={...host,certificate:'replacement'};gate.resolve([]);await assert.rejects(pending,{code:'CANCELLED'});assert.equal(sent.length,1);controller.close();
});
test('legacy HTTP awaits the asynchronous write and returns failure without acknowledgment',async()=>{
  const f=fixture(),gate=deferred();let notified=0,finished=false;f.clipboard.writeText=()=>gate.promise;
  const adapters={clipboard:f.clipboard,getConfig:()=>({legacyEnabled:true}),notify:()=>notified++},context={remoteAddress:'127.0.0.1'};
  const pending=receive('POST','/push','{"text":"synthetic"}',adapters,context).then(value=>{finished=true;return value;});
  await Promise.resolve();assert.equal(finished,false);assert.equal(notified,0);gate.reject(new Error('clipboard busy'));assert.equal((await pending).status,503);assert.equal(notified,0);
  const config={legacyEnabled:true};adapters.getConfig=()=>config;adapters.withClipboard=async op=>{config.legacyEnabled=false;return op();};
  assert.equal((await receive('POST','/push','{"text":"synthetic"}',adapters,context)).status,403);
  config.legacyEnabled=true;adapters.withClipboard=operation=>operation();
  assert.equal((await receive('POST','/push','{"text":"synthetic"}',adapters,{...context,active:()=>false})).status,503);
});
test('legacy destination changes while reading stop copy and sending',async()=>{
  const f=fixture(),gate=deferred(),began=deferred(),config={legacyEnabled:true,peer:'first.local',peerPort:1};f.clipboard.has=async()=>true;
  f.clipboard.readText=()=>{began.resolve();return gate.promise;};
  const task=sendSelection({clipboard:f.clipboard,config,copySelection:()=>assert.fail('copy after target changed'),post:()=>assert.fail('send after target changed')});
  await began.promise;config.peer='replacement.local';gate.resolve('synthetic');await assert.rejects(task,{code:'CANCELLED'});assert.equal(f.writes.length,0);
});
