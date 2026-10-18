'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';}
  append(...nodes){this.children.push(...nodes);}setAttribute(name,value){this[name]=value;}
  all(predicate){return this.children.flatMap(node=>[...(predicate(node)?[node]:[]),...node.all(predicate)]);}
}
function fixture(){
  const root=new Element('main'),calls=[],context={document:{createElement:tag=>new Element(tag)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/mac/session-lock-ui.js'),'utf8').replace('export function mountSessionLock','function mountSessionLock')+'\nthis.mountSessionLock=mountSessionLock;',context);
  let state={sessionLock:{viewId:'one',phase:'off',canArm:true}},reply;
  const ui=context.mountSessionLock(root,async(action,data)=>{calls.push({action,data});return reply?await reply():state;});ui.render(state);
  const [enable,disable]=root.all(e=>e.tag==='button'),status=root.all(e=>e['aria-live']==='polite')[0];
  return {root,ui,enable,disable,status,calls,set(next){state={sessionLock:next};ui.render(state);},reply(fn){reply=fn;}};
}
test('lock controls require an explicit click and send only a view token and boolean',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);assert.equal(f.enable.disabled,false);assert.equal(f.disable.disabled,true);await f.enable.onclick();
  assert.equal(JSON.stringify(f.calls[0]),JSON.stringify({action:'session-lock-set-enabled',data:{viewId:'one',enabled:true}}));
  f.set({viewId:'one',phase:'armed',armed:true,canDisarm:true});assert.match(f.status.textContent,/电脑已确认本次远控结束后锁屏/);await f.disable.onclick();
  assert.equal(JSON.stringify(f.calls[1]),JSON.stringify({action:'session-lock-set-enabled',data:{viewId:'one',enabled:false}}));
  assert.ok(f.root.all(e=>e.tag==='p').some(e=>e.textContent.includes('关闭控制端仍会保留')));
});
test('pending cancel and OS request are distinct from off, and executed lock is explicitly historical',async()=>{
  const f=fixture();f.set({viewId:'one',phase:'cancelling',error:'LOCK_CANCEL_PENDING'});assert.match(f.status.textContent,/取消尚未确认.*仍可能/);
  assert.equal(f.enable.disabled,true);await f.enable.onclick();assert.equal(f.calls.length,0);
  f.set({viewId:'one',phase:'requested'});assert.match(f.status.textContent,/等待系统确认/);assert.equal(f.disable.disabled,true);
  f.set({viewId:'one',phase:'locked'});assert.match(f.status.textContent,/曾确认.*手动解锁不会再次锁屏/);
  f.set({viewId:'one',phase:'failed'});assert.match(f.status.textContent,/未获得系统成功确认/);
  f.set({viewId:'one',phase:'off'});assert.match(f.status.textContent,/未安排/);
  f.set({viewId:'one',phase:'unconfirmed'});assert.match(f.status.textContent,/未确认.*仍可能/);
  f.set({viewId:'one',phase:'off',error:'LOCK_UPDATE_REQUIRED'});assert.match(f.status.textContent,/更新被控电脑/);
});
test('a delayed action failure cannot replace a new lock view',async()=>{
  const f=fixture();let reject;f.reply(()=>new Promise((_,r)=>reject=r));const pending=f.enable.onclick();
  f.set({viewId:'two',phase:'off',canArm:true});reject(Error('old failure'));await pending;
  assert.match(f.status.textContent,/未安排/);assert.ok(!f.status.textContent.includes('old failure'));assert.equal(f.enable.disabled,false);
});
