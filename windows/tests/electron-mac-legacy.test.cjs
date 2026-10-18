'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {isLocalAddress,resolveLocal}=require('../electron/mac/legacy.cjs');
const {sendSelection,postText,createReceiver}=require('../electron/mac/relay.cjs');
const {loadConfig}=require('../electron/mac/config.cjs');

function request(port,body,headers={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:'/push',method:'POST',headers,agent:false},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    req.setTimeout(3000,()=>req.destroy(new Error('test timeout')));req.on('error',error=>{error.message+='; request body bytes='+Buffer.byteLength(body)+', declared='+headers['Content-Length'];reject(error);});req.end(body);
  });
}
async function stop(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
test('compatibility allows only explicit local IPv4/IPv6, including mapped IPv4',async()=>{
  for(const address of ['127.0.0.1','10.2.3.4','172.16.1.1','172.31.255.254','192.168.1.2','169.254.1.1','::1','fd12::1','fc00::1','fe80::1','::ffff:192.168.1.2','0:0:0:0:0:ffff:c0a8:102'])assert.equal(isLocalAddress(address),true,address);
  for(const address of ['0.0.0.0','8.8.8.8','192.0.2.1','100.64.1.1','172.15.1.1','172.32.1.1','224.0.0.1','::','2001:db8::1','ff02::1','::ffff:8.8.8.8','garbage'])assert.equal(isLocalAddress(address),false,address);
  assert.equal(await resolveLocal('fixture.local',async()=>[{address:'192.0.2.1'},{address:'192.168.1.2'}]),'192.168.1.2');
  await assert.rejects(resolveLocal('fixture.local',async()=>[{address:'192.0.2.1'}]),/局域网/);
  await assert.rejects(postText({legacyEnabled:true,peer:'192.0.2.1',peerPort:1},'fixture'),/局域网/);
});
test('disabled compatibility never reads the clipboard or opens the copy helper',async()=>{
  const fail=()=>{throw new Error('must not access clipboard')};
  for(const value of [undefined,false,'true',1]){
    assert.equal(await sendSelection({config:{legacyEnabled:value},clipboard:{availableFormats:fail},copySelection:fail}),false);
    await assert.rejects(postText({legacyEnabled:value,peer:'127.0.0.1',peerPort:1},'fixture'),/未开启/);
  }
});
test('legacy receiver authenticates, bounds and decodes bodies, and rechecks disable during upload',{timeout:5000},async()=>{
  const config={legacyEnabled:false,accessToken:'fixture-key'},writes=[];
  const server=createReceiver({getConfig:()=>config,clipboard:{writeText:text=>writes.push(text)},notify:()=>{}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
  const body=JSON.stringify({text:'fixture 中文'}),auth={'X-ClipRelay-Token':'fixture-key'};
  try{
    assert.equal(await request(port,body,auth),403);
    config.legacyEnabled=true;
    assert.equal(await request(port,body),401);
    assert.equal(await request(port,body,{'X-ClipRelay-Token':'wrong'}),401);
    assert.equal(await request(port,JSON.stringify({text:'probe',probe:true}),auth),200);assert.equal(writes.length,0);
    assert.equal(await request(port,body,auth),200);assert.deepEqual(writes,['fixture 中文']);
    assert.equal(await request(port,Buffer.from([0xff]),auth),400);
    assert.equal(await request(port,'',Object.assign({'Content-Length':1048577},auth)),413);
    // Closing an oversized upload can report EPIPE or ECONNRESET to its writer
    // before the response arrives. Still require the real server to finish 413;
    // a socket error alone is not proof that the size policy ran.
    const rejectedResponse=new Promise(resolve=>server.once('request',(_request,response)=>response.once('finish',()=>resolve(response.statusCode))));
    const oversized=await request(port,'x'.repeat(1048577),auth).catch(error=>{if(['ECONNRESET','EPIPE'].includes(error.code))return error.code;throw error;});
    assert.ok([413,'ECONNRESET','EPIPE'].includes(oversized));assert.equal(await rejectedResponse,413);assert.deepEqual(writes,['fixture 中文']);
    await new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port,path:'/push',method:'POST',headers:auth,agent:false},res=>{res.resume();res.on('end',()=>{try{assert.equal(res.statusCode,403);resolve();}catch(error){reject(error);}});});
      req.setTimeout(3000,()=>req.destroy(new Error('test timeout')));req.on('error',reject);
      // Ensure headers are accepted while enabled, then change the live config before the body completes.
      server.once('request',()=>{config.legacyEnabled=false;req.end('"partial"}');});req.write('{"text":');
    });
    assert.deepEqual(writes,['fixture 中文']);
  }finally{await stop(server);}
});
test('redirect response is a failure and never forwards clipboard or credentials',async()=>{
  let calls=0;
  const server=http.createServer((req,res)=>{calls++;req.resume();res.writeHead(302,{Location:'/leak'});res.end();});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{await assert.rejects(postText({legacyEnabled:true,peer:'127.0.0.1',peerPort:server.address().port,peerToken:'fixture'},'fixture'),/302/);assert.equal(calls,1);}
  finally{await stop(server);}
});
test('upgrade keeps saved peer and tokens but never infers plaintext consent',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-legacy-test-'));
  try{
    for(const legacyEnabled of [undefined,'true',true,false]){
      fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify({peer:'saved.local',peerToken:'saved',accessToken:'receiver',legacyEnabled}));
      const config=loadConfig(directory);
      assert.equal(config.legacyEnabled,legacyEnabled===true);assert.equal(config.peer,'saved.local');assert.equal(config.peerToken,'saved');assert.equal(config.accessToken,'receiver');
      assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'config.json'))).legacyEnabled,legacyEnabled===true);
    }
  }finally{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(directory).startsWith('cliprelay-legacy-test-'));fs.rmSync(directory,{recursive:true,force:true});}
});
