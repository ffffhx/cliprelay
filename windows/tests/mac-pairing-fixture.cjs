'use strict';
const {execFileSync}=require('node:child_process');
const path=require('node:path'),crypto=require('node:crypto'),http=require('node:http'),https=require('node:https');
const {once}=require('node:events');
const generator=process.env.CLIPRELAY_PAIRING_TEST_FIXTURE;
if(generator&&!path.isAbsolute(generator))throw Error('Pairing fixture executable must use an absolute path');
const identities=JSON.parse(execFileSync(generator||'go',generator?[]:['run',path.join(__dirname,'mac-pairing-fixture/main.go')],{encoding:'utf8',timeout:60000,windowsHide:true,maxBuffer:32768,env:{...process.env,GOTOOLCHAIN:'local'}}));
const der=value=>new crypto.X509Certificate(value).raw;
const digest=(...parts)=>crypto.createHash('sha256').update(Buffer.concat(parts.map(p=>Buffer.isBuffer(p)?p:Buffer.from(p)))).digest();
const aes=(bytes,key,decrypt=false)=>{const c=(decrypt?crypto.createDecipheriv:crypto.createCipheriv)('aes-128-ecb',key,null);c.setAutoPadding(false);return Buffer.concat([c.update(bytes),c.final()]);};
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
async function fixture({badSignature=false,badCode=false,badPin=false,clientIdentity=identities.client}={}){
  const host=identities.host,client=clientIdentity,trace=[],writes=[];
  let pin,id,session,key,challenge,responseHash,authorized=false,approval=false,waiting,deleted=false;
  const xml=(response,fields)=>response.end('<root status_code="200"><paired>1</paired>'+Object.entries(fields).map(([k,v])=>'<'+k+'>'+v+'</'+k+'>').join('')+'</root>');
  const server=https.createServer({key:host.key,cert:host.cert,requestCert:true,rejectUnauthorized:false},async(req,res)=>{
    if(!req.socket.getPeerCertificate().raw?.equals(der(client.cert))){res.writeHead(403);res.end();return;}
    if(req.url==='/v1/pair'){
      let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);pin=data.pin;
      const hashed=digest('cliprelay-lan-pair-v1\n',der(host.cert),der(client.cert),data.nonce).toString('hex');id=hashed.slice(0,32);
      res.end(JSON.stringify({id,verification:badCode?'FFFF FFFF FFFF':hashed.slice(0,12).toUpperCase().match(/.{4}/g).join(' '),expires:Math.floor(Date.now()/1000)+120}));return;
    }
    if(req.method==='DELETE'){deleted=true;res.end('{}');return;}
    if(!authorized){res.writeHead(403);res.end();return;}
    if(req.url.startsWith('/pair?')){trace.push('secure-challenge');xml(res,{});return;}
    if(req.url==='/v1/clipboard'){let body='';for await(const chunk of req)body+=chunk;writes.push(JSON.parse(body));res.end('{"ok":true}');return;}
    if(req.url==='/v1/relay'){res.end('{"ok":true,"state":"idle"}');return;}
    res.writeHead(404);res.end();
  });
  const plain=http.createServer((req,res)=>{
    const query=new URL(req.url,'http://fixture').searchParams;
    if(query.get('uniqueid')!==id){res.writeHead(400);res.end();return;}
    if(query.get('phrase')==='getservercert'){
      trace.push('get-cert');session=query.get('devicename');
      if(session!=='ClipRelay-'+id || !Buffer.from(query.get('clientcert'),'hex').equals(Buffer.from(client.cert))){res.writeHead(400);res.end();return;}
      key=digest(Buffer.from(query.get('salt'),'hex'),badPin?'99999':pin).subarray(0,16);
      const answer=()=>xml(res,{plaincert:Buffer.from(host.cert).toString('hex')});if(approval)answer();else waiting=answer;return;
    }
    if(query.has('clientchallenge')){
      trace.push('challenge');challenge=aes(Buffer.from(query.get('clientchallenge'),'hex'),key,true);
      fixture.serverSecret=crypto.randomBytes(16);fixture.serverChallenge=crypto.randomBytes(16);
      xml(res,{challengeresponse:aes(Buffer.concat([digest(challenge,Buffer.from(host.signature,'hex'),fixture.serverSecret),fixture.serverChallenge]),key).toString('hex')});return;
    }
    if(query.has('serverchallengeresp')){
      trace.push('server-proof');responseHash=aes(Buffer.from(query.get('serverchallengeresp'),'hex'),key,true);
      const signature=crypto.sign('sha256',fixture.serverSecret,badSignature?identities.wrong.key:host.key);
      xml(res,{pairingsecret:Buffer.concat([fixture.serverSecret,signature]).toString('hex')});return;
    }
    if(query.has('clientpairingsecret')){
      trace.push('client-proof');const secret=Buffer.from(query.get('clientpairingsecret'),'hex');
      if(!crypto.verify('sha256',secret.subarray(0,16),client.cert,secret.subarray(16)) || !digest(fixture.serverChallenge,Buffer.from(client.signature,'hex'),secret.subarray(0,16)).equals(responseHash)){res.writeHead(403);res.end();return;}
      authorized=true;xml(res,{});return;
    }
    res.writeHead(404);res.end();
  });
  const secure=await listen(server),httpPort=await listen(plain);
  return {host,client,trace,writes,ports:{bootstrap:secure,http:httpPort,secure},approve:()=>{approval=true;waiting?.();},get authorized(){return authorized;},get deleted(){return deleted;},close:async()=>{await close(plain);await close(server);}};
}
module.exports={identities,fixture,listen,close};
