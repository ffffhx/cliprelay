'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {pathToFileURL}=require('node:url');

function fixture(){
  const handlers=new Map(),requests=[];
  class Window extends EventEmitter {
    constructor(){super();this.webContents=new EventEmitter();this.webContents.mainFrame={};this.webContents.setWindowOpenHandler=()=>{};}
    setMenu(){} isDestroyed(){return false;} restore(){} show(){} focus(){}
    loadFile(file,options){this.lastLoad={file,options};this.webContents.mainFrame.url=pathToFileURL(file).href+'?'+new URLSearchParams(options.query);}
  }
  const filename=path.resolve(__dirname,'../electron/windows.cjs');
  const module={exports:{}};
  const electron={BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},screen:{getPrimaryDisplay:()=>({workAreaSize:{width:1920,height:1080}})},Menu:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,__dirname:path.dirname(filename),Buffer,require:name=>name==='electron'?electron:require(name)},{filename});
  const host={request:async(action,data)=>{requests.push({action,data});return {ok:true,peers:[]};}};
  const windows=new module.exports.DesktopWindows(host,path.resolve(__dirname,'..'));
  const event=window=>({sender:window.webContents,senderFrame:window.webContents.mainFrame});
  return {windows,handlers,requests,event};
}

test('paired catalog stays behind owned renderer IPC and allows no arbitrary relay commands',async()=>{
  const {windows,handlers,requests,event}=fixture();
  const editor=windows.open('peer-editor','original-device');
  const request=handlers.get('relay:request');
  await request(event(editor),'paired-peers',{});
  assert.equal(requests.length,1);assert.equal(requests[0].action,'paired-peers');
  await assert.rejects(request({...event(editor),senderFrame:{}},'paired-peers',{}),/Unknown renderer/);
  await assert.rejects(request(event(editor),'relay',{op:'begin'}),/Invalid desktop action/);
  assert.equal(requests.length,1);
});

test('mode change loads the trusted page and preserves the native-selected device',()=>{
  const {windows,handlers,event}=fixture();
  const editor=windows.open('peer-editor','original-device');
  const action=handlers.get('relay:window');
  action(event(editor),'peer-mode',{mode:'paired',peerId:'forged-device',url:'https://example.invalid'});
  assert.equal(editor.lastLoad.options.query.peerId,'original-device');
  assert.equal(editor.lastLoad.options.query.paired,'1');
  assert.equal(editor.lastLoad.file,windows.page);
  action(event(editor),'peer-mode',{mode:'legacy'});
  assert.equal(editor.lastLoad.options.query.legacy,'1');
  assert.throws(()=>action(event(editor),'peer-mode',{mode:'arbitrary'}),/Invalid window action/);
  const control=windows.open('control-center');
  assert.throws(()=>action(event(control),'peer-mode',{mode:'legacy'}),/Invalid window action/);
  let prevented=false;editor.webContents.emit('will-navigate',{preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
});

test('preload presents the host error without Electron IPC implementation details',async()=>{
  for(const [file,channel] of [['preload.cjs','mac:request'],['terminal-preload.cjs','terminal:request']]){
  let api,reply=async()=>({ok:true});
  const electron={contextBridge:{exposeInMainWorld:(_name,value)=>{api=value;}},ipcRenderer:{invoke:(...args)=>reply(...args)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/mac',file),'utf8'),{require:()=>electron});
  assert.equal((await api.request('initial')).ok,true);
  reply=async()=>{throw new Error(`Error invoking remote method '${channel}': Error: 请输入电脑的 IP 或主机名`);};
  await assert.rejects(api.request('pair-start'),error=>error.message==='请输入电脑的 IP 或主机名');
  reply=async()=>{throw new Error('电脑已撤销授权，请重新配对');};
  await assert.rejects(api.request('paired-send'),error=>error.message==='电脑已撤销授权，请重新配对');
  }
});

test('pairing validation stays beside its own form through status polling and clears on retry',async()=>{
  class Element{
    constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.value='';}
    append(...nodes){this.children.push(...nodes);}setAttribute(name,value){this[name]=value;}
    replaceChildren(...nodes){this.children=nodes;}
    all(predicate){return this.children.flatMap(node=>[...(predicate(node)?[node]:[]),...node.all(predicate)]);}
  }
  const root=new Element('main');let poll,fail=true;
  const state={hosts:[],pairing:{state:'idle'},viewer:{available:true},network:{available:true,computers:[],pairing:{state:'idle'}}};
  const context={document:{createElement:tag=>new Element(tag)},window:{addEventListener(){}},setInterval:fn=>{poll=fn;},clearInterval(){}};
  for(const name of ['mountFiles','mountBitrate','mountDisplays','mountInput','mountPrivacy','mountAudioMute','mountSessionLock','mountWake','mountClipboard'])context[name]=()=>({render(){}});
  const source=fs.readFileSync(path.join(__dirname,'../electron/mac/paired-ui.js'),'utf8').replace(/^import .+;\r?$/gm,'').replace('export async function mount','async function mount');
  vm.runInNewContext(source+'\nthis.mount=mount;',context);
  await context.mount(root,{request:async action=>{
    if(fail && action==='pair-start')throw new Error('请输入电脑的 IP 或主机名');
    if(fail && action==='network-claim')throw new Error('请输入 8 位数字配对码');
    return state;
  }},()=>{},state);
  const [localForm,networkForm]=root.all(e=>e.tag==='form');
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  localForm.onsubmit({preventDefault(){}});await settle();await poll();
  const localMessage=root.children[root.children.indexOf(localForm)+2];
  assert.equal(localMessage.textContent,'请输入电脑的 IP 或主机名');
  networkForm.onsubmit({preventDefault(){}});await settle();await poll();
  const networkSection=root.children.find(e=>e.children.includes(networkForm));
  const networkMessage=networkSection.children[networkSection.children.indexOf(networkForm)+2];
  assert.equal(networkMessage.textContent,'请输入 8 位数字配对码');
  assert.equal(localMessage.textContent,'请输入电脑的 IP 或主机名');
  fail=false;localForm.onsubmit({preventDefault(){}});await settle();
  assert.equal(localMessage.textContent,'');
  networkForm.onsubmit({preventDefault(){}});await settle();
  assert.equal(networkMessage.textContent,'外网配对后，无需填写电脑 IP。');
});
