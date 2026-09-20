'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
function host() {
  class Window extends EventEmitter {
    constructor(){super();this.sent=[];this.webContents=new EventEmitter();this.webContents.send=(channel,value)=>this.sent.push(value);this.webContents.setWindowOpenHandler=()=>{};}
    isDestroyed(){return false;} setMenu(){} loadFile(){} close(){this.emit('closed');}
  }
  const app=new EventEmitter();Object.assign(app,{getPath:()=>__dirname,setName(){},setPath(){},requestSingleInstanceLock:()=>true,whenReady:()=>new Promise(()=>{}),quit(){}});
  const mock={app,BrowserWindow:Window};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../screen-share/main.js'),'utf8'),{
    require:name=>name==='electron'?mock:require(name),module,__dirname:path.join(__dirname,'../screen-share'),process,Buffer,console,
    setTimeout:()=>0,clearTimeout(){},setInterval:()=>({unref(){}})
  });
  return module.exports;
}
const invite={id:'a'.repeat(32),secret:'b'.repeat(64),name:'Viewer test',port:47632,sdp:'v=0\r\n'};
test('automatic capture uses primary display ID, not enumeration order or a window',()=>{
  const h=host();
  const secondary={id:'screen:2:0',display_id:'22'};
  const primary={id:'screen:1:0',display_id:'11'};
  assert.equal(h.primaryScreenSource([secondary,{id:'window:3:0',display_id:'11'},primary],11),primary);
  assert.equal(h.primaryScreenSource([secondary],11),undefined);
  assert.equal(h.primaryScreenSource([],11),undefined);
});
test('rejects malformed invitation, endpoint and session credentials',()=>{
  const h=host();
  for(const data of [{},{...invite,port:0},{...invite,port:'47632'},{...invite,sdp:'x'},{...invite,secret:'x'},{...invite,name:'x'.repeat(129)}]) {
    assert.equal(h.handleCommand({action:'signal',path:'/screen/invite',remoteAddress:'127.0.0.1',data}).status,400);
  }
  assert.equal(h.handleCommand({action:'signal',path:'/screen/invite',remoteAddress:'evil.test',data:invite}).status,400);
  assert.equal(h.handleCommand({action:'signal',path:'/screen/message',data:{...invite,type:'stop'}}).status,401);
  assert.equal(h.equal('a','é'),false);
  assert.equal(h.sessions.size,0);
});
test('invitation is bounded, duplicate-safe and session-bound',()=>{
  const h=host();const signal=data=>h.handleCommand({action:'signal',path:'/screen/invite',remoteAddress:'127.0.0.1',data});
  assert.equal(signal(invite).status,202);
  const s=h.sessions.get(invite.id);
  assert.equal(s.captureAllowed,undefined,'Remote invitations must never authorize local screen capture');
  assert.equal(s.window.sent.length,0,'Invitation must not auto-start capture or playback');
  assert.equal(signal(invite).status,409);
  assert.equal(h.handleCommand({action:'signal',path:'/screen/message',data:{...invite,secret:'c'.repeat(64),type:'stop'}}).status,401);
  assert.equal(s.ended,undefined);
  assert.equal(h.handleCommand({action:'signal',path:'/screen/message',data:{...invite,type:'stop'}}).status,200);
  assert.equal(s.ended,true);
  assert.equal(s.window.sent[0].type,'stop');
  assert.equal(h.handleCommand({action:'signal',path:'/screen/message',data:{...invite,type:'stop'}}).status,410);
  for(let n=1;n<=3;n++)assert.equal(signal({...invite,id:String(n).repeat(32)}).status,202);
  assert.equal(signal({...invite,id:'4'.repeat(32)}).status,429);
});
test('sender accepts answer only for its current secret and role',()=>{
  const h=host();
  const result=h.handleCommand({action:'start',peer:{name:'PC',address:'127.0.0.1',port:47632},localPort:47632,localName:'sender'});
  assert.equal(result.status,200);
  const s=h.sessions.get(result.id);
  assert.equal(s.captureAllowed,true,'Local start authorizes whole-screen capture');
  assert.match(s.secret,/^[a-f0-9]{64}$/);
  const data={id:s.id,secret:s.secret,type:'answer',sdp:'v=0\r\n'};
  assert.equal(h.handleCommand({action:'signal',path:'/screen/message',data}).status,200);
  assert.equal(s.window.sent[0].type,'answer');
  assert.equal(h.handleCommand({action:'signal',path:'/screen/message',data:{...data,sdp:'malformed'}}).status,400);
  assert.equal(h.handleCommand({action:'signal',path:'/screen/unknown',data}).status,404);
});
