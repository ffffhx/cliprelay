'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),https=require('node:https'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{once}=require('node:events');
assert.equal(process.platform,'win32');
const executable=process.env.CLIPRELAY_TEST_ENGINE_ADMIN;assert.ok(executable && path.isAbsolute(executable));
const {identities}=require('./mac-pairing-fixture.cjs');
const certificate=value=>new crypto.X509Certificate(value).raw.toString('base64');
async function server(handler){
  const sockets=new Set(),requests=[];
  const owner=https.createServer({key:identities.host.key,cert:identities.host.cert},(req,res)=>{requests.push(req);handler(req,res);});
  owner.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});owner.on('tlsClientError',()=>{});
  owner.listen(0,'127.0.0.1');await once(owner,'listening');
  return {requests,port:owner.address().port,async close(){owner.closeAllConnections();for(const socket of sockets)socket.destroy();await new Promise(resolve=>owner.close(resolve));}};
}
function call(host,options={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',errors='',settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
    const timer=setTimeout(()=>{child.kill();finish(Error('Owned admin fixture exceeded deadline'));},6000);
    child.once('error',error=>finish(error));child.stdin.on('error',error=>finish(error));
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>16384){child.kill();finish(Error('Fixture output exceeded limit'));}});
    child.stderr.on('data',chunk=>{errors+=chunk;if(errors.length>16384){child.kill();finish(Error('Fixture error output exceeded limit'));}});
    child.once('close',(code,signal)=>{try{assert.equal(code,0);assert.equal(signal,null);assert.equal(errors,'');finish(null,JSON.parse(output));}catch(error){finish(error);}});
    child.stdin.end(JSON.stringify({certificate:certificate(identities.host.cert),method:'GET',path:'/api/clients/list',timeoutMs:2500,replyLimit:65536,port:host.port,...options})+'\n');
  });
}
const denied=result=>{assert.equal(result.ok,false);assert.equal(typeof result.error,'string');};
test('actual C# transport pins the certificate and sends one fixed authenticated GET and POST',async()=>{
  const bodies=[];const host=await server(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;bodies.push(body);res.end('{"status":true}');});
  try{
    assert.deepEqual((await call(host)).result,{status:true});
    assert.deepEqual((await call(host,{method:'POST',path:'/api/clients/update',body:{uuid:'fixture',enabled:false}})).result,{status:true});
    assert.equal(host.requests.length,2);assert.deepEqual(bodies,['','{"uuid":"fixture","enabled":false}']);
    for(const req of host.requests)assert.equal(req.headers.authorization,'Basic '+Buffer.from('cliprelay:disposable-admin-password').toString('base64'));
  }finally{await host.close();}
});
test('wrong native certificate receives no HTTP headers or body',async()=>{
  const host=await server((_req,res)=>res.end('{"status":true}'));
  try{denied(await call(host,{certificate:certificate(identities.wrong.cert),method:'POST',path:'/api/clients/update',body:{uuid:'fixture',enabled:false}}));assert.equal(host.requests.length,0);}
  finally{await host.close();}
});
test('redirects cannot forward authorization or replay a native mutation',async()=>{
  const destination=await server((_req,res)=>res.end('{"status":true}'));
  const host=await server((_req,res)=>{res.writeHead(307,{Location:'https://127.0.0.1:'+destination.port+'/api/clients/update'});res.end();});
  try{denied(await call(host,{method:'POST',path:'/api/clients/update',body:{uuid:'fixture',enabled:false}}));assert.equal(host.requests.length,1);assert.equal(destination.requests.length,0);}
  finally{await host.close();await destination.close();}
});
test('a native server withholding headers cannot retain the caller beyond the request deadline',async()=>{
  const host=await server(()=>{});
  try{const result=await call(host,{timeoutMs:1000});denied(result);assert.equal(host.requests.length,1);assert.ok(result.elapsedMs>=800 && result.elapsedMs<3500);}
  finally{await host.close();}
});
test('continuously arriving body bytes cannot extend the total native request deadline',async()=>{
  const host=await server((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{');const timer=setInterval(()=>res.write(' '),25);res.once('close',()=>clearInterval(timer));});
  try{const result=await call(host,{timeoutMs:1000});denied(result);assert.equal(host.requests.length,1);assert.ok(result.elapsedMs>=800 && result.elapsedMs<3500);}
  finally{await host.close();}
});
test('oversized, invalid UTF-8 and invalid JSON native replies fail without exposure',async()=>{
  for(const body of [Buffer.alloc(1025,32),Buffer.from([0xc3,0x28]),Buffer.from('{"status":')]){
    const host=await server((_req,res)=>res.end(body));
    try{denied(await call(host,{replyLimit:1024}));assert.equal(host.requests.length,1);}
    finally{await host.close();}
  }
});
test('a lost POST reply does not cause the native mutation to be sent again',async()=>{
  const host=await server(async(req,_res)=>{for await(const _chunk of req){}req.socket.destroy();});
  try{denied(await call(host,{method:'POST',path:'/api/clients/unpair',body:{uuid:'fixture'}}));assert.equal(host.requests.length,1);}
  finally{await host.close();}
});
test('invalid operation, query URL and request budgets are rejected before network access',async()=>{
  const host=await server((_req,res)=>res.end('{"status":true}'));
  try{
    for(const options of [{path:'/api/clients/update?next=external',method:'POST'},{path:'/unlisted'},{method:'PUT'},{body:{unexpected:true}},{timeoutMs:0},{replyLimit:1024*1024+1}])denied(await call(host,options));
    assert.equal(host.requests.length,0);
  }finally{await host.close();}
});
