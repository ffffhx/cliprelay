'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';}
  append(...nodes){this.children.push(...nodes);}setAttribute(name,value){this[name]=value;}
  all(predicate){return this.children.flatMap(node=>[...(predicate(node)?[node]:[]),...node.all(predicate)]);}
}
function fixture(){
  const root=new Element('main'),calls=[],context={document:{createElement:tag=>new Element(tag)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/mac/input-ui.js'),'utf8').replace('export function mountInput','function mountInput')+'\nthis.mountInput=mountInput;',context);
  let state={displays:{viewId:'one',input:{phase:'active',manualPaused:false,canPause:true,canResume:false}}},reply;
  const ui=context.mountInput(root,async(action,data)=>{calls.push({action,data});return reply?await reply():state;});ui.render(state);
  const [pause,resume]=root.all(e=>e.tag==='button'),status=root.all(e=>e['aria-live']==='polite')[0];
  return {ui,pause,resume,status,calls,get state(){return state;},set(next){state=next;ui.render(state);},reply(fn){reply=fn;}};
}
test('pause and explicit resume send only a view token and desired boolean state',async()=>{
  const f=fixture();assert.equal(f.pause.disabled,false);assert.equal(f.resume.disabled,true);await f.pause.onclick();
  assert.equal(JSON.stringify(f.calls[0]),JSON.stringify({action:'input-set-paused',data:{viewId:'one',paused:true}}));
  f.set({displays:{viewId:'one',input:{phase:'paused',manualPaused:true,canPause:false,canResume:true}}});assert.match(f.status.textContent,/保持暂停/);
  await f.resume.onclick();assert.equal(JSON.stringify(f.calls[1]),JSON.stringify({action:'input-set-paused',data:{viewId:'one',paused:false}}));
});
test('pending and unsupported controls cannot send repeated commands or report resumed input',async()=>{
  const f=fixture();f.set({displays:{viewId:'one',input:{phase:'resuming',manualPaused:true,canPause:false,canResume:false}}});
  await f.pause.onclick();await f.resume.onclick();assert.equal(f.calls.length,0);assert.match(f.status.textContent,/等待恢复/);assert.ok(!f.status.textContent.includes('已开启'));
  f.set({displays:{input:{phase:'unavailable'}}});assert.equal(f.pause.disabled,true);assert.equal(f.resume.disabled,true);
});
test('route replacement discards a late command failure and preserves the new pause indicator',async()=>{
  const f=fixture();let reject;f.reply(()=>new Promise((_,r)=>reject=r));const pending=f.pause.onclick();
  f.set({displays:{viewId:'two',input:{phase:'paused',manualPaused:true,canPause:false,canResume:true}}});reject(Error('old failure'));await pending;
  assert.match(f.status.textContent,/保持暂停/);assert.ok(!f.status.textContent.includes('old failure'));assert.equal(f.resume.disabled,false);
});
