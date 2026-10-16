'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.style={};this.dataset={};this.value='';this.checked=false;this.disabled=false;this.hidden=false;}
  append(node){this.children.push(node);if(this.tag==='select' && this.children.length===1)this.value=node.value;}
  replaceChildren(){this.children=[];this.value='';}remove(){}querySelector(){return null;}
}
const waiting={id:'a'.repeat(32),generation:'b'.repeat(32),verification:'1234 ABCD 5678',name:'<img> device',address:'1234 ABCD 5678',automatic:true,state:'waiting',expires:1120};
async function fixture(){
  const root=new Element('root'),calls=[];let tick,clock=10000,peers=[{...waiting}],saved={viewId:'d'.repeat(32),named_certs:[]},hold,closed=false;
  const context={document:{createElement:tag=>new Element(tag),documentElement:{style:{}},body:{style:{}}},
    Date:{now:()=>clock},setInterval:callback=>{tick=callback;return 1;},clearInterval:()=>{closed=true;}};
  const source=name=>fs.readFileSync(path.join(__dirname,'../electron/renderer/views/',name),'utf8');
  vm.runInNewContext(source('elements.js').replaceAll('export function','function')+'\n'+source('remote-controls.js').replace(/^import.*\r?\n/m,'').replaceAll('export function','function').replace('export {listOptions};','')+'\n'+
    source('remote-desktop.js').replace(/^import.*\r?\n/m,'').replace('export async function','async function')+'\nthis.mount=mount;',context);
  const api={window:async()=>{},request:async(action,data)=>{
    if(action==='snapshot')return {addresses:[]};calls.push({...data});
    if(hold)return hold(action,data);
    return {ok:true,data:data.action==='status'?{enabled:true,ready:true}:data.action==='pairings'?{pairings:peers}:data.action==='clients'?saved:{status:true}};
  }};
  const ui=await context.mount({root,title:new Element(),brand:new Element(),status:new Element(),api,close(){}});
  const get=id=>root.children.find(node=>node.id===id);
  async function poll(){clock+=2500;tick();await turn();}
  for(let i=0;i<4;i++)await poll(); // Initial status, clients, status, then requests.
  return {root,calls,ui,get,poll,set peers(value){peers=value;},set clients(value){saved=value;},set hold(value){hold=value;},get closed(){return closed;}};
}
test('approval requires explicit matching-code confirmation and sends current generation once',async()=>{
  const f=await fixture(),pair=f.get('RemoteDesktopPair'),confirmation=f.get('RemoteDesktopConfirm');
  try {
    assert.equal(f.get('RemoteDesktopVerification').textContent,waiting.verification);assert.equal(f.get('RemoteDesktopPin').hidden,true);
    assert.equal(pair.disabled,true);pair.onclick();assert.equal(f.calls.filter(v=>v.action==='lanPairApprove').length,0);
    confirmation.checked=true;confirmation.onchange();assert.equal(pair.disabled,false);pair.onclick();await turn();
    assert.deepEqual(f.calls.filter(v=>v.action==='lanPairApprove'),[{action:'lanPairApprove',id:waiting.id,generation:waiting.generation,verification:waiting.verification}]);
    assert.equal(confirmation.checked,false);assert.equal(pair.disabled,true);
  }finally{f.ui.dispose();}
});
test('same request preserves confirmation while replacement generation and selection reset it',async()=>{
  const f=await fixture();try{
    const confirm=f.get('RemoteDesktopConfirm');confirm.checked=true;confirm.onchange();
    await f.poll();await f.poll();await f.poll();assert.equal(confirm.checked,true);
    f.peers=[{...waiting,generation:'c'.repeat(32)}];await f.poll();await f.poll();await f.poll();
    assert.equal(confirm.checked,false);assert.equal(f.get('RemoteDesktopPair').disabled,true);
    f.get('RemoteDesktopReject').onclick();await turn();assert.deepEqual(f.calls.at(-1),{action:'lanPairReject',id:waiting.id,generation:'c'.repeat(32),verification:waiting.verification});
  }finally{f.ui.dispose();}
});
test('rejection needs no checkbox and approving or unbound automatic requests cannot be decided',async()=>{
  const f=await fixture();try{
    assert.equal(f.get('RemoteDesktopConfirm').checked,false);f.get('RemoteDesktopReject').onclick();await turn();
    assert.equal(f.calls.at(-1).action,'lanPairReject');
    f.peers=[{...waiting,state:'approving'}];for(let i=0;i<3;i++)await f.poll();
    assert.equal(f.get('RemoteDesktopReject').disabled,true);assert.equal(f.get('RemoteDesktopPair').disabled,true);
    f.peers=[{...waiting,generation:undefined}];for(let i=0;i<3;i++)await f.poll();assert.equal(f.get('RemoteDesktopReject').disabled,true);
  }finally{f.ui.dispose();}
});
test('legacy native requests retain manual PIN and have a separate native reject action',async()=>{
  const f=await fixture();try{
    f.peers=[{id:'c'.repeat(32),name:'legacy',address:'192.0.2.1'}];for(let i=0;i<3;i++)await f.poll();
    assert.equal(f.get('RemoteDesktopConfirm').hidden,true);assert.equal(f.get('RemoteDesktopPin').hidden,false);
    f.get('RemoteDesktopReject').onclick();await turn();assert.deepEqual(f.calls.at(-1),{action:'pairReject',id:'c'.repeat(32)});
    f.get('RemoteDesktopPin').value='1234';f.get('RemoteDesktopPair').onclick();await turn();
    assert.deepEqual(f.calls.at(-1),{action:'pair',id:'c'.repeat(32),pin:'1234',name:'legacy'});
  }finally{f.ui.dispose();}
});
test('closing settings withdraws polling and ignores late mutation replies',async()=>{
  const f=await fixture();let finish;f.hold=()=>new Promise(resolve=>finish=resolve);
  f.get('RemoteDesktopReject').onclick();const before=f.root.children.map(node=>node.textContent);
  f.ui.dispose();finish({ok:true,data:{status:true}});await turn();
  assert.equal(f.closed,true);assert.deepEqual(f.root.children.map(node=>node.textContent),before);
  const count=f.calls.length;await f.poll();assert.equal(f.calls.length,count);
});
test('failed request refresh discards the old code confirmation and gates decisions',async()=>{
  const f=await fixture();try{
    const confirm=f.get('RemoteDesktopConfirm');confirm.checked=true;confirm.onchange();
    f.hold=async()=>{throw Error('fixture disconnected');};await f.poll();await f.poll();
    assert.equal(confirm.checked,false);assert.equal(f.get('RemoteDesktopPair').disabled,true);assert.equal(f.get('RemoteDesktopReject').disabled,true);
  }finally{f.ui.dispose();}
});

