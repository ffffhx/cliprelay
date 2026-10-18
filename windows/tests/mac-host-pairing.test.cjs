'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),os=require('node:os'),path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
const {once}=require('node:events');
const {hostPairing,decision,reply}=require('../electron/mac/host-pairing.cjs');
const request=()=>({id:'a'.repeat(32),generation:'b'.repeat(32),name:'Fixture device',verification:'1234 ABCD 5678',expires:Math.floor(Date.now()/1000)+120,state:'waiting'});
async function server(t,handler){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'cr-host-rpc-'));
  const endpoint=process.platform==='win32'?'\\\\.\\pipe\\cliprelay-host-test-'+crypto.randomUUID():path.join(fs.realpathSync(base),'s');
  const connections=new Set();let requests=0;
  const listener=net.createServer(socket=>{connections.add(socket);socket.on('error',()=>{});socket.once('close',()=>connections.delete(socket));let raw='';
    socket.on('data',chunk=>{raw+=chunk;if(raw.includes('\n')){requests++;handler(socket,JSON.parse(raw));}});
  });
  listener.listen(endpoint);await once(listener,'listening');
  t.after(async()=>{for(const socket of connections)socket.destroy();await new Promise(resolve=>listener.close(resolve));assert.ok(path.basename(base).startsWith('cr-host-rpc-'));fs.rmSync(base,{recursive:true,force:true});});
  return {companion:{ipcPath:()=>endpoint},get requests(){return requests;}};
}
test('private channel sends only the selected decision and validates live request snapshots',async t=>{
  const seen=[],pending=request(),f=await server(t,(socket,command)=>{seen.push(command);socket.end(JSON.stringify(command.op==='host-pair-list'?{protocol:1,ok:true,requests:[pending]}:{protocol:1,ok:true})+'\n');});
  assert.deepEqual(await hostPairing({...f,op:'host-pair-list'}),{requests:[pending]});
  const data=decision({id:pending.id,generation:pending.generation,verification:pending.verification});
  assert.deepEqual(await hostPairing({...f,op:'host-pair-approve',data}),{ok:true});
  assert.deepEqual(seen,[{op:'host-pair-list'},{op:'host-pair-approve',...data}]);
});
test('stale decisions retain a fixed error; unknown or oversized replies cannot leak diagnostics',async t=>{
  let mode='stale';const f=await server(t,(socket)=>{
    if(mode==='large')socket.end('x'.repeat(16385));
    else socket.end(JSON.stringify(mode==='stale'?{protocol:1,ok:false,code:'HOST_PAIR_STALE'}:{protocol:1,ok:false,code:'/private/credential'})+'\n');
  });
  await assert.rejects(hostPairing({...f,op:'host-pair-list'}),{code:'HOST_PAIR_STALE'});
  for(const value of ['unknown','large']){mode=value;await assert.rejects(hostPairing({...f,op:'host-pair-list'}),{code:'HOST_PAIR_BAD_REPLY'});}
});
test('deadline and cancellation close the actual client socket',async t=>{
  const f=await server(t,()=>{}),clients=[];
  const connect=options=>{const socket=net.createConnection(options);clients.push(socket);return socket;};
  await assert.rejects(hostPairing({...f,op:'host-pair-list',connect,timeout:80}),{code:'HOST_PAIR_TIMEOUT'});assert.equal(clients[0].destroyed,true);
  const abort=new AbortController(),pending=hostPairing({...f,op:'host-pair-list',connect,signal:abort.signal});
  const rejected=assert.rejects(pending,{code:'HOST_PAIR_CANCELLED'});abort.abort();await rejected;assert.equal(clients[1].destroyed,true);
});
test('invalid actions and payload paths are refused before any socket opens',async()=>{
  let connected=0;const companion={ipcPath:()=>{connected++;return '/unused';}};
  for(const args of [{op:'arbitrary'},{op:'host-pair-list',data:{path:'/elsewhere'}},{op:'host-pair-approve',data:{id:'../escape'}},
    {op:'host-pair-reject',data:{id:'a'.repeat(32),generation:'b'.repeat(32),verification:'1234 ABCD 5678',file:'other'}}])await assert.rejects(hostPairing({companion,...args}),{code:'HOST_PAIR_INVALID'});
  assert.equal(connected,0);
});
test('reply bounds reject duplicate requests and secrets; naturally expired requests disappear',()=>{
  const r=request();assert.deepEqual(reply({protocol:1,ok:true,requests:[{...r,expires:1}]},'host-pair-list'),{requests:[]});
  for(const requests of [[r,r],[{...r,password:'secret'}],[{...r,state:'authorized'}],[{...r,expires:r.expires+3600}],[{...r,generation:'old'}]]){
    assert.throws(()=>reply({protocol:1,ok:true,requests},'host-pair-list'),{code:'HOST_PAIR_BAD_REPLY'});
  }
});
