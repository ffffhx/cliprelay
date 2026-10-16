'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';}
  append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}setAttribute(key,value){this[key]=value;}
  all(predicate){return this.children.flatMap(node=>[...(predicate(node)?[node]:[]),...node.all(predicate)]);}
}
const request={id:'a'.repeat(32),generation:'b'.repeat(32),name:'<script>fixture device</script>',verification:'1234 ABCD 5678',expires:Math.floor(Date.now()/1000)+120,state:'waiting'};
function fixture({initial={available:true,phase:'running',error:null,requests:[request]},request:send}={}){
  const root=new Element('main'),events=new Map(),calls=[];let interval,cleared=false,closed=0;
  const context={document:{createElement:tag=>new Element(tag)},window:{addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)},
    setInterval:fn=>{interval=fn;return 1;},clearInterval:()=>{cleared=true;},Date};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/mac/host-ui.js'),'utf8').replace('export function mount','function mount')+'\nthis.mount=mount;',context);
  const api={request:async(action,data)=>{calls.push({action,data});return send?send(action,data):initial;}};
  const ui=context.mount(root,api,()=>{closed++;},initial);
  return {root,ui,calls,events,get interval(){return interval;},get cleared(){return cleared;},get closed(){return closed;},button:text=>root.all(node=>node.tag==='button' && node.textContent===text)[0]};
}
test('opening settings only reads status; approval requires explicit code confirmation and carries the exact generation',async()=>{
  const f=fixture();await f.ui.ready;assert.deepEqual(f.calls.map(value=>value.action),['host-status']);
  assert.equal(f.root.all(node=>node.tag==='h2')[0].textContent,request.name);
  assert.equal(f.button('允许连接').disabled,true);await f.button('允许连接').onclick();assert.equal(f.calls.length,1);
  const checkbox=f.root.all(node=>node.type==='checkbox')[0];checkbox.checked=true;checkbox.onchange();await f.button('允许连接').onclick();
  assert.equal(f.calls.at(-2).action,'host-status');assert.equal(f.calls.at(-1).action,'host-pair-approve');
  assert.equal(JSON.stringify(f.calls.at(-1).data),JSON.stringify({id:request.id,generation:request.generation,verification:request.verification}));f.ui.close();
});
test('confirmation survives refresh of the same request and resets for a new generation',async()=>{
  let current=request;const f=fixture({request:()=>({available:true,phase:'running',requests:[current]})});await f.ui.ready;
  const checkbox=f.root.all(node=>node.type==='checkbox')[0];checkbox.checked=true;checkbox.onchange();await f.ui.refresh();assert.equal(f.button('允许连接').disabled,false);
  current={...request,generation:'c'.repeat(32)};await f.ui.refresh();assert.equal(f.button('允许连接').disabled,true);f.ui.close();
});
test('reject needs no approval checkbox and window close leaves hosting intact',async()=>{
  const f=fixture();await f.ui.ready;await f.button('拒绝').onclick();assert.equal(f.calls.at(-1).action,'host-pair-reject');
  f.button('关闭').onclick();assert.equal(f.closed,1);assert.ok(!f.calls.some(value=>value.action==='host-stop'));f.ui.close();assert.equal(f.cleared,true);
});
test('unavailable and starting states gate actions; permission navigation only happens on click',async()=>{
  const unavailable=fixture({initial:{available:false,phase:'stopped',requests:[]}});await unavailable.ui.ready;assert.equal(unavailable.button('启动远程访问').disabled,true);unavailable.ui.close();
  const f=fixture({initial:{available:true,phase:'starting',requests:[]}});await f.ui.ready;assert.equal(f.button('启动远程访问').disabled,true);assert.equal(f.button('停止远程访问').disabled,false);
  assert.ok(!f.calls.some(value=>value.action==='host-open-permissions'));await f.button('检查系统权限').onclick();assert.equal(f.calls.at(-1).action,'host-open-permissions');f.ui.close();
});
test('late polling cannot undo a stop or update a closed settings window',async()=>{
  let finish;const f=fixture({request:action=>action==='host-status'?new Promise(resolve=>finish=resolve):{available:true,phase:'stopped',requests:[]}});
  await f.button('停止远程访问').onclick();finish({available:true,phase:'running',requests:[request]});await f.ui.ready;
  assert.equal(f.button('启动远程访问').disabled,false);assert.equal(f.button('停止远程访问').disabled,true);
  const reading=f.ui.refresh();f.ui.close();const before=f.root.all(node=>node.role==='status')[0].textContent;
  finish({available:true,phase:'running',requests:[request]});await reading;assert.equal(f.root.all(node=>node.role==='status')[0].textContent,before);assert.equal(f.events.has('focus'),false);
});

const client={uuid:'aaaaaaaa-1111-2222-3333-444444444444',name:'<img src=invalid> laptop',enabled:true};
const clientState=()=>({available:true,phase:'running',requests:[],clients:{phase:'ready',viewId:'a'.repeat(32),devices:[client],error:null,revoking:null}});
test('saved client names are literal and revoke requires confirmation bound to the current view',async()=>{
  let state=clientState();const f=fixture({initial:state,request:(action)=>{if(action==='host-client-revoke')state={...state,clients:{...state.clients,devices:[]}};return state;}});await f.ui.ready;
  assert.equal(f.root.all(node=>node.tag==='h3')[0].textContent,client.name);
  f.button('撤销访问权限').onclick();assert.equal(f.calls.filter(call=>call.action==='host-client-revoke').length,0);
  f.button('取消').onclick();assert.equal(f.button('确认撤销'),undefined);
  f.button('撤销访问权限').onclick();await f.button('确认撤销').onclick();
  assert.equal(JSON.stringify(f.calls.at(-1)),JSON.stringify({action:'host-client-revoke',data:{viewId:'a'.repeat(32),uuid:client.uuid}}));
  assert.equal(f.button('撤销访问权限'),undefined);assert.ok(f.root.all(node=>node.textContent.includes('已撤销该设备')).length);f.ui.close();
});
test('a replacement host session discards a pending device confirmation',async()=>{
  let state=clientState();const f=fixture({initial:state,request:()=>state});await f.ui.ready;f.button('撤销访问权限').onclick();
  state={...state,clients:{...state.clients,viewId:'b'.repeat(32)}};await f.ui.refresh();assert.equal(f.button('确认撤销'),undefined);
  state={...state,clients:{...state.clients,phase:'revoking',revoking:client.uuid}};await f.ui.refresh();assert.equal(f.button('正在撤销…').disabled,true);f.ui.close();
});
test('a partially failed revoke keeps the disabled device visible without claiming success',async()=>{
  let state=clientState();const f=fixture({initial:state,request:action=>{
    if(action==='host-client-revoke'){state={...state,clients:{...state.clients,error:'HOST_CLIENTS_UNCONFIRMED',devices:[{...client,enabled:false}]}};throw Error('private detail');}return state;
  }});await f.ui.ready;f.button('撤销访问权限').onclick();await f.button('确认撤销').onclick();
  assert.ok(f.root.all(node=>node.textContent.startsWith('已停用')).length);assert.equal(f.root.all(node=>node.textContent.includes('已撤销该设备')).length,0);
  assert.equal(f.root.all(node=>node.textContent.includes('private detail')).length,0);assert.equal(f.button('确认撤销').disabled,false);f.ui.close();
});
