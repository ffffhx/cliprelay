'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';}append(...nodes){this.children.push(...nodes);}prepend(...nodes){this.children.unshift(...nodes);}setAttribute(name,value){this[name]=value;}
  all(predicate){return this.children.flatMap(node=>[...(predicate(node)?[node]:[]),...node.all(predicate)]);}
}
function fixture(){
  const root=new Element('main'),calls=[],context={document:{createElement:tag=>new Element(tag)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/mac/clipboard-ui.js'),'utf8').replace('export function mountClipboard','function mountClipboard')+'\nthis.mountClipboard=mountClipboard;',context);
  let state={clipboardSync:{viewId:'one',phase:'off',enabled:false,canConfigure:true,canReceive:true,canResume:false}},reply;
  const ui=context.mountClipboard(root,async(action,data)=>{calls.push({action,data});return reply?await reply(action,data):state;});ui.render(state);
  const enabled=root.all(e=>e.tag==='input')[0],[receive,resume]=root.all(e=>e.tag==='button'),status=root.all(e=>e['aria-live']==='polite')[0];
  return {ui,enabled,receive,resume,status,calls,set(value){state=value;ui.render(state);},reply(fn){reply=fn;}};
}
test('clipboard controls use only view tokens and explicit booleans; receive remains available while sync is off',async()=>{
  const f=fixture();assert.equal(f.enabled.checked,false);assert.equal(f.receive.disabled,false);assert.equal(f.resume.disabled,true);
  f.enabled.checked=true;await f.enabled.onchange();assert.equal(JSON.stringify(f.calls[0]),JSON.stringify({action:'clipboard-set-enabled',data:{viewId:'one',enabled:true}}));
  await f.receive.onclick();assert.equal(JSON.stringify(f.calls[1]),JSON.stringify({action:'clipboard-receive',data:{viewId:'one'}}));assert.match(f.status.textContent,/已取回/);
});
test('conflicts display a pause and explicit resume; disconnected controls cannot receive',async()=>{
  const f=fixture();f.set({clipboardSync:{viewId:'one',enabled:true,phase:'conflict',message:'两端内容不同，已暂停',canConfigure:true,canReceive:true,canResume:true}});
  assert.match(f.status.textContent,/已暂停/);await f.resume.onclick();assert.equal(f.calls[0].action,'clipboard-resume');
  f.set({clipboardSync:{viewId:'two',enabled:true,phase:'waiting',canConfigure:true,canReceive:false,canResume:false}});await f.receive.onclick();assert.equal(f.calls.length,1);assert.match(f.status.textContent,/等待/);
});
test('a pending command cannot repeat or inject an old error after switching computers',async()=>{
  const f=fixture();let reject;f.reply(()=>new Promise((_,r)=>{reject=r;}));const pending=f.receive.onclick();assert.equal(f.enabled.disabled,true);await f.receive.onclick();assert.equal(f.calls.length,1);
  f.set({clipboardSync:{viewId:'new computer',phase:'off',enabled:false,canConfigure:true,canReceive:true,canResume:false}});reject(new Error('old failure'));await pending;
  assert.ok(!f.status.textContent.includes('old failure'));assert.equal(f.enabled.checked,false);assert.equal(f.enabled.disabled,false);
});
