'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),https=require('node:https'),http=require('node:http');
const {once}=require('node:events');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-qt-probe-'));
test.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
function identity(name,ca=false){
  const key=path.join(directory,name+'.key'),cert=path.join(directory,name+'.crt');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','2','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost',...(ca?['-addext','basicConstraints=critical,CA:TRUE']:[])],{stdio:'ignore'});
  return {key:fs.readFileSync(key,'utf8'),cert:fs.readFileSync(cert,'utf8'),file:cert};
}
const host=identity('host'),client=identity('client'),wrong=identity('wrong',true);
function envelope(port=48789){return {version:1,address:'127.0.0.1',port,clientId:'a'.repeat(32),certificate:client.cert,privateKey:client.key,hostCertificate:host.cert,width:1920,height:1080,fps:60,bitrate:12000,fullscreen:false};}
function frame(value){const json=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);header.writeUInt32BE(json.length);return Buffer.concat([header,json]);}
function start(value,args=[],extraEnv={}){
  const child=spawn(process.env.CLIPRELAY_QT_PROBE,args,{stdio:['pipe','pipe','pipe'],env:{...process.env,CLIPRELAY_PROBE_SETTINGS:directory,...extraEnv}});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  child.stdin.on('error',()=>{});child.stdin.write(Buffer.isBuffer(value)?value:frame(value));
  const done=once(child,'close').then(([code])=>({code,stdout,stderr}));
  const timer=setTimeout(()=>child.kill(),12000);done.finally(()=>clearTimeout(timer));
  return {child,done};
}
test('bounded envelope imports existing identity without writing Qt settings',async()=>{
  const result=await start(envelope(),['--parse']).done;assert.equal(result.code,0,result.stderr);
  assert.equal(fs.existsSync(path.join(directory,'ClipRelay Probe')),false);
});
test('invalid identity, types, limits and unknown properties fail closed',async()=>{
  for(const change of [{version:2},{port:65535},{width:1},{fps:60.5},{fullscreen:1},{address:'https://example.com'},{privateKey:wrong.key},{clientId:'x'},{unexpected:1},{bitrate:100001}]){
    const result=await start({...envelope(),...change},['--parse']).done;assert.equal(result.code,2,JSON.stringify(change));
  }
  const result=await start(Buffer.from([0,2,0,0]),['--parse']).done;assert.equal(result.code,2);
});
test('parent pipe close ends session and a truncated frame cannot hang',async()=>{
  const run=start(envelope(),['--lease']);await once(run.child.stdout,'data');run.child.stdin.end();
  assert.equal((await run.done).code,0);
  const broken=start(Buffer.from([0,0,0,100]),['--parse']);broken.child.stdin.end();assert.equal((await broken.done).code,2);
});
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
test('real mutual TLS uses paired identity and preserves client ID',async()=>{
  let count=0;
  const server=https.createServer({key:host.key,cert:host.cert,requestCert:true,rejectUnauthorized:false},(req,res)=>{
    count++;assert.ok(req.socket.getPeerCertificate().raw);assert.equal(new URL(req.url,'https://local').searchParams.get('uniqueid'),'a'.repeat(32));
    res.end('<root status_code="200"><PairStatus>1</PairStatus></root>');
  });
  try{const port=await listen(server);const result=await start(envelope(port+5)).done;assert.equal(result.code,0,result.stderr);assert.equal(count,1);}finally{await close(server);}
});
test('wrong pinned certificate receives zero HTTP even when trusted by the system',async()=>{
  let count=0;const server=https.createServer({key:wrong.key,cert:wrong.cert},(req,res)=>{count++;res.end('<root status_code="200"/>');});
  try{const port=await listen(server);const result=await start(envelope(port+5),[],{CLIPRELAY_PROBE_CA:wrong.file}).done;assert.equal(result.code,6,result.stderr);assert.equal(count,0);}finally{await close(server);}
});
test('redirect is not followed and 401 does not fall back to HTTP',async()=>{
  let plain=0;const fallback=http.createServer((req,res)=>{plain++;res.end('<root status_code="200"/>');});
  const fallbackPort=await listen(fallback);let status=302;
  const server=https.createServer({key:host.key,cert:host.cert},(req,res)=>{if(status===302){res.writeHead(302,{Location:`http://127.0.0.1:${fallbackPort}/stolen`});res.end();}else res.end('<root status_code="401"/>');});
  try{const port=await listen(server);assert.equal((await start(envelope(port+5)).done).code,6);status=401;assert.equal((await start(envelope(port+5)).done).code,6);assert.equal(plain,0);}finally{await close(server);await close(fallback);}
});
