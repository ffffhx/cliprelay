'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
function host({deferHttp=false}={}) {
  const writes=new Map(),timers=[],requests=[];
  class Window extends EventEmitter {
    constructor(options){super();this.options=options;this.destroyed=false;this.sent=[];this.webContents=new EventEmitter();this.webContents.send=(channel,value)=>this.sent.push(value);this.webContents.setWindowOpenHandler=()=>{};}
    isDestroyed(){return this.destroyed;} setMenu(){} loadFile(){return Promise.resolve();} close(){this.destroy();}
    destroy(){if(!this.destroyed){this.destroyed=true;this.emit('closed');}}
  }
  const app=new EventEmitter();Object.assign(app,{getPath:()=>__dirname,setName(){},setPath(){},requestSingleInstanceLock:()=>true,whenReady:()=>new Promise(()=>{}),quit(){}});
  const mock={app,BrowserWindow:Window};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../screen-share/main.js'),'utf8'),{
    require:name=>name==='electron'?mock:name==='node:fs'?{mkdirSync(){},writeFileSync:(p,data)=>writes.set(p,data),renameSync:(from,to)=>writes.set(to,writes.get(from))}:name==='node:http'?{request:(_options,callback)=>{const request=new EventEmitter();request.respond=(statusCode=200)=>callback({resume(){},statusCode});request.destroy=error=>request.emit('error',error);request.end=()=>{requests.push(request);if(!deferHttp)request.respond();};return request;}}:require(name),module,__dirname:path.join(__dirname,'../screen-share'),process,Buffer,console,
    setTimeout:(callback,ms)=>{timers.push({callback,ms});return timers.length;},clearTimeout(){},setInterval:()=>({unref(){}})
  });
  return {...module.exports,timers,writes,requests};
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
  assert.equal(s.window.options.show,true,'Viewer invitation remains visible');
  assert.equal(s.window.options.skipTaskbar,false);
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
  assert.equal(s.window.options.show,false,'Sender must never flash a window');
  assert.equal(s.window.options.skipTaskbar,true);
  assert.equal(s.window.options.webPreferences.backgroundThrottling,false);
  assert.match(s.secret,/^[a-f0-9]{64}$/);
  const data={id:s.id,secret:s.secret,type:'answer',sdp:'v=0\r\n'};
  assert.equal(h.handleCommand({action:'signal',path:'/screen/message',data}).status,200);
  assert.equal(s.window.sent[0].type,'answer');
  assert.equal(h.handleCommand({action:'signal',path:'/screen/message',data:{...data,sdp:'malformed'}}).status,400);
  assert.equal(h.handleCommand({action:'signal',path:'/screen/unknown',data}).status,404);
});

test('hidden sender reports status without credentials and is destroyed even if its renderer cannot acknowledge stop',()=>{
  const h=host();
  const result=h.handleCommand({action:'start',peer:{name:'Friend',address:'127.0.0.1',port:47632,accessToken:'private-token'},localPort:47632,localName:'sender'});
  const s=h.sessions.get(result.id);
  const status=h.handleCommand({action:'status'});
  assert.equal(status.senders[0].peer,'Friend');
  assert.equal(status.senders[0].state,'preparing');
  for(const value of [JSON.stringify(status),...h.writes.values()]) {
    assert.ok(!value.includes(s.secret) && !value.includes('private-token'));
  }
  h.handleCommand({action:'signal',path:'/screen/message',data:{id:s.id,secret:s.secret,type:'stop',reason:'Invitation declined'}});
  assert.equal(s.captureAllowed,false);
  assert.equal(h.handleCommand({action:'status'}).senders.length,0);
  assert.equal(h.handleCommand({action:'status'}).lastEvent.reason,'Invitation declined');
  assert.equal(s.window.sent.at(-1).type,'stop');
  h.timers.find(t=>t.ms===2000).callback();
  assert.equal(s.window.isDestroyed(),true);
  assert.equal(h.sessions.size,0,'Ended hidden sessions must not consume the session limit');
});

test('renderer crash, invitation timeout and tray stop terminate background capture',()=>{
  for(const trigger of ['crash','timeout','tray']) {
    const h=host();
    const result=h.handleCommand({action:'start',peer:{name:'Friend',address:'127.0.0.1',port:47632},localPort:47632,localName:'sender'});
    const s=h.sessions.get(result.id);
    if(trigger==='crash')s.window.webContents.emit('render-process-gone');
    else if(trigger==='timeout')h.timers.find(t=>t.ms===90000).callback();
    else h.handleCommand({action:'stop-all'});
    assert.equal(s.ended,true,trigger);
    assert.equal(s.captureAllowed,false,trigger);
    assert.equal(h.handleCommand({action:'status'}).senders.length,0,trigger);
    if(trigger==='timeout')h.timers.find(t=>t.ms===2000).callback();
    assert.equal(s.window.isDestroyed(),true,trigger);
    assert.equal(h.sessions.size,0,trigger);
  }
});

test('invitation status follows remote acknowledgement and never regresses after a fast answer',async()=>{
  for(const fastAnswer of [false,true]) {
    const h=host({deferHttp:true});
    const {id}=h.handleCommand({action:'start',peer:{name:'Friend',address:'127.0.0.1',port:47632},localPort:47632,localName:'sender'});
    const s=h.sessions.get(id);
    const pending=h.sendInvitation(s,'v=0\r\n');
    assert.equal(s.state,'inviting');
    if(fastAnswer)h.handleCommand({action:'signal',path:'/screen/message',data:{id,secret:s.secret,type:'answer',sdp:'v=0\r\n'}});
    h.requests[0].respond(202);await pending;
    assert.equal(s.state,fastAnswer?'connecting':'waiting');
  }
});

test('unreachable invitation is bounded even before a socket connects',async()=>{
  const h=host({deferHttp:true});
  const {id}=h.handleCommand({action:'start',peer:{name:'Friend',address:'127.0.0.1',port:47632},localPort:47632,localName:'sender'});
  const s=h.sessions.get(id),pending=h.sendInvitation(s,'v=0\r\n');
  h.timers.find(t=>t.ms===8000).callback();
  await assert.rejects(pending,/连接超时/);
  assert.notEqual(s.state,'waiting','Cannot claim delivery without an acknowledgement');
});

test('repeated clicks reuse the outgoing session and cancelling leaves incoming viewers open',()=>{
  const h=host();
  const command={action:'start',peer:{name:'Friend',address:'127.0.0.1',port:47632},localPort:47632,localName:'sender'};
  const first=h.handleCommand(command),second=h.handleCommand(command);
  assert.equal(first.id,second.id);assert.equal(second.existing,true);assert.equal(h.sessions.size,1);
  h.handleCommand({action:'signal',path:'/screen/invite',remoteAddress:'127.0.0.1',data:invite});
  h.handleCommand({action:'stop-sending'});
  assert.equal(h.sessions.size,1);
  assert.equal(h.sessions.get(invite.id).ended,undefined);
  assert.equal(h.handleCommand({action:'status'}).senders.length,0);
});
