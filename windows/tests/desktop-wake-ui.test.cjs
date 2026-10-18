'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.value='';this.checked=false;}
  append(...nodes){this.children.push(...nodes);if(this.tag==='select'&&!this.value)this.value=nodes[0]?.value||'';}setAttribute(name,value){this[name]=value;}
  replaceChildren(...nodes){this.children=[];this.value='';this.append(...nodes);}
  all(predicate){return this.children.flatMap(node=>[...(predicate(node)?[node]:[]),...node.all(predicate)]);}
}
function fixture(){
  const root=new Element('main'),calls=[],context={document:{createElement:tag=>new Element(tag)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/mac/wake-ui.js'),'utf8').replace('export function mountWake','function mountWake')+'\nthis.mountWake=mountWake;',context);
  let state={wake:{viewId:'one',phase:'ready',canPrepare:true}},reply;
  const ui=context.mountWake(root,async(action,data)=>{calls.push({action,data});return reply?await reply():state;});ui.render(state);
  const [prepare,send,retry,stop,forget,save]=root.all(e=>e.tag==='button'),[adapter,helper]=root.all(e=>e.tag==='select'),consent=root.all(e=>e.tag==='input')[0],status=root.all(e=>e['aria-live']==='polite')[0];
  return {ui,prepare,send,retry,stop,forget,save,adapter,helper,consent,status,calls,set(next){state={wake:next};ui.render(state);},reply(fn){reply=fn;}};
}
const choosing=()=>({viewId:'one',phase:'choosing',canSave:true,adapters:[{id:'opaque-adapter',label:'Ethernet',configuration:'unknown'}],helpers:[{id:'opaque-helper',label:'Helper'}]});
test('wake setup requires explicit LAN confirmation and sends opaque choices only',async()=>{
  const f=fixture();await f.prepare.onclick();assert.equal(JSON.stringify(f.calls[0]),JSON.stringify({action:'wake-prepare',data:{viewId:'one'}}));f.set(choosing());
  assert.equal(f.save.disabled,true);await f.save.onclick();assert.equal(f.calls.length,1);
  f.consent.checked=true;f.consent.onchange();assert.equal(f.save.disabled,false);await f.save.onclick();
  assert.equal(JSON.stringify(f.calls[1]),JSON.stringify({action:'wake-save',data:{viewId:'one',adapter:'opaque-adapter',helper:'opaque-helper',sameLan:true}}));
  assert.match(f.adapter.children[0].textContent,/待确认/);f.set({...choosing(),viewId:'two'});assert.equal(f.consent.checked,false);
  f.consent.checked=true;f.helper.onchange();assert.equal(f.consent.checked,false);assert.equal(f.save.disabled,true);
});
test('packet sent, uncertain send and observed target response have distinct text and controls',async()=>{
  const f=fixture();f.set({viewId:'one',phase:'waiting',packetSent:true,canStop:true});assert.match(f.status.textContent,/已发送.*等待目标/);assert.equal(f.send.disabled,true);
  await f.stop.onclick();assert.equal(f.calls[0].action,'wake-stop');f.set({viewId:'one',phase:'unconfirmed',packetSent:false,canRetry:true});assert.match(f.status.textContent,/结果未确认.*可能已经发出/);
  await f.retry.onclick();assert.equal(f.calls[1].action,'wake-retry');f.set({viewId:'one',phase:'unconfirmed',packetSent:true});assert.match(f.status.textContent,/已确认发送.*尚未确认目标上线/);
  f.set({viewId:'one',phase:'online'});assert.match(f.status.textContent,/目标电脑响应/);
});
test('offline helper disables send and late failures cannot replace a changed target view',async()=>{
  const f=fixture();f.set({viewId:'one',phase:'ready',configured:true,helperReady:false});await f.send.onclick();assert.equal(f.calls.length,0);
  f.set({viewId:'one',phase:'ready',canSend:true});let reject;f.reply(()=>new Promise((_,r)=>reject=r));const pending=f.send.onclick();
  f.set({viewId:'two',phase:'ready',canPrepare:true});reject(Error('old target failed'));await pending;assert.ok(!f.status.textContent.includes('old target'));assert.equal(f.prepare.disabled,false);
});
