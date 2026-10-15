'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';}
  append(...nodes){this.children.push(...nodes);}setAttribute(name,value){this[name]=value;}
  all(predicate){return this.children.flatMap(node=>[...(predicate(node)?[node]:[]),...node.all(predicate)]);}
}
function fixture(){
  const root=new Element('main'),calls=[],context={document:{createElement:tag=>new Element(tag)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/mac/privacy-ui.js'),'utf8').replace('export function mountPrivacy','function mountPrivacy')+'\nthis.mountPrivacy=mountPrivacy;',context);
  let state={privacy:{viewId:'one',phase:'off',canEnable:true}},reply;
  const ui=context.mountPrivacy(root,async(action,data)=>{calls.push({action,data});return reply?await reply():state;});ui.render(state);
  const [enable,disable]=root.all(e=>e.tag==='button'),status=root.all(e=>e['aria-live']==='polite')[0];
  return {ui,enable,disable,status,calls,set(next){state={privacy:next};ui.render(state);},reply(fn){reply=fn;}};
}
test('privacy buttons send only the owned view token and explicit desired state',async()=>{
  const f=fixture();assert.equal(f.enable.disabled,false);assert.equal(f.disable.disabled,true);await f.enable.onclick();
  assert.equal(JSON.stringify(f.calls[0]),JSON.stringify({action:'privacy-set-enabled',data:{viewId:'one',enabled:true}}));
  f.set({viewId:'one',phase:'active',active:true,canDisable:true});assert.match(f.status.textContent,/电脑已确认/);await f.disable.onclick();
  assert.equal(JSON.stringify(f.calls[1]),JSON.stringify({action:'privacy-set-enabled',data:{viewId:'one',enabled:false}}));
});
test('pending, expired and unsupported states never claim privacy is active',async()=>{
  const f=fixture();
  for(const state of [{phase:'starting',canDisable:true},{phase:'restoring',canDisable:true},{phase:'unavailable',error:'PRIVACY_UNSUPPORTED'}]){
    f.set({viewId:'one',...state});assert.equal(f.enable.disabled,true);assert.ok(!f.status.textContent.includes('已确认'));await f.enable.onclick();
  }
  assert.equal(f.calls.length,0);assert.equal(f.disable.disabled,true);
});
test('late failure from a previous route cannot replace the new privacy state',async()=>{
  const f=fixture();let reject;f.reply(()=>new Promise((_,r)=>reject=r));const pending=f.enable.onclick();
  f.set({viewId:'two',phase:'off',canEnable:true});reject(Error('old failure'));await pending;
  assert.match(f.status.textContent,/未开启/);assert.ok(!f.status.textContent.includes('old failure'));assert.equal(f.enable.disabled,false);
});
