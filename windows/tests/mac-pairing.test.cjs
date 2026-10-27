'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),https=require('node:https');
const {identities,fixture,listen,close}=require('./mac-pairing-fixture.cjs');
const {exchange,jsonRequest}=require('../electron/mac/paired-transport.cjs');
const {signature}=require('../electron/mac/paired-crypto.cjs');
const {pairHost}=require('../electron/mac/pairing.cjs');

test('DER certificate signature matches independently parsed Go certificate',()=>{
  for(const value of Object.values(identities))assert.equal(signature(value.cert).toString('hex'),value.signature);
});

test('first pairing sends the device code inside TLS and rejects absent or incorrect codes before native exchange',async()=>{
  const f=await fixture({deviceCode:'12345678'});f.approve();
  const args={address:'127.0.0.1',name:'Viewer',identity:f.client,ports:f.ports};
  try{
    await assert.rejects(pairHost(args),{code:'DEVICE_CODE_REQUIRED'});
    await assert.rejects(pairHost({...args,deviceCode:'87654321'}),{code:'DEVICE_CODE_INVALID'});
    assert.deepEqual(f.trace,[]);
    const host=await pairHost({...args,deviceCode:'12345678'});assert.equal(f.authorized,true);
    assert.equal(JSON.stringify(host).includes('12345678'),false);
  }finally{await f.close();}
});
test('client finishes PIN and signed-secret exchange only after operator approval',async()=>{
  const f=await fixture();let showCode;
  const shown=new Promise(resolve=>{showCode=resolve});
  try{
    const pending=pairHost({address:'127.0.0.1',name:'Test Mac',identity:f.client,ports:f.ports,onVerification:code=>showCode(code)});
    const code=await shown;assert.match(code.verification,/^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);assert.equal(f.authorized,false);
    f.approve();const host=await pending;
    assert.equal(host.certificate,f.host.cert);assert.match(host.id,/^[a-f0-9]{64}$/);assert.equal(f.authorized,true);assert.equal(f.deleted,true);
    assert.deepEqual(f.trace,['get-cert','challenge','server-proof','client-proof','secure-challenge']);
  }finally{await f.close();}
});
test('wrong code, wrong PIN, and forged server signature never authorize the client',async()=>{
  for(const [option,error] of [['badCode','PAIRING_CODE_MISMATCH'],['badPin','PAIRING_PIN_MISMATCH'],['badSignature','PAIRING_SIGNATURE_INVALID']]){
    const f=await fixture({[option]:true});f.approve();
    try{await assert.rejects(pairHost({address:'127.0.0.1',name:'Test',identity:f.client,ports:f.ports}),{code:error});assert.equal(f.authorized,false);assert.ok(!f.trace.includes('client-proof'));}
    finally{await f.close();}
  }
});
test('changed server certificate receives zero HTTP requests, including clipboard bodies',async()=>{
  let requests=0;const wrong=identities.wrong;
  const server=https.createServer({key:wrong.key,cert:wrong.cert},(req,res)=>{requests++;res.end('{"ok":true}');});
  const port=await listen(server);
  try{
    await assert.rejects(jsonRequest({address:'127.0.0.1',port,path:'/v1/clipboard',body:{secret:'synthetic clipboard'},identity:identities.client,trust:{cert:identities.host.cert}}),{code:'HOST_CERT_CHANGED'});
    assert.equal(requests,0);
  }finally{await close(server);}
});
test('cancelling pending pairing closes the request and removes bootstrap state',async()=>{
  const f=await fixture(),controller=new AbortController();
  try{
    await assert.rejects(pairHost({address:'127.0.0.1',name:'Test',identity:f.client,ports:f.ports,signal:controller.signal,onVerification:()=>controller.abort()}),{code:'CANCELLED'});
    assert.equal(f.authorized,false);assert.equal(f.deleted,true);assert.deepEqual(f.trace,[]);
  }finally{await f.close();}
});
test('pinned transport rejects redirects and oversized replies and obeys a total deadline',async()=>{
  const host=identities.host;let pathSeen=[];
  const server=https.createServer({key:host.key,cert:host.cert},(req,res)=>{pathSeen.push(req.url);if(req.url==='/redirect'){res.writeHead(302,{Location:'/leak'});res.end();}else if(req.url==='/large')res.end('x'.repeat(1025));});
  const port=await listen(server),base={address:'127.0.0.1',port,identity:identities.client,trust:{cert:host.cert}};
  try{
    await assert.rejects(exchange({...base,path:'/redirect'}),{code:'HTTP_302'});
    await assert.rejects(exchange({...base,path:'/large',limit:1024}),{code:'REPLY_TOO_LARGE'});
    await assert.rejects(exchange({...base,path:'/stall',timeout:80}),{code:'TIMEOUT'});
    assert.deepEqual(pathSeen,['/redirect','/large','/stall']);
  }finally{await close(server);}
});
