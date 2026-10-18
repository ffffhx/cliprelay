'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';}
  append(...nodes){this.children.push(...nodes);}setAttribute(key,value){this[key]=value;}
  all(predicate){return this.children.flatMap(node=>[...(predicate(node)?[node]:[]),...node.all(predicate)]);}
}
function fixture({initial={available:true,checking:false,busy:false,screenRecording:null,inputControl:null,checkedAt:null,error:null},request}={}){
  const root=new Element('main'),calls=[],events=new Map();let closed=0;
  const context={document:{createElement:tag=>new Element(tag)},window:{addEventListener:(key,fn)=>events.set(key,fn),removeEventListener:key=>events.delete(key)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/mac/host-permission-ui.js'),'utf8').replace('export function mount','function mount')+'\nthis.mount=mount;',context);
  const checked={...initial,checkedAt:123,screenRecording:false,inputControl:false},api={request:async(action,data)=>{calls.push({action,data});return request?await request(action,data):checked;}};
  const ui=context.mount(root,api,()=>{closed++;},initial);
  return {root,ui,calls,events,checked,buttons:root.all(e=>e.tag==='button'),statuses:root.all(e=>e.tag==='span'),notice:root.all(e=>e.role==='status')[0],get closed(){return closed;}};
}
test('opening the permission view only queries; buttons request their exact target and denial stays visible',async()=>{
  const f=fixture();await f.ui.ready;assert.deepEqual(f.calls.map(c=>c.action),['host-permissions-check']);
  for(const [index,permission] of [[0,'screenRecording'],[1,'inputControl']]){
    assert.equal(f.buttons[index].disabled,false);await f.buttons[index].onclick();assert.equal(JSON.stringify(f.calls.at(-1)),JSON.stringify({action:'host-permissions-request',data:{permission}}));
    assert.equal(f.statuses[index].textContent,'未允许');
  }
  f.buttons[3].onclick();assert.equal(f.closed,1);f.ui.close();
});
test('checking clears old grants, prevents overlapping commands and rechecks when focus returns',async()=>{
  let finish;const f=fixture({initial:{available:true,screenRecording:true,inputControl:true,checkedAt:1},request:()=>new Promise(resolve=>finish=resolve)});
  assert.equal(f.statuses[0].textContent,'未确认');assert.ok(f.buttons.slice(0,3).every(b=>b.disabled));
  f.events.get('focus')();await f.buttons[0].onclick();assert.equal(f.calls.length,1);
  finish(f.checked);await f.ui.ready;f.events.get('focus')();assert.equal(f.calls.length,2);finish(f.checked);await new Promise(resolve=>setImmediate(resolve));f.ui.close();
});
test('missing engine disables native requests without creating a command',async()=>{
  const f=fixture({initial:{available:false,error:'HOST_ENGINE_UNAVAILABLE'}});await f.ui.ready;
  assert.equal(f.calls.length,0);assert.ok(f.buttons.slice(0,3).every(b=>b.disabled));assert.match(f.notice.textContent,/未包含/);f.ui.close();
});
test('query failure never keeps a previous grant or exposes raw process diagnostics',async()=>{
  const f=fixture({initial:{available:true,screenRecording:true,inputControl:true,checkedAt:1},request:async()=>{throw Error('/private/secret');}});await f.ui.ready;
  assert.ok(f.statuses.every(s=>s.textContent==='未确认'));assert.ok(f.buttons.slice(0,2).every(b=>b.disabled));assert.equal(f.buttons[2].disabled,false);assert.ok(!f.notice.textContent.includes('secret'));f.ui.close();
});
test('closed views ignore late command completion and remove focus handlers',async()=>{
  let finish;const f=fixture({request:()=>new Promise(resolve=>finish=resolve)});f.ui.close();const before=f.notice.textContent;
  finish({...f.checked,screenRecording:true,inputControl:true});await f.ui.ready;assert.equal(f.notice.textContent,before);assert.equal(f.events.has('focus'),false);
});
test('opening settings keeps permission ungranted until a later successful system query',async()=>{
  let allowed=false;const f=fixture({request:async(action,data)=>({available:true,checkedAt:1,busy:false,
    screenRecording:allowed,inputControl:false,error:null,settingsOpened:action==='host-permissions-request'?data.permission:null})});
  await f.ui.ready;await f.buttons[0].onclick();assert.equal(f.statuses[0].textContent,'未允许');
  assert.match(f.notice.textContent,/已打开系统设置/);assert.equal(f.buttons[0].disabled,false);
  allowed=true;await f.buttons[2].onclick();assert.equal(f.statuses[0].textContent,'已允许');assert.equal(f.buttons[0].disabled,true);f.ui.close();
});
