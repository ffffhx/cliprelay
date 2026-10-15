'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {TerminalMouse}=require('../electron/mac/terminal-mouse-ui.js');
function fixture(t,extra={}){
  class Target{constructor(){this.listeners={};}addEventListener(name,fn,options){(this.listeners[name] ||= []).push({fn,capture:options===true || options?.capture});}removeEventListener(name,fn){this.listeners[name]=(this.listeners[name] || []).filter(v=>v.fn!==fn);}emit(name,extra={}){const e={target:element,button:0,buttons:1,clientX:145,clientY:245,detail:1,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};for(const item of [...(this.listeners[name] || [])].sort((a,b)=>Number(b.capture)-Number(a.capture))){item.fn(e);if(e.stopped)break;}return e;}}
  const window=new Target(),document=new Target(),element=new Target(),calls=[],problems=[];let focused=true,selection=null,heartbeat;
  window.setInterval=fn=>{heartbeat=fn;return 1;};window.clearInterval=()=>{};document.hasFocus=()=>focused;document.hidden=false;
  element.contains=target=>target===element;element.querySelector=()=>({getBoundingClientRect:()=>({left:100,top:100,right:1100,bottom:700,width:1000,height:600})});
  const term={cols:100,rows:30,modes:{mouseTrackingMode:'drag'},buffer:{active:{viewportY:0,baseY:0,getLine:()=>({getCell:()=>({getChars:()=> 'x'})})}},focus(){},clearSelection(){selection=null;},select(x,y,length){selection={start:{x,y},end:{x:(y*100+x+length)%100,y:Math.floor((y*100+x+length)/100)}};},selectLines(a,b){selection={start:{x:0,y:a},end:{x:100,y:b}};},getSelectionPosition:()=>selection,scrollLines(n){this.buffer.active.viewportY+=n;}};
  const state={view:'view',id:'session',epoch:1,revision:0,mode:1002,format:1006,supported:true,available:true,ready:true,blocked:false,...extra};
  const mouse=new TerminalMouse({window,document,element,term,getState:()=>state,send:async data=>{calls.push(data);return {ok:true};},problem:text=>problems.push(text)});mouse.sync();t.after(()=>mouse.dispose());
  return {mouse,window,document,element,term,state,calls,problems,heartbeat:()=>heartbeat(),focus:value=>focused=value,get selection(){return selection;}};
}
test('captured right/middle drag events carry modifiers without reaching raw xterm listeners',async t=>{
  const f=fixture(t);let raw=0;f.element.addEventListener('mousedown',()=>raw++,false);
  const down=f.element.emit('mousedown',{button:2,buttons:2,shiftKey:true,altKey:true,ctrlKey:true});assert.ok(down.prevented && down.stopped);assert.equal(raw,0);await f.mouse.chain;
  f.window.emit('mousemove',{buttons:2,clientX:165,clientY:265,ctrlKey:true});await f.mouse.chain;f.window.emit('mouseup',{button:2,buttons:0,clientX:165,clientY:265,ctrlKey:true});await f.mouse.chain;
  assert.deepEqual(f.calls.map(c=>[c.action,c.button,c.modifiers,c.column,c.row]),[['press',2,28,5,8],['move',2,16,7,9],['release',2,16,7,9]]);
  f.element.emit('mousedown',{button:1,buttons:4});await f.mouse.chain;f.window.emit('mouseup',{button:1,buttons:0});await f.mouse.chain;assert.equal(f.calls.at(-1).button,1);
  f.window.addEventListener('mouseup',()=>raw++,false);assert.ok(f.window.emit('mouseup',{buttons:0}).stopped);assert.equal(raw,0);
});
test('hover and horizontal/vertical wheel use requested modes and bounded event counts',async t=>{
  const f=fixture(t,{mode:1003});f.window.emit('mousemove',{buttons:0});await f.mouse.chain;assert.equal(f.calls[0].button,3);
  f.element.emit('wheel',{buttons:0,deltaX:-2,deltaY:1000,deltaMode:1,shiftKey:true});await f.mouse.chain;
  assert.equal(f.calls.filter(c=>c.action==='wheel').length,10);assert.equal(f.calls.filter(c=>c.action==='wheel' && c.button===2).length,2);assert.equal(f.calls.filter(c=>c.action==='wheel' && c.button===1).length,8);
  f.state.mode=1000;const before=f.calls.length;f.window.emit('mousemove',{buttons:0});await f.mouse.chain;assert.equal(f.calls.length,before);
});
test('leaving the window, losing focus or losing physical button state cancels renewal',async t=>{
  const f=fixture(t);
  for(const stop of [()=>f.window.emit('mouseout',{relatedTarget:null}),()=>{f.focus(false);f.heartbeat();},()=>f.window.emit('mousemove',{buttons:0})]){
    f.focus(true);f.element.emit('mousedown');await f.mouse.chain;stop();await f.mouse.chain;assert.equal(f.mouse.held,0);assert.equal(f.calls.at(-1).action,'cancel');const count=f.calls.length;f.heartbeat();await f.mouse.chain;assert.equal(f.calls.length,count);
  }
});
test('selection mode permits local text selection without mouse writes or raw xterm events',async t=>{
  const f=fixture(t);f.mouse.toggle();f.element.emit('mousedown',{clientX:100,clientY:100});f.window.emit('mousemove',{clientX:130,clientY:100});f.window.emit('mouseup',{buttons:0,clientX:130,clientY:100});await f.mouse.chain;
  assert.deepEqual(f.selection,{start:{x:0,y:0},end:{x:3,y:0}});assert.deepEqual(f.calls.map(c=>c.action),['cancel']);
  f.element.emit('mousedown',{clientX:105,clientY:145,detail:3});f.window.emit('mouseup',{buttons:0});assert.deepEqual(f.selection,{start:{x:0,y:2},end:{x:100,y:2}});
  f.state.blocked=true;f.element.emit('mousedown',{clientX:100,clientY:100});f.mouse.sync();assert.equal(f.mouse.selecting,true);f.window.emit('mousemove',{clientX:120,clientY:100});f.window.emit('mouseup',{clientX:120,clientY:100,buttons:0});assert.deepEqual(f.selection,{start:{x:0,y:0},end:{x:2,y:0}});
});
test('selection boundaries do not split the continuation cell of a wide character',async t=>{
  const f=fixture(t);f.term.buffer.active.getLine=()=>({getCell:i=>({getWidth:()=>i===0?2:i===1?0:1,getChars:()=>i===0?'中':i===1?'':' '})});
  f.mouse.toggle();f.element.emit('mousedown',{clientX:105,clientY:100});f.window.emit('mousemove',{clientX:115,clientY:100});f.window.emit('mouseup',{clientX:115,clientY:100,buttons:0});await f.mouse.chain;
  assert.deepEqual(f.selection,{start:{x:0,y:0},end:{x:2,y:0}});assert.deepEqual(f.calls.map(c=>c.action),['cancel']);
});
test('old hosts remain selectable and never receive unsafe opaque mouse reports',async t=>{
  const f=fixture(t,{supported:false,available:false,ready:false});f.element.emit('mousedown',{clientX:100,clientY:100});f.window.emit('mousemove',{clientX:150,clientY:100});f.window.emit('mouseup',{buttons:0});await f.mouse.chain;
  assert.equal(f.calls.length,0);assert.ok(f.selection);assert.match(f.mouse.description(),/更新/);
});
test('an in-flight renderer request cannot retain an unbounded or stale mouse backlog',async t=>{
  const f=fixture(t);let finish;f.mouse.send=data=>{f.calls.push(data);return new Promise(resolve=>{finish=resolve;});};
  f.element.emit('mousedown');for(let n=0;n<500;n++)f.window.emit('mousemove',{clientX:200+n%100});assert.equal(f.mouse.outbox.length,1);
  f.state.view='new-view';f.mouse.sync();finish({ok:true});await f.mouse.chain;assert.equal(f.calls.length,1);assert.equal(f.mouse.held,0);assert.equal(f.mouse.outbox.length,0);
});
