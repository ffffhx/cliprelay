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
async function listen(server,{maximumPort}={}){
  if(maximumPort===undefined){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
  if(!Number.isInteger(maximumPort)||maximumPort<10240||maximumPort>65535)throw Error('Invalid fixture port range');
  // A stream fixture derives a base port from this listener and must leave room
  // for the production protocol offsets. OS-selected ports can be too high.
  for(let attempt=0;attempt<32;attempt++){
    try{server.listen(crypto.randomInt(10240,maximumPort+1),'127.0.0.1');await once(server,'listening');return server.address().port;}
    catch(error){if(!['EADDRINUSE','EACCES'].includes(error.code))throw error;}
  }
  throw Error('Fixture port range unavailable');
}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
async function fixture({badSignature=false,badCode=false,badPin=false,clientIdentity=identities.client,feedback=false,native=false,onStatus}={}){
  const host=identities.host,client=clientIdentity,trace=[],writes=[];
  let pin,id,session,key,challenge,responseHash,authorized=false,approval=false,waiting,deleted=false;
  const receipt=crypto.randomBytes(16).toString('hex');let expires,state='waiting',statusReads=0,cancelReceipt;
  const nativeID=crypto.randomBytes(16).toString('hex');let nativeAdvertised=false;
  const xml=(response,fields)=>response.end('<root status_code="200"><paired>1</paired>'+Object.entries(fields).map(([k,v])=>'<'+k+'>'+v+'</'+k+'>').join('')+'</root>');
  const server=https.createServer({key:host.key,cert:host.cert,requestCert:true,rejectUnauthorized:false},async(req,res)=>{
    if(!req.socket.getPeerCertificate().raw?.equals(der(client.cert))){res.writeHead(403);res.end();return;}
    if(req.url==='/v1/pair'){
      let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);pin=data.pin;
      const hashed=digest('cliprelay-lan-pair-v1\n',der(host.cert),der(client.cert),data.nonce).toString('hex');id=hashed.slice(0,32);
      expires=Math.floor(Date.now()/1000)+120;
      nativeAdvertised=native&&feedback&&req.headers['x-cliprelay-pairing-native']==='1';
      res.end(JSON.stringify({id,verification:badCode?'FFFF FFFF FFFF':hashed.slice(0,12).toUpperCase().match(/.{4}/g).join(' '),expires,
        ...(feedback&&req.headers['x-cliprelay-pairing-feedback']==='1'?{feedback:{protocol:1,receipt}}:{}),
        ...(nativeAdvertised?{native:{protocol:1,id:nativeID}}:{})}));return;
    }
    if(req.url==='/v1/pair/status'){
      statusReads++;let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
      if(body.id!==id || body.receipt!==receipt){res.writeHead(404);res.end();return;}
      const value={protocol:1,id,receipt,state,expires};
      if(onStatus){onStatus({req,res,value});return;}res.end(JSON.stringify(value));return;
    }
    if(req.method==='DELETE'){cancelReceipt=req.headers['x-cliprelay-pairing-receipt'];if(feedback&&cancelReceipt!==receipt){res.writeHead(404);res.end();return;}deleted=true;res.end('{}');return;}
    if(!authorized){res.writeHead(403);res.end();return;}
    if(req.url.startsWith('/pair?')){trace.push('secure-challenge');xml(res,{});return;}
    if(req.url==='/v1/clipboard'){let body='';for await(const chunk of req)body+=chunk;writes.push(JSON.parse(body));res.end('{"ok":true}');return;}
    if(req.url==='/v1/relay'){res.end('{"ok":true,"state":"idle"}');return;}
    res.writeHead(404);res.end();
  });
  const plain=http.createServer((req,res)=>{
    const query=new URL(req.url,'http://fixture').searchParams;
    const expectedID=nativeAdvertised?nativeID:id;
    if(query.get('uniqueid')!==expectedID || (nativeAdvertised&&query.get('cliprelay_pairing')!==nativeID)){res.writeHead(400);res.end();return;}
    if(query.get('phrase')==='getservercert'){
      trace.push('get-cert');session=query.get('devicename');
      if(session!=='ClipRelay-'+expectedID || !Buffer.from(query.get('clientcert'),'hex').equals(Buffer.from(client.cert))){res.writeHead(400);res.end();return;}
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
  return {host,client,trace,writes,receipt,nativeID,get bootstrapID(){return id;},ports:{bootstrap:secure,http:httpPort,secure},approve:()=>{approval=true;waiting?.();},
    setFeedback(value){state=value;},replaceCertificate(value){server.setSecureContext({key:value.key,cert:value.cert});},get statusReads(){return statusReads;},get cancelReceipt(){return cancelReceipt;},
    get authorized(){return authorized;},get deleted(){return deleted;},close:async()=>{await close(plain);await close(server);}};
}
module.exports={identities,fixture,listen,close};
