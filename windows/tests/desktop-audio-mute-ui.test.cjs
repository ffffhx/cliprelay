'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';}
  append(...nodes){this.children.push(...nodes);}setAttribute(name,value){this[name]=value;}
  all(predicate){return this.children.flatMap(node=>[...(predicate(node)?[node]:[]),...node.all(predicate)]);}
}
function fixture(){
  const root=new Element('main'),calls=[],context={document:{createElement:tag=>new Element(tag)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/mac/audio-mute-ui.js'),'utf8').replace('export function mountAudioMute','function mountAudioMute')+'\nthis.mountAudioMute=mountAudioMute;',context);
  let state={audioMute:{viewId:'one',phase:'off',canEnable:true}},reply;
  const ui=context.mountAudioMute(root,async(action,data)=>{calls.push({action,data});return reply?await reply():state;});ui.render(state);
  const [enable,disable]=root.all(e=>e.tag==='button'),status=root.all(e=>e['aria-live']==='polite')[0];
  return {ui,enable,disable,status,calls,set(next){state={audioMute:next};ui.render(state);},reply(fn){reply=fn;}};
}
test('audio buttons send only a view token and explicit boolean, with no endpoint or audio generation',async()=>{
  const f=fixture();assert.equal(f.enable.disabled,false);assert.equal(f.disable.disabled,true);await f.enable.onclick();
  assert.equal(JSON.stringify(f.calls[0]),JSON.stringify({action:'audio-mute-set-enabled',data:{viewId:'one',enabled:true}}));
  f.set({viewId:'one',phase:'active',active:true,canDisable:true});assert.match(f.status.textContent,/电脑已确认/);await f.disable.onclick();
  assert.equal(JSON.stringify(f.calls[1]),JSON.stringify({action:'audio-mute-set-enabled',data:{viewId:'one',enabled:false}}));
});
test('inactive recovery is distinct from restored and prevents a new mute request',async()=>{
  const f=fixture();f.set({viewId:'one',phase:'restoring',active:false,canDisable:true,error:'AUDIO_RECOVERY_PENDING'});
  assert.match(f.status.textContent,/仍在恢复/);assert.equal(f.enable.disabled,true);await f.enable.onclick();assert.equal(f.calls.length,0);
  f.set({viewId:'one',phase:'off',canEnable:true});assert.match(f.status.textContent,/未启用/);
  f.set({viewId:'one',phase:'unavailable',error:'AUDIO_UNSUPPORTED'});assert.match(f.status.textContent,/无法/);assert.equal(f.disable.disabled,true);
});
test('a late command failure cannot overwrite a replacement audio view',async()=>{
  const f=fixture();let reject;f.reply(()=>new Promise((_,r)=>reject=r));const pending=f.enable.onclick();
  f.set({viewId:'two',phase:'off',canEnable:true});reject(Error('old failure'));await pending;
  assert.match(f.status.textContent,/未启用/);assert.ok(!f.status.textContent.includes('old failure'));assert.equal(f.enable.disabled,false);
});
