'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.value='';this.hidden=false;this.disabled=false;}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  remove(){this.parent.children=this.parent.children.filter(node=>node!==this);}
  setAttribute(name,value){this[name]=value;}
  all(predicate){return this.children.flatMap(node=>[...(predicate(node)?[node]:[]),...node.all(predicate)]);}
}
function fixture(){
  const context={document:{createElement:tag=>new Element(tag)}};
  const filename=path.join(__dirname,'../electron/mac/file-ui.js');vm.runInNewContext(fs.readFileSync(filename,'utf8').replace('export function mountFiles','function mountFiles')+'\nthis.mountFiles=mountFiles;',context);
  const state={hosts:[{id:'host',name:'PC',enabled:true,selected:true}],files:{browser:{loaded:true,roots:[{id:'downloads',name:'downloads',writable:true}],root:'downloads',path:'',next:'',entries:[{name:'<b>text.txt',directory:false,size:42,blocked:true},{name:'one.txt',directory:false,size:12,blocked:false},{name:'folder',directory:true,size:0,blocked:false}]},tasks:[]}};
  const calls=[],root=new Element('main'),ui=context.mountFiles(root,async(action,data)=>{calls.push({action,data});return state;});ui.render(state);
  const button=name=>root.all(item=>item.tag==='button' && item.textContent===name)[0];return {state,root,ui,calls,button};
}
test('file panel selects validated names, keeps selection during progress polling and sends no local paths',async()=>{
  const f=fixture(),choose=f.root.all(item=>item.tag==='input' && item.ariaLabel==='选择 one.txt')[0];
  assert.equal(f.root.all(item=>item.tag==='input' && item.ariaLabel==='选择 <b>text.txt')[0].disabled,true);
  assert.equal(f.button('下载所选…').disabled,true);choose.checked=true;choose.onchange();f.ui.render(f.state);assert.equal(f.button('下载所选…').disabled,false);
  await f.button('下载所选…').onclick();assert.equal(f.calls[0].action,'files-download');assert.equal(JSON.stringify(f.calls[0].data),JSON.stringify({names:['one.txt']}));
  await f.button('打开').onclick();assert.equal(f.calls[1].action,'files-browse');assert.equal(f.calls[1].data.path,'folder');
  await f.button('上传文件…').onclick();assert.equal(f.calls[2].action,'files-upload');assert.equal(f.calls[2].data,undefined);
});
test('queue preserves focused action nodes during progress updates and restricts resuming to the original computer',async()=>{
  const f=fixture(),task={id:'job',hostId:'host',hostName:'PC',name:'a.bin',direction:'download',state:'downloading',size:100,offset:10,verified:0};f.state.files.tasks=[task];f.ui.render(f.state);
  const pause=f.button('暂停');task.offset=20;f.ui.render(f.state);assert.equal(f.button('暂停'),pause);assert.equal(f.root.all(item=>item.tag==='progress')[0].value,20);
  await pause.onclick();assert.equal(f.calls[0].action,'files-pause');assert.equal(f.calls[0].data.id,'job');
  task.state='paused';f.ui.render(f.state);assert.equal(f.button('继续').disabled,false);f.state.hosts[0].id='other';f.ui.render(f.state);assert.equal(f.button('继续').disabled,true);
  task.state='cancel-pending';f.ui.render(f.state);assert.ok(f.button('重试取消'));task.state='complete';task.destination='/chosen';task.finalName='a (1).bin';f.ui.render(f.state);assert.equal(f.button('在文件夹中显示').hidden,false);assert.equal(f.button('清除记录').hidden,false);
});
