'use strict';
const crypto=require('node:crypto');
const {fault}=require('./paired-transport.cjs');
const hash=(...parts)=>crypto.createHash('sha256').update(Buffer.concat(parts.map(p=>Buffer.isBuffer(p)?p:Buffer.from(p)))).digest();
function fromHex(value,min,max=min){if(typeof value!=='string' || !/^(?:[0-9a-f]{2})+$/i.test(value) || value.length<min*2 || value.length>max*2)throw fault('BAD_PAIRING_REPLY');return Buffer.from(value,'hex');}
function signature(cert){
  const der=(cert instanceof crypto.X509Certificate?cert:new crypto.X509Certificate(cert)).raw;
  function field(offset){
    if(offset+2>der.length)throw fault('BAD_CERTIFICATE');
    const tag=der[offset++];let length=der[offset++];
    if(length&128){const n=length&127;if(!n || n>3 || offset+n>der.length)throw fault('BAD_CERTIFICATE');length=0;for(let i=0;i<n;i++)length=length*256+der[offset++];}
    if(length<0 || offset+length>der.length)throw fault('BAD_CERTIFICATE');
    return {tag,start:offset,end:offset+length};
  }
  const outer=field(0);if(outer.tag!==48 || outer.end!==der.length)throw fault('BAD_CERTIFICATE');
  const tbs=field(outer.start),algorithm=field(tbs.end),bits=field(algorithm.end);
  if(tbs.tag!==48 || algorithm.tag!==48 || bits.tag!==3 || bits.end!==outer.end || der[bits.start]!==0)throw fault('BAD_CERTIFICATE');
  return der.subarray(bits.start+1,bits.end);
}
function aes(data,key,decrypt=false){
  if(data.length%16)throw fault('BAD_PAIRING_REPLY');
  const cipher=(decrypt?crypto.createDecipheriv:crypto.createCipheriv)('aes-128-ecb',key,null);cipher.setAutoPadding(false);return Buffer.concat([cipher.update(data),cipher.final()]);
}
function xmlValue(xml,name){
  if(typeof xml!=='string' || /<!/.test(xml) || !/<root\b[^>]*\bstatus_code="200"[^>]*>/.test(xml))throw fault('PAIRING_FAILED');
  const values=[...xml.matchAll(new RegExp('<'+name+'>([^<]*)</'+name+'>','g'))];
  if(values.length!==1)throw fault('BAD_PAIRING_REPLY');return values[0][1];
}
module.exports={hash,fromHex,signature,aes,xmlValue};
