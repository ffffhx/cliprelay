'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.value='';}
  append(...nodes){this.children.push(...nodes);}setAttribute(name,value){this[name]=value;}
  all(predicate){return this.children.flatMap(node=>[...(predicate(node)?[node]:[]),...node.all(predicate)]);}
}
function fixture(){
  const context={document:{createElement:tag=>new Element(tag)}},calls=[],root=new Element('main');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/mac/bitrate-ui.js'),'utf8').replace('export function mountBitrate','function mountBitrate')+'\nthis.mountBitrate=mountBitrate;',context);
  let state={bitrate:{phase:'ready',canApply:true,viewId:'one',currentKbps:6000,videoKbps:4800}},reply;
  const ui=context.mountBitrate(root,async(action,data)=>{calls.push({action,data});return reply?await reply():state;});ui.render(state);
  const input=root.all(e=>e.tag==='input')[0],button=root.all(e=>e.tag==='button')[0],status=root.all(e=>e['aria-live']==='polite')[0];
  return {ui,input,button,status,calls,get state(){return state;},set(next){state=next;ui.render(state);},reply(fn){reply=fn;},draft(value){input.value=value;input.oninput();}};
}
test('live bitrate retains an edited draft during polling and sends only the bound budget',async()=>{
  const f=fixture();assert.equal(f.input.value,'6');f.draft('2.5');f.ui.render(f.state);assert.equal(f.input.value,'2.5');
  await f.button.onclick();assert.equal(JSON.stringify(f.calls[0]),JSON.stringify({action:'bitrate-apply',data:{viewId:'one',budgetKbps:2500}}));
  f.set({bitrate:{...f.state.bitrate,phase:'pending',canApply:false,requestedKbps:2500}});assert.equal(f.button.disabled,true);assert.match(f.status.textContent,/等待新画面/);await f.button.onclick();assert.equal(f.calls.length,1);
});
test('route replacement resets its draft and pending failures cannot overwrite the new panel',async()=>{
  const f=fixture();let reject;f.reply(()=>new Promise((_,r)=>reject=r));f.draft('2');const pending=f.button.onclick();
  f.set({bitrate:{...f.state.bitrate,viewId:'two',currentKbps:12000}});assert.equal(f.input.value,'12');reject(Error('old failure'));await pending;assert.ok(!f.status.textContent.includes('old failure'));
});
test('input bounds and unconfirmed outcomes do not imply success',async()=>{
  const f=fixture();f.draft('0.5');await f.button.onclick();assert.equal(f.calls.length,0);assert.match(f.status.textContent,/1–100/);
  f.set({bitrate:{...f.state.bitrate,viewId:'other',result:{kind:'unconfirmed',budgetKbps:6000}}});assert.match(f.status.textContent,/尚未确认/);
  f.set({bitrate:{...f.state.bitrate,result:{kind:'applied',budgetKbps:6000}}});assert.match(f.status.textContent,/已确认 6 Mbps 生效/);
});
