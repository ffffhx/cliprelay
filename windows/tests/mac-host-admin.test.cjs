'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),https=require('node:https');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const {hostStatus}=require('../electron/mac/host-admin.cjs');
const reply={protocol:1,pid:2345,ownerPid:1234,owned:true,screenRecording:true,inputControl:true};
const authorization='Basic '+Buffer.from('cliprelay:synthetic-test-secret').toString('base64');
const state={read(name,limit){assert.equal(name,'cacert.pem');assert.equal(limit,16384);return Buffer.from(identities.host.cert);},authorization:()=>authorization};
async function server(t,handler,identity=identities.host){
  const service=https.createServer({key:identity.key,cert:identity.cert},handler),port=await listen(service);
  t.after(()=>close(service));return port;
}
test('pinned local engine receives only the fixed authenticated status request',async t=>{
  const port=await server(t,(req,res)=>{assert.equal(req.url,'/api/cliprelay/host');assert.equal(req.method,'GET');assert.equal(req.headers.authorization,authorization);res.end(JSON.stringify(reply));});
  assert.deepEqual(await hostStatus({state,port}),reply);
});
test('a different local certificate receives no HTTP request or admin secret',async t=>{
  let requests=0;const port=await server(t,(_req,res)=>{requests++;res.end(JSON.stringify(reply));},identities.wrong);
  await assert.rejects(hostStatus({state,port}),{code:'HOST_CERT_CHANGED'});assert.equal(requests,0);
});
test('redirects, denial, oversized and malformed replies fail with fixed errors',async t=>{
  let mode='redirect',requests=0;
  const port=await server(t,(_req,res)=>{requests++;if(mode==='redirect'){res.writeHead(302,{Location:'https://example.invalid'});res.end();}
    else if(mode==='denied'){res.writeHead(401);res.end();}else if(mode==='large')res.end('x'.repeat(16385));else res.end(JSON.stringify({...reply,pid:'2345'}));});
  for(const selected of ['redirect','denied','large','malformed']){mode=selected;await assert.rejects(hostStatus({state,port}),{code:mode==='denied'?'HOST_ADMIN_UNAUTHORIZED':'HOST_ADMIN_BAD_REPLY'});}
  assert.equal(requests,4);
});
test('pending requests honor cancellation and a total deadline',async t=>{
  let received;const accepted=new Promise(resolve=>{received=resolve;});
  const port=await server(t,()=>received());
  const abort=new AbortController(),pending=hostStatus({state,port,signal:abort.signal}),rejected=assert.rejects(pending,{code:'HOST_ADMIN_CANCELLED'});
  await accepted;abort.abort();await rejected;
  await assert.rejects(hostStatus({state,port,timeout:80}),{code:'HOST_ADMIN_TIMEOUT'});
});
test('unavailable or malformed private credentials cause no network attempt',async()=>{
  await assert.rejects(hostStatus({state:{read(){throw Object.assign(new Error('private path'),{code:'ENOENT'});}}}),{code:'HOST_CERT_UNAVAILABLE'});
  await assert.rejects(hostStatus({state:{...state,authorization:()=> 'invalid\nheader'}}),{code:'HOST_ADMIN_INVALID'});
  await assert.rejects(hostStatus({state:{...state,read:()=>Buffer.from('-----BEGIN CERTIFICATE-----\npartial')}}),{code:'HOST_CERT_UNAVAILABLE'});
  const abort=new AbortController();abort.abort();await assert.rejects(hostStatus({state,signal:abort.signal}),{code:'HOST_ADMIN_CANCELLED'});
});
