// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const http=require('node:http'),https=require('node:https');
const {signature}=require('../../windows/electron/mac/paired-crypto.cjs');
const [directory,mode]=process.argv.slice(2);
const host={key:fs.readFileSync(path.join(directory,'server.key')),cert:fs.readFileSync(path.join(directory,'server.crt'))};
const client=fs.readFileSync(path.join(directory,'client.crt'));
const der=cert=>new crypto.X509Certificate(cert).raw;
const hash=(...values)=>crypto.createHash('sha256').update(Buffer.concat(values.map(value=>Buffer.isBuffer(value)?value:Buffer.from(value)))).digest();
const aes=(bytes,key,decrypt=false)=>{const cipher=(decrypt?crypto.createDecipheriv:crypto.createCipheriv)('aes-128-ecb',key,null);cipher.setAutoPadding(false);return Buffer.concat([cipher.update(bytes),cipher.final()]);};
let pin,id,expires,secretKey,challenge,clientProof,proofFinished=false,deleted=false,verificationObserved=false;
const native=crypto.randomBytes(16).toString('hex'),receipt=crypto.randomBytes(16).toString('hex');
function xml(response,values,paired=true){response.end('<root status_code="200"><paired>'+(paired?'1':'0')+'</paired>'+Object.entries(values).map(([key,value])=>`<${key}>${value}</${key}>`).join('')+'</root>');}
async function handler(request,response){
  const secure=request.socket.encrypted,url=new URL(request.url,'http://localhost');
  if(secure&&!request.socket.getPeerCertificate().raw?.equals(der(client))){response.writeHead(403);response.end();return;}
  if(secure&&url.pathname==='/v1/pair'&&request.method==='POST'){
    let data='';for await(const chunk of request)data+=chunk;data=JSON.parse(data);pin=data.pin;
    const digest=hash('cliprelay-lan-pair-v1\n',der(host.cert),der(client),data.nonce).toString('hex');id=digest.slice(0,32);expires=Math.floor(Date.now()/1000)+120;
    response.end(JSON.stringify({id,verification:mode==='bad-code'?'FFFF FFFF FFFF':digest.slice(0,12).toUpperCase().match(/.{4}/g).join(' '),expires,feedback:{protocol:1,receipt},native:{protocol:1,id:native}}));return;
  }
  if(secure&&url.pathname==='/v1/pair/status'){
    let data='';for await(const chunk of request)data+=chunk;data=JSON.parse(data);
    if(data.id!==id||data.receipt!==receipt)throw Error('Wrong feedback binding');
    response.end(JSON.stringify({protocol:1,id,receipt,expires,state:mode==='reject'?'rejected':mode==='expire'?'expired':'handshake'}));return;
  }
  if(secure&&url.pathname==='/v1/pair/'+id&&request.method==='DELETE'){
    if(request.headers['x-cliprelay-pairing-receipt']!==receipt)throw Error('Wrong cleanup receipt');
    deleted=true;response.writeHead(204);response.end();return;
  }
  if(url.pathname==='/pair'){
    const q=url.searchParams;
    if(q.get('uniqueid')!==native||q.get('cliprelay_pairing')!==native||q.get('devicename')!=='ClipRelay-'+native)throw Error('Native pairing not isolated');
    if(mode==='reject'||mode==='expire'){xml(response,{},false);return;}
    if(q.get('phrase')==='getservercert'){
      if(!Buffer.from(q.get('clientcert'),'hex').equals(client))throw Error('Client certificate changed');
      verificationObserved=true;
      secretKey=hash(Buffer.from(q.get('salt'),'hex'),pin).subarray(0,16);
      xml(response,{plaincert:host.cert.toString('hex')});return;
    }
    if(q.has('clientchallenge')){
      challenge=aes(Buffer.from(q.get('clientchallenge'),'hex'),secretKey,true);
      const serverSecret=Buffer.alloc(16,7),serverChallenge=Buffer.alloc(16,9);
      const digest=hash(challenge,signature(host.cert),serverSecret);
      xml(response,{challengeresponse:mode==='short-challenge'?'00':aes(Buffer.concat([digest,serverChallenge]),secretKey).toString('hex')});return;
    }
    if(q.has('serverchallengeresp')){
      clientProof=aes(Buffer.from(q.get('serverchallengeresp'),'hex'),secretKey,true);
      const secret=Buffer.alloc(16,7),signed=crypto.sign('sha256',secret,host.key);
      if(mode==='bad-signature')signed[0]^=1;
      xml(response,{pairingsecret:Buffer.concat([secret,signed]).toString('hex')});return;
    }
    if(q.has('clientpairingsecret')){
      const proof=Buffer.from(q.get('clientpairingsecret'),'hex'),secret=proof.subarray(0,16);
      if(!crypto.verify('sha256',secret,client,proof.subarray(16))||!hash(Buffer.alloc(16,9),signature(client),secret).equals(clientProof))throw Error('Client proof invalid');
      proofFinished=true;xml(response,{});return;
    }
    if(q.get('phrase')==='pairchallenge'&&secure&&proofFinished){xml(response,{});return;}
  }
  response.writeHead(404);response.end();
}
const servers=[];
async function main(){
  let base;
  for(base=34000;base<35000;base+=13){
    try{
      for(const offset of [0,-5,3]){
        const server=offset===0?http.createServer(handler):https.createServer({...host,requestCert:true,rejectUnauthorized:false},handler);
        servers.push(server);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(base+offset,'127.0.0.1',resolve);});
      }
      break;
    }catch(error){for(const server of servers)server.close();servers.length=0;if(error.code!=='EADDRINUSE')throw error;}
  }
  if(servers.length!==3)throw Error('Fixture ports unavailable');
  console.log(JSON.stringify({port:base}));
  process.stdin.once('data',()=>{
    fs.writeFileSync(path.join(directory,'peer-'+mode+'.json'),JSON.stringify({deleted,proofFinished,verificationObserved}));
    for(const server of servers){server.closeAllConnections();server.close();}
  });
}
main().catch(error=>{console.error(error.message);process.exit(1);});
