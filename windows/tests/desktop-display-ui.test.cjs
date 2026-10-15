'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.value='';}
  append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[...nodes];}setAttribute(name,value){this[name]=value;}
  all(predicate){return this.children.flatMap(node=>[...(predicate(node)?[node]:[]),...node.all(predicate)]);}
}
function fixture(){
  const root=new Element('main'),calls=[],context={document:{createElement:tag=>new Element(tag)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/mac/display-ui.js'),'utf8').replace('export function mountDisplays','function mountDisplays')+'\nthis.mountDisplays=mountDisplays;',context);
  let state={displays:{phase:'ready',canSelect:true,viewId:'one',displays:['left','right'],capture:'left'}},reply;
  const ui=context.mountDisplays(root,async(action,data)=>{calls.push({action,data});return reply?await reply():state;});ui.render(state);
  const select=root.all(e=>e.tag==='select')[0],button=root.all(e=>e.tag==='button')[0],status=root.all(e=>e['aria-live']==='polite')[0];
  return {ui,select,button,status,calls,get state(){return state;},set(next){state=next;ui.render(state);},reply(fn){reply=fn;},draft(value){select.value=value;select.onchange();}};
}
test('display polling preserves a choice and sends only the bound display selection',async()=>{
  const f=fixture();assert.equal(f.select.value,'left');f.draft('right');f.ui.render(f.state);assert.equal(f.select.value,'right');await f.button.onclick();
  assert.equal(JSON.stringify(f.calls[0]),JSON.stringify({action:'display-select',data:{viewId:'one',display:'right'}}));
  f.set({displays:{...f.state.displays,phase:'switching',canSelect:false}});assert.equal(f.button.disabled,true);assert.match(f.status.textContent,/等待新画面/);
  await f.button.onclick();assert.equal(f.calls.length,1);
});
test('route replacement and hotplug invalidate obsolete selection and asynchronous errors',async()=>{
  const f=fixture();let reject;f.reply(()=>new Promise((_,r)=>reject=r));f.draft('right');const pending=f.button.onclick();
  f.set({displays:{...f.state.displays,viewId:'two',displays:['new'],capture:'new'}});reject(Error('old error'));await pending;
  assert.equal(f.select.value,'new');assert.ok(!f.status.textContent.includes('old error'));
  f.draft('removed');f.ui.render(f.state);assert.equal(f.select.value,'new');
});
test('unsupported and pending states never claim that input has resumed',()=>{
  const f=fixture();f.set({displays:{...f.state.displays,phase:'unavailable',canSelect:false,error:'DISPLAY_UNSUPPORTED'}});assert.match(f.status.textContent,/更新两端/);assert.equal(f.button.disabled,true);
  f.set({displays:{...f.state.displays,phase:'switching',canSelect:false,result:{kind:'applied'}}});assert.ok(!f.status.textContent.includes('输入已恢复'));
  f.set({displays:{...f.state.displays,phase:'ready',canSelect:true,error:'',result:{kind:'applied'}}});assert.match(f.status.textContent,/输入已恢复/);
});