test('device revocation carries the current engine view and shows disabled partial state',async()=>{
  const f=await fixture(),uuid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';try{
    const revoke=f.get('RemoteDesktopRevoke'),list=f.get('RemoteDesktopClients');assert.equal(revoke.disabled,true);
    f.clients={viewId:'e'.repeat(32),named_certs:[{uuid,name:'Fixture',enabled:false}]};await f.poll();
    assert.equal(list.children[0].textContent,'Fixture（已停用）');assert.equal(revoke.disabled,false);
    revoke.onclick();await turn();assert.deepEqual(f.calls.at(-1),{action:'unpair',uuid,viewId:'e'.repeat(32)});
    assert.equal(revoke.disabled,true);assert.equal(list.children.length,0);
  }finally{f.ui.dispose();}
});

test('device list failure and legacy replies withdraw revocation until a new current view arrives',async()=>{
  const f=await fixture(),uuid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';try{
    const revoke=f.get('RemoteDesktopRevoke');f.clients={viewId:'e'.repeat(32),named_certs:[{uuid,name:'Fixture',enabled:true}]};await f.poll();
    assert.equal(revoke.disabled,false);f.hold=async()=>{throw Error('fixture read failure');};for(let i=0;i<3;i++)await f.poll();
    assert.equal(revoke.disabled,true);const mutations=f.calls.filter(value=>value.action==='unpair').length;revoke.onclick();assert.equal(f.calls.filter(value=>value.action==='unpair').length,mutations);
    f.hold=null;f.clients={named_certs:[{uuid,name:'Legacy',enabled:true}]};for(let i=0;i<4;i++)await f.poll();assert.equal(revoke.disabled,true);
    f.clients={viewId:'f'.repeat(32),named_certs:[{uuid,name:'Current',enabled:true}]};for(let i=0;i<3;i++)await f.poll();
    revoke.onclick();await turn();assert.deepEqual(f.calls.at(-1),{action:'unpair',uuid,viewId:'f'.repeat(32)});
  }finally{f.ui.dispose();}
});
