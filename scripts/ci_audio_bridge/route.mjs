// Resolve only the generated disposable endpoint. This does not modify runner
// DNS settings. Both the public HTTPS name and the inner peer remain verified.
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
const hostnamePattern=/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\.trycloudflare\.com$/;
export function addresses(host,value){
  assert.match(host,hostnamePattern);assert.equal(value.Status,0);assert.equal(value.TC,false);assert.equal(value.CD,false);
  assert.ok(Array.isArray(value.Question)&&value.Question.length===1);assert.equal(value.Question[0].type,1);
  assert.equal(value.Question[0].name.replace(/\.$/,''),host);assert.ok(Array.isArray(value.Answer)&&value.Answer.length<=8);
  const found=[];
  for(const answer of value.Answer){
    assert.equal(answer.name.replace(/\.$/,''),host);assert.equal(answer.type,1);assert.ok(Number.isInteger(answer.TTL)&&answer.TTL>=0);
    const ip=answer.data;assert.equal(net.isIP(ip),4);const [a,b]=ip.split('.').map(Number);
    assert.ok(a>0&&a<224&&a!==10&&a!==127&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&!(a===100&&b>=64&&b<=127));
    if(!found.includes(ip))found.push(ip);
  }
  assert.ok(found.length);return found;
}
export function resolveRoute(host){
  assert.match(host,hostnamePattern);
  return new Promise((resolve,reject)=>{
    const req=https.get({host:'cloudflare-dns.com',path:'/dns-query?name='+host+'&type=A',headers:{Accept:'application/dns-json'},
      agent:false,timeout:3000,maxHeaderSize:8192},res=>{
      if(res.statusCode!==200){res.resume();reject(Error('ROUTE_DNS_HTTP'));return}
      let bytes=0,chunks=[];
      res.on('error',reject);res.on('data',data=>{bytes+=data.length;if(bytes>16384){req.destroy(Error('ROUTE_DNS_LIMIT'));return}chunks.push(data)});
      res.on('end',()=>{try{resolve(addresses(host,JSON.parse(Buffer.concat(chunks).toString('utf8'))))}catch{reject(Error('ROUTE_DNS_INVALID'))}});
    });req.on('timeout',()=>req.destroy(Error('ROUTE_DNS_TIMEOUT')));req.on('error',reject);
  });
}
export function probeRoute(url,ips){
  const endpoint=new URL(url);assert.equal(endpoint.protocol,'https:');assert.match(endpoint.hostname,hostnamePattern);
  assert.ok(ips.length>0&&ips.every(ip=>net.isIP(ip)===4));
  return new Promise((resolve,reject)=>{
    const req=https.get(endpoint,{agent:false,timeout:3000,maxHeaderSize:8192,
      lookup:(host,options,done)=>{
        if(host!==endpoint.hostname){done(Error('ROUTE_HOST_CHANGED'));return}
        if(options.all)done(null,ips.map(address=>({address,family:4})));else done(null,ips[0],4);
      }},res=>{const value={status:res.statusCode,marker:res.headers['x-cliprelay-fixture']==='audio-bridge-v1'};res.resume();resolve(value)});
    req.on('timeout',()=>req.destroy(Error('ROUTE_PROBE_TIMEOUT')));req.on('error',reject);
  });
}
