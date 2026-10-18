'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const protocol=require('../electron/mac/terminal-protocol.cjs'),{MouseState}=require('../electron/mac/terminal-mouse.cjs');
const instance='a'.repeat(32),id='b'.repeat(32);
function initial(extra={}){return {mode:1002,format:1006,epoch:1,offset:0,buttons:0,remainingMs:0,gesture:0,nextGesture:1,acceptedSequence:0,writtenSequence:0,phase:'idle',outcome:'none',...extra};}
function fixture(){let time=100;const state=new MouseState(initial(),()=>time);return {state,advance:ms=>time+=ms,event:(action,extra={})=>state.enqueue({action,epoch:state.snapshot.epoch,column:5,row:7,button:0,modifiers:0,...extra}),command:()=>state.command(instance,id),ack:(command,extra={})=>state.acknowledge({instance,session:{id,mouse:{...state.snapshot,acceptedSequence:command.sequence,writtenSequence:command.sequence,outcome:'written',...extra}}})};}
test('mouse metadata is bounded and capability negotiation preserves old hosts',()=>{
  const session={id,shell:'cmd',state:'running',columns:100,rows:30,exitCode:0,openSequence:1,acceptedSequence:0,writtenSequence:0,start:0,end:0,remainingMs:1,mouse:initial()};
  const list={ok:true,instance,nextOpen:2,sessions:[session],mouseProtocol:1};assert.equal(protocol.validate({op:'list'},list).sessions[0].mouse.nextGesture,1);
  for(const invalid of [{buttons:8},{epoch:0},{offset:1},{nextGesture:0},{remainingMs:1501},{writtenSequence:1},{phase:'closed',buttons:1}])assert.throws(()=>protocol.validate({op:'list'},{...list,sessions:[{...session,mouse:initial(invalid)}]}),/INVALID_RESPONSE/);
  assert.throws(()=>protocol.validate({op:'list'},{...list,sessions:[{...session,mouse:null}]}),/INVALID_RESPONSE/);
  assert.equal(protocol.validate({op:'list'},{...list,mouseProtocol:0,sessions:[{...session,mouse:null}]}).mouseProtocol,0);
  assert.throws(()=>protocol.validate({op:'mouse',instance,id,sequence:1},{ok:true,instance,session}),/INVALID_RESPONSE/);
});
test('live movements coalesce without dropping press, release or modifiers',()=>{
  const f=fixture();f.event('press',{button:2,modifiers:28});const press=f.command();assert.equal(press.gesture,1);assert.deepEqual(f.command(),press);
  f.ack(press,{gesture:1,nextGesture:2,buttons:4,remainingMs:1500,phase:'held'});
  for(let column=10;column<100;column++)f.event('move',{button:2,modifiers:16,column});
  f.event('release',{button:2,modifiers:4,column:99});assert.equal(f.state.queue.length,2);
  const move=f.command();assert.equal(move.column,99);assert.equal(move.modifiers,16);assert.equal(move.action,'move');f.ack(move);
  const release=f.command();assert.equal(release.action,'release');assert.equal(release.modifiers,4);f.ack(release,{buttons:0,remainingMs:0,phase:'idle'});assert.equal(f.state.busy(),false);
});
test('rapid consecutive clicks use distinct gestures and wait for the previous written release',()=>{
  const f=fixture();f.event('press');f.event('release');f.event('press');f.event('release');assert.deepEqual(f.state.queue.map(c=>c.gesture),[1,1,2,2]);
  let c=f.command();f.ack(c,{gesture:1,nextGesture:2,buttons:1,remainingMs:1500,phase:'held'});
  c=f.command();f.ack(c,{buttons:1,remainingMs:1500,phase:'held'});assert.equal(f.command(),null);
  f.state.refresh({...f.state.snapshot,buttons:0,remainingMs:0,phase:'idle'});c=f.command();assert.equal(c.gesture,2);assert.equal(c.action,'press');f.ack(c,{gesture:2,nextGesture:3,buttons:1,remainingMs:1500,phase:'held'});
  c=f.command();f.ack(c,{buttons:0,remainingMs:0,phase:'idle'});assert.equal(f.state.busy(),false);
});
test('foreground heartbeat is required and request retries cannot supply it',()=>{
  const f=fixture();f.event('press');const press=f.command();f.advance(500);assert.deepEqual(f.command(),press);f.advance(101);assert.equal(f.command(),null);assert.equal(f.state.buttons,0);
  f.state.refresh(initial({acceptedSequence:1,writtenSequence:1,gesture:1,nextGesture:2,buttons:1,remainingMs:900,phase:'held'}));const cancel=f.command();assert.equal(cancel.action,'cancel');assert.equal(cancel.sequence,2);
  f.ack(cancel,{buttons:0,remainingMs:0,phase:'cancelled'});assert.equal(f.state.busy(),false);
});
test('held gestures renew only while a fresh renderer heartbeat is present',()=>{
  const f=fixture();f.event('press');f.ack(f.command(),{gesture:1,nextGesture:2,buttons:1,remainingMs:1500,phase:'held'});
  f.advance(400);f.state.heartbeat();const renew=f.command();assert.equal(renew.action,'renew');assert.equal(renew.gesture,1);f.ack(renew);
  f.advance(601);assert.equal(f.command().action,'cancel');assert.equal(f.state.buttons,0);
});
test('mode changes and timeout discard queued future clicks and never replay an abandoned press',()=>{
  const f=fixture();f.event('press');const pending=f.command();f.state.stop();f.state.refresh(initial());assert.equal(f.command(),null);assert.equal(f.state.pending,null);
  f.event('press');assert.equal(f.command().sequence,pending.sequence);f.ack(f.state.pending,{gesture:1,nextGesture:2,buttons:1,remainingMs:1500,phase:'held'});f.event('release');f.event('press');
  f.state.refresh({...f.state.snapshot,buttons:0,remainingMs:0,phase:'expired'});assert.equal(f.state.queue.length,0);assert.equal(f.state.buttons,0);assert.equal(f.command(),null);
  f.event('press');f.state.refresh({...f.state.snapshot,epoch:2,mode:1000});assert.equal(f.command(),null);assert.equal(f.state.buttons,0);
});
test('wheel and hover resume after cancellation while unsupported motion is rejected',()=>{
  const f=fixture();f.state.stop();f.command();f.state.refresh(initial({mode:1003}));f.event('move',{button:3});assert.equal(f.command().gesture,0);f.ack(f.state.pending);
  f.event('wheel',{button:3,modifiers:4});assert.equal(f.command().button,3);f.ack(f.state.pending);assert.equal(f.state.buttons,0);
  f.state.refresh({...f.state.snapshot,epoch:2,mode:1000});assert.throws(()=>f.event('move',{button:3}),/MOUSE_MODE/);
});
test('queue saturation cancels held state and never permits an unbounded event backlog',()=>{
  const f=fixture();f.event('press');f.ack(f.command(),{gesture:1,nextGesture:2,buttons:1,remainingMs:1500,phase:'held'});
  for(let n=0;n<32;n++)f.event('wheel');assert.throws(()=>f.event('wheel'),/MOUSE_FULL/);assert.equal(f.state.queue.length,0);assert.equal(f.state.buttons,0);assert.equal(f.command().action,'cancel');
});
