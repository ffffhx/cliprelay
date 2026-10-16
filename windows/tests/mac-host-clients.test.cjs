'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),https=require('node:https');
const {HostClients}=require('../electron/mac/host-clients.cjs');
const {hostClientRequest}=require('../electron/mac/host-admin.cjs');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const first={uuid:'aaaaaaaa-1111-2222-3333-444444444444',name:'First device',enabled:true};
const second={uuid:'bbbbbbbb-1111-2222-3333-444444444444',name:'Second device',enabled:true};
const authorization='Basic '+Buffer.from('cliprelay:disposable-client-admin').toString('base64');
const state={read:()=>Buffer.from(identities.host.cert),authorization:()=>authorization};
async function server(t,handler,identity=identities.host){
  const service=https.createServer({key:identity.key,cert:identity.cert},handler),port=await listen(service);t.after(()=>close(service));return port;
}
test('client admin uses fixed pinned endpoints and only explicit disable/unpair bodies',async t=>{
  const calls=[];const port=await server(t,async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;calls.push({path:req.url,method:req.method,body:raw?JSON.parse(raw):null});
    assert.equal(req.headers.authorization,authorization);assert.equal(req.headers.origin,undefined);assert.equal(req.headers.referer,undefined);
    if(req.method==='POST')assert.equal(req.headers['content-type'],'application/json');
    res.end(JSON.stringify(req.method==='GET'?{status:true,named_certs:[first,second]}:{status:true}));
  });
  assert.deepEqual(await hostClientRequest({state,port,operation:'list'}),[first,second]);
  for(const operation of ['disable','unpair'])assert.deepEqual(await hostClientRequest({state,port,operation,uuid:first.uuid}),{status:true});
  assert.deepEqual(calls,[{path:'/api/clients/list',method:'GET',body:null},
    {path:'/api/clients/update',method:'POST',body:{uuid:first.uuid,enabled:false}},
    {path:'/api/clients/unpair',method:'POST',body:{uuid:first.uuid}}]);
});
test('invalid client operations and a different certificate cannot receive admin credentials',async t=>{
  let calls=0;const port=await server(t,(_req,res)=>{calls++;res.end('{}');},identities.wrong);
  for(const options of [{operation:'enable',uuid:first.uuid},{operation:'list',uuid:first.uuid},{operation:'unpair',uuid:'../escape'}]){
    await assert.rejects(hostClientRequest({state,port,...options}),{code:'HOST_ADMIN_INVALID'});
  }
  for(const operation of ['list','disable','unpair'])await assert.rejects(hostClientRequest({state,port,operation,...(operation==='list'?{}:{uuid:first.uuid})}),{code:'HOST_CERT_CHANGED'});
  assert.equal(calls,0);
});
test('malformed or duplicate saved clients and excessive responses never become actionable',async t=>{
  let response;const port=await server(t,(_req,res)=>res.end(typeof response==='string'?response:JSON.stringify(response)));
  const list=devices=>({status:true,named_certs:devices});
  for(const value of [list([first,first]),list([{...first,enabled:'true'}]),list([{...first,certificate:'private'}]),list([{...first,uuid:'invalid'}]),
    list([{...first,name:'x'.repeat(129)}]),list(Array(129).fill(first)),{status:false,named_certs:[]},'x'.repeat(65537)]){
    response=value;await assert.rejects(hostClientRequest({state,port,operation:'list'}),{code:'HOST_ADMIN_BAD_REPLY'});
  }
  response={status:true,extra:1};await assert.rejects(hostClientRequest({state,port,operation:'unpair',uuid:first.uuid}),{code:'HOST_ADMIN_BAD_REPLY'});
});
test('client writes honor cancellation and deadline without following redirects',async t=>{
  let arrived;const received=new Promise(resolve=>arrived=resolve);let redirect=false;
  const port=await server(t,(_req,res)=>{arrived();if(redirect){res.writeHead(302,{Location:'https://example.invalid'});res.end();}});
  const abort=new AbortController(),pending=hostClientRequest({state,port,operation:'disable',uuid:first.uuid,signal:abort.signal});
  const rejected=assert.rejects(pending,{code:'HOST_ADMIN_CANCELLED'});await received;abort.abort();await rejected;
  await assert.rejects(hostClientRequest({state,port,operation:'unpair',uuid:first.uuid,timeout:80}),{code:'HOST_ADMIN_TIMEOUT'});
  redirect=true;await assert.rejects(hostClientRequest({state,port,operation:'list'}),{code:'HOST_ADMIN_BAD_REPLY'});
});

