'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {once}=require('node:events');
const {AiServer}=require('../electron/ai-server.cjs');
async function connect(server,extra={}){
  const socket=net.createConnection(server.address),pending=new Map();let sequence=0,buffer='';socket.setEncoding('utf8');socket.on('error',()=>{});
  socket.on('data',data=>{buffer+=data;let at;while((at=buffer.indexOf('\n'))>=0){const result=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);const resolve=pending.get(result.id);pending.delete(result.id);resolve?.(result);}});
  await once(socket,'connect');
  const call=message=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);socket.write(JSON.stringify({id,...message})+'\n');});
  const hello=await call({token:server.token,client:'cli',...extra});
  return {hello,call,close:()=>socket.destroy()};
}
test('CLI sessions survive process EOF, require their own credential, heartbeat without extending idle expiry, and release on expiry',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-cli-'));let now=0,owner;
  const released=[],heartbeats=[],executions=[];
  const controller={connect:async value=>{owner=value;return {session:'a'.repeat(32)};},execute:async(value,args)=>{executions.push({value,args});return {result:{active:true}};},heartbeat:async value=>heartbeats.push(value),release:async value=>released.push(value),close:async()=>{}};
  const server=new AiServer({directory,controller,now:()=>now});await server.start();
  t.after(async()=>{await server.close();fs.rmSync(directory,{recursive:true,force:true});});
  const first=await connect(server);assert.equal(first.hello.result.cliLeaseProtocol,1);
  const connected=(await first.call({method:'connect',params:{deviceId:'test',leaseSeconds:60}})).result;first.close();
  await new Promise(resolve=>setTimeout(resolve,25));assert.ok(!released.includes(owner));
  const wrong=await connect(server,{session:connected.session,leaseToken:'0'.repeat(64)});assert.equal(wrong.hello.code,'AUTOMATION_CLI_SESSION_ENDED');wrong.close();
  const next=await connect(server,{session:connected.session,leaseToken:connected.leaseToken});assert.equal(next.hello.ok,true);
  assert.equal((await next.call({method:'execute',params:{session:'b'.repeat(32),operation:'windows'}})).code,'AUTOMATION_SESSION_NOT_FOUND');assert.equal(executions.length,0);
  assert.equal((await next.call({method:'execute',params:{session:connected.session,operation:'windows'}})).ok,true);assert.equal(executions[0].value,owner);next.close();
  now=20001;await server.cli.maintain();assert.deepEqual(heartbeats,[owner]);assert.equal(server.cli.entries.get(connected.session).expiresAt,60000);
  now=60001;await server.cli.maintain();assert.ok(released.includes(owner));assert.equal(server.cli.entries.size,0);
  const expired=await connect(server,{session:connected.session,leaseToken:connected.leaseToken});assert.equal(expired.hello.code,'AUTOMATION_CLI_SESSION_ENDED');expired.close();
});
test('explicit CLI disconnect releases its lease and old credentials cannot resume it',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-cli-close-'));let closed=0;
  const controller={connect:async()=>({session:'c'.repeat(32)}),disconnect:async()=>{closed++;return {closed:true};},heartbeat:async()=>{},release:async()=>{},close:async()=>{}};
  const server=new AiServer({directory,controller});await server.start();t.after(async()=>{await server.close();fs.rmSync(directory,{recursive:true,force:true});});
  const first=await connect(server),created=(await first.call({method:'connect',params:{deviceId:'test'}})).result;first.close();
  const next=await connect(server,{session:created.session,leaseToken:created.leaseToken});assert.equal((await next.call({method:'disconnect',params:{session:created.session}})).ok,true);next.close();
  assert.equal(closed,1);assert.equal(server.cli.entries.size,0);
  const stale=await connect(server,{session:created.session,leaseToken:created.leaseToken});assert.equal(stale.hello.ok,false);stale.close();
});
