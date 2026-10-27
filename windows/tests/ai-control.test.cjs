'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {once}=require('node:events');
const {PassThrough}=require('node:stream');
const {AiController}=require('../electron/ai-controller.cjs');
const {AiServer}=require('../electron/ai-server.cjs');
const {Connection,run}=require('../electron/ai-mcp.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const host={id:'a'.repeat(64),clientId:'b'.repeat(32),name:'Fixture',enabled:true,address:'127.0.0.1',port:48789,certificate:'fixture'};
  const calls=[],store={hosts:()=>[host],identity:async()=>({cert:'local',key:'private'}),selected:()=>host};
  const client={paired:{store},direct:{busy:false},network:{}};
  let failure;
  const controller=new AiController({getClient:()=>client,directory:{snapshot:()=>({devices:[]})},request:async(h,i,body)=>{calls.push(body);if(failure)throw Object.assign(new Error(failure),{code:failure});return {ok:true,instance:'c'.repeat(32),result:body.op==='capabilities'?{windows:true,profilepilot:true}:{op:body.op}};}});
  return {host,calls,controller,client,setFailure:value=>failure=value};
}
test('AI sessions bind exact paired computer, identity, owner and current route without starting video',async()=>{
  const f=fixture();const connected=await f.controller.connect('alice','paired:'+f.host.id);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].op,'capabilities');
  await assert.rejects(f.controller.execute('bob',{session:connected.session,operation:'windows'}),{code:'AUTOMATION_SESSION_NOT_FOUND'});
  await f.controller.execute('alice',{session:connected.session,operation:'windows'});assert.equal(f.calls[1].session,connected.session);
  f.host.address='10.1.2.3';
  await assert.rejects(f.controller.execute('alice',{session:connected.session,operation:'windows'}),{code:'AUTOMATION_ROUTE_CHANGED'});
  assert.equal(f.calls.length,2);
});
test('unknown actions retain request ID and are never automatically executed again',async()=>{
  const f=fixture(),s=await f.controller.connect('alice','paired:'+f.host.id);f.setFailure('TIMEOUT');
  let error;try{await f.controller.execute('alice',{session:s.session,operation:'window.action',params:{kind:'invoke'}});}catch(e){error=e;}
  assert.match(error.requestId,/^[0-9a-f]{32}$/);assert.equal(f.calls.length,2);
  await f.controller.heartbeat('alice');assert.equal(f.calls.length,2);
  await assert.rejects(f.controller.execute('alice',{session:s.session,operation:'window.action',params:{kind:'toggle'},requestId:error.requestId}),{code:'AUTOMATION_ID_CONFLICT'});
  f.setFailure(null);await f.controller.execute('alice',{session:s.session,operation:'window.action',params:{kind:'invoke'},requestId:error.requestId});
  assert.deepEqual(f.calls[1],f.calls[2]);
  await f.controller.disconnect('alice',s.session);assert.equal(f.calls.at(-1).op,'close');assert.equal(f.controller.sessions.size,0);
});

test('a definitely rejected busy heartbeat does not strand an otherwise active CLI session',async()=>{
  const f=fixture();await f.controller.connect('alice','paired:'+f.host.id);f.setFailure('AUTOMATION_BUSY');
  assert.equal(await f.controller.heartbeat('alice'),false);assert.equal([...f.controller.sessions.values()][0].pending,null);
  f.setFailure(null);assert.equal(await f.controller.heartbeat('alice'),true);assert.equal(f.calls.at(-1).op,'status');
});
test('private local bridge rejects invalid tokens and releases only its own sessions on EOF',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-ai-'));const released=[],calls=[];
  const controller={devices:async()=>({devices:[]}),heartbeat:async()=>{},release:async owner=>released.push(owner),close:async()=>{},execute:async(owner,args)=>{calls.push({owner,args});return {ok:true};}};
  const server=new AiServer({directory,controller});await server.start();
  t.after(async()=>{await server.close();fs.rmSync(directory,{recursive:true,force:true});});
  for(const token of ['0'.repeat(64),'é'.repeat(64)]){const socket=net.createConnection(server.address);await once(socket,'connect');socket.write(JSON.stringify({id:1,token})+'\n');await once(socket,'close');}
  assert.equal(calls.length,0);
  const connection=new Connection(server.file);await connection.start();assert.deepEqual(await connection.call({method:'devices'}),{devices:[]});
  await connection.call({method:'execute',params:{session:'sample',operation:'windows'}});assert.equal(calls.length,1);
  connection.close();for(let i=0;i<50&&!released.includes(calls[0].owner);i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(released.includes(calls[0].owner));
});
test('MCP stdio exposes typed tools and returns native screenshots as image content',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-mcp-'));
  const controller={devices:async()=>({devices:[{id:'paired:test'}]}),heartbeat:async()=>{},release:async()=>{},close:async()=>{},execute:async(owner,args)=>({requestId:'d'.repeat(32),result:{version:'v',image:{mimeType:'image/jpeg',data:'aW1hZ2U=',width:100,height:100}}})};
  const server=new AiServer({directory,controller});await server.start();
  const input=new PassThrough(),output=new PassThrough(),replies=[];let buffer='';
  output.on('data',chunk=>{buffer+=chunk;let offset;while((offset=buffer.indexOf('\n'))>=0){replies.push(JSON.parse(buffer.slice(0,offset)));buffer=buffer.slice(offset+1);}});
  const running=run({file:server.file,input,output});
  t.after(async()=>{input.end();await running;await server.close();fs.rmSync(directory,{recursive:true,force:true});});
  const call=async(method,params)=>{const id=replies.length+1;input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');for(let i=0;i<100;i++){const found=replies.find(r=>r.id===id);if(found)return found;await new Promise(r=>setTimeout(r,10));}throw new Error('MCP response timeout');};
  assert.equal((await call('initialize',{protocolVersion:'2025-11-25'})).result.serverInfo.name,'cliprelay');
  const listed=(await call('tools/list')).result.tools;assert.ok(listed.some(t=>t.name==='cliprelay_profile_manage'));assert.ok(listed.some(t=>t.name==='cliprelay_window_action'));
  const image=(await call('tools/call',{name:'cliprelay_window_screenshot',arguments:{session:'s',windowId:'w'}})).result;
  assert.equal(image.content[1].type,'image');assert.equal(image.content[1].data,'aW1hZ2U=');assert.ok(!image.content[0].text.includes('aW1hZ2U='));
  assert.equal((await call('tools/call',{name:'cliprelay_windows',arguments:{session:'s',command:'cmd'}})).error.code,-32602);
});
