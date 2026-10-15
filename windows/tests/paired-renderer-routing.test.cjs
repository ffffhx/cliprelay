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
