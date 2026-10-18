'use strict';
// Pairs ONLY with a synthetic, loopback Sunshine fixture launched by the Python harness.
const fs=require('node:fs'),crypto=require('node:crypto'),https=require('node:https');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const {pairHost}=require('../electron/mac/pairing.cjs');
(async()=>{
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  if(input.address!=='127.0.0.1')throw new Error('fixture must be loopback');
  const cert=fs.readFileSync(input.cert,'utf8'),key=fs.readFileSync(input.key,'utf8');
  const host=new crypto.X509Certificate(cert),client=new crypto.X509Certificate(identities.client.cert);
  let pin,session,approval;
  function admin(method,path,body){return new Promise((resolve,reject)=>{
    const bytes=body?Buffer.from(JSON.stringify(body)):null;
    const req=https.request({hostname:'127.0.0.1',port:input.port+1,path,method,ca:cert,checkServerIdentity:()=>undefined,agent:false,headers:{Authorization:'Basic '+Buffer.from('cliprelay-test:'+input.password).toString('base64'),...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{})}},res=>{
      let data='';res.on('data',chunk=>{data+=chunk;if(data.length>32768)req.destroy(new Error('large admin response'));});res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('admin HTTP '+res.statusCode);resolve(JSON.parse(data));}catch(error){reject(error);}});res.on('error',reject);
    });req.setTimeout(5000,()=>req.destroy(new Error('admin timeout')));req.on('error',reject);req.end(bytes);
  });}
  const bootstrap=https.createServer({cert,key,requestCert:true,rejectUnauthorized:false},async(req,res)=>{
    try{
      if(!req.socket.getPeerCertificate().raw?.equals(client.raw)){res.writeHead(403);res.end();return;}
      if(req.method==='DELETE'){res.end('{}');return;}
      let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);pin=data.pin;
      const hash=crypto.createHash('sha256').update('cliprelay-lan-pair-v1\n').update(host.raw).update(client.raw).update(data.nonce).digest('hex');session=hash.slice(0,32);
      res.end(JSON.stringify({id:session,verification:hash.slice(0,12).toUpperCase().match(/.{4}/g).join(' '),expires:Math.floor(Date.now()/1000)+120}));
    }catch{res.writeHead(400);res.end();}
  });
  const port=await listen(bootstrap);
  try{
    const result=await pairHost({address:'127.0.0.1',port:input.port,name:'Mac isolated protocol fixture',identity:identities.client,ports:{bootstrap:port},onVerification:()=>{
      approval=(async()=>{
        const deadline=Date.now()+15000;
        while(Date.now()<deadline){const result=await admin('GET','/api/pin');const pending=result.pairings?.find(item=>item.name==='ClipRelay-'+session);if(pending){await admin('POST','/api/pin',{pairing_id:pending.id,pin,name:'Mac isolated protocol fixture'});return;}await new Promise(resolve=>setTimeout(resolve,50));}
        throw new Error('fixture pending pairing not found');
      })();approval.catch(()=>{});
    }});
    await approval;
    const state=JSON.parse(fs.readFileSync(input.state,'utf8'));
    // Compare DER, not PEM formatting or a shared certificate header prefix.
    const contains=value=>{
      if(typeof value==='string'){try{return new crypto.X509Certificate(value).raw.equals(client.raw);}catch{return false;}}
      return !!value && typeof value==='object' && Object.values(value).some(contains);
    };
    if(!contains(state))throw new Error('completed certificate missing from Sunshine state');
    const matched=new crypto.X509Certificate(result.certificate).raw.equals(host.raw);
    if(!matched)throw new Error('engine certificate mismatch');
    process.stdout.write(JSON.stringify({passed:true,hostId:result.id,clientId:result.clientId,engineCertificateMatched:matched,clientCertificatePersisted:true,realSunshinePairing:true}));
  }finally{await close(bootstrap);}
})().catch(error=>{process.stderr.write(String(error.code || error.message));process.exitCode=1;});