function fixture(t){
  const session={current:{},phase:'running',engine:{state},snapshot(){return {phase:this.phase};}};
  const calls=[];let devices=[{...first},{...second}];
  const request=async({operation,uuid})=>{
    calls.push([operation,uuid]);if(operation==='list')return devices.map(device=>({...device}));
    const target=devices.find(device=>device.uuid===uuid);if(operation==='disable' && target)target.enabled=false;
    if(operation==='unpair')devices=devices.filter(device=>device.uuid!==uuid);return {status:!!target};
  };
  const clients=new HostClients({session,request});t.after(()=>clients.close());
  return {clients,session,calls,request,data:()=>({viewId:clients.snapshot().viewId,uuid:first.uuid})};
}
test('revoke disables then verifies before deleting; other devices retain access',async t=>{
  const f=fixture(t);assert.deepEqual(f.calls,[]);await f.clients.refresh();const data=f.data();
  f.clients.snapshot().devices[0].name='changed';assert.equal(f.clients.snapshot().devices[0].name,first.name);
  const result=await f.clients.revoke(data);assert.deepEqual(result.devices,[second]);assert.equal(result.revoking,null);
  assert.deepEqual(f.calls.map(([op])=>op),['list','list','disable','list','unpair','list']);
  await assert.rejects(f.clients.revoke(data),{code:'HOST_CLIENTS_STALE'});
});
test('a stale window, extra fields and a host restart cannot revoke a saved UUID',async t=>{
  const f=fixture(t);await f.clients.refresh();const data=f.data(),before=f.calls.length;
  for(const value of [{...data,path:'/elsewhere'},{...data,uuid:'../escape'}])await assert.rejects(f.clients.revoke(value),{code:'HOST_CLIENTS_INVALID'});
  await assert.rejects(f.clients.revoke({...data,viewId:'old'}),{code:'HOST_CLIENTS_STALE'});
  f.session.current={};await assert.rejects(f.clients.revoke(data),{code:'HOST_CLIENTS_STALE'});assert.equal(f.calls.length,before);
  assert.notEqual(f.clients.snapshot().viewId,data.viewId);
});
test('lost unpair reply preserves disabled state and requires another explicit revoke',async t=>{
  const f=fixture(t);await f.clients.refresh();let lost=true;
  f.clients.request=async args=>{if(args.operation==='unpair' && lost)throw Error('private detail');return f.request(args);};
  await assert.rejects(f.clients.revoke(f.data()),{code:'HOST_CLIENTS_UNCONFIRMED'});
  let status=f.clients.snapshot();assert.equal(status.phase,'ready');assert.equal(status.error,'HOST_CLIENTS_UNCONFIRMED');
  assert.equal(status.devices[0].enabled,false);assert.equal(status.devices[1].enabled,true);
  await f.clients.refresh();assert.equal(f.calls.filter(([op])=>op==='disable').length,1);
  lost=false;status=await f.clients.revoke(f.data());assert.deepEqual(status.devices,[second]);assert.equal(status.error,null);
});
test('false disable confirmation or unchanged active device never proceeds to unpair',async t=>{
  for(const response of [false,true]){
    const f=fixture(t);await f.clients.refresh();f.clients.request=async args=>args.operation==='disable'?{status:response}:f.request(args);
    await assert.rejects(f.clients.revoke(f.data()),{code:'HOST_CLIENTS_UNCONFIRMED'});assert.equal(f.calls.some(([op])=>op==='unpair'),false);
  }
});
test('fresh native absence confirms a successful unpair whose reply was lost without repeating the write',async t=>{
  const f=fixture(t);await f.clients.refresh();
  f.clients.request=async args=>{const result=await f.request(args);if(args.operation==='unpair')throw Error('lost reply');return result;};
  const result=await f.clients.revoke(f.data());assert.equal(result.error,null);assert.deepEqual(result.devices,[second]);
  assert.equal(f.calls.filter(([op])=>op==='disable').length,1);assert.equal(f.calls.filter(([op])=>op==='unpair').length,1);
});
test('revocation cancels old list responses and serializes competing decisions',async t=>{
  const f=fixture(t);await f.clients.refresh();const data=f.data();let finishList,finishDisable;
  f.clients.request=async args=>{
    if(args.operation==='list' && !finishList)return new Promise(resolve=>finishList=resolve);
    if(args.operation==='disable')await new Promise(resolve=>finishDisable=resolve);return f.request(args);
  };
  const old=f.clients.refresh(),revoking=f.clients.revoke(data);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof finishDisable,'function');
  await assert.rejects(f.clients.revoke(data),{code:'HOST_CLIENTS_BUSY'});finishList([{...first}]);await old;
  assert.equal(f.clients.snapshot().phase,'revoking');finishDisable();await revoking;assert.deepEqual(f.clients.snapshot().devices,[second]);
});
test('window close preserves a revoke, but session replacement cancels it before the next write',async t=>{
  const f=fixture(t);await f.clients.refresh();let finish,signal;
  f.clients.request=async args=>{if(args.operation==='disable'){signal=args.signal;await new Promise(resolve=>finish=resolve);}return f.request(args);};
  const revoking=f.clients.revoke(f.data()),rejected=assert.rejects(revoking,{code:'HOST_CLIENTS_STALE'});
  await new Promise(resolve=>setImmediate(resolve));f.clients.releaseWindow();assert.equal(signal.aborted,false);
  f.session.current={};f.clients.reconcile();assert.equal(signal.aborted,true);finish();await rejected;
  assert.equal(f.calls.some(([op])=>op==='unpair'),false);assert.deepEqual(f.clients.snapshot().devices,[]);
});
test('close cancels and joins an outstanding management request',async t=>{
  const f=fixture(t);await f.clients.refresh();let finish,signal;
  f.clients.request=args=>{signal=args.signal;return new Promise(resolve=>finish=resolve);};
  const pending=f.clients.refresh();let closed=false;const closing=f.clients.close().then(()=>closed=true);
  assert.equal(signal.aborted,true);await Promise.resolve();assert.equal(closed,false);finish([first]);await pending;await closing;
  assert.equal(closed,true);assert.equal(f.clients.snapshot().phase,'unavailable');
});
