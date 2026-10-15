'use strict';
const crypto=require('node:crypto');
const {promisify}=require('node:util');
const {validateIdentity}=require('./paired-store.cjs');

// Encode a small, fixed X.509 client certificate. All key generation, RSA
// signing, certificate parsing and key matching use the platform's OpenSSL
// through node:crypto. No private key is written to a temporary file.
function der(tag,...parts){
  const value=Buffer.concat(parts),length=[];let n=value.length;
  if(n<128)length.push(n);else{while(n){length.unshift(n&255);n>>>=8;}length.unshift(0x80|length.length);}
  return Buffer.concat([Buffer.from([tag,...length]),value]);
}
const hex=value=>Buffer.from(value,'hex');
const seq=(...parts)=>der(0x30,...parts);
function date(value){const utc=value.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z').replace('T','');return der(value.getUTCFullYear()<2050?0x17:0x18,Buffer.from(value.getUTCFullYear()<2050?utc.slice(2):utc));}
function pem(label,bytes){return `-----BEGIN ${label}-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;}
async function createClientIdentity(){
  const {publicKey,privateKey}=await promisify(crypto.generateKeyPair)('rsa',{modulusLength:2048,publicExponent:65537});
  const serial=crypto.randomBytes(20);serial[0]&=0x7f;serial[0]|=1;
  const algorithm=seq(hex('06092a864886f70d01010b'),hex('0500'));
  const name=seq(der(0x31,seq(hex('0603550403'),der(0x0c,Buffer.from('ClipRelay Desktop')))));
  const start=new Date(Date.now()-300000),end=new Date();end.setUTCFullYear(end.getUTCFullYear()+10);
  const extensions=der(0xa3,seq(
    seq(hex('0603551d13'),hex('0101ff'),der(4,seq())),
    seq(hex('0603551d0f'),hex('0101ff'),der(4,hex('030205a0'))),
    seq(hex('0603551d25'),der(4,seq(hex('06082b06010505070302'))))
  ));
  const tbs=seq(der(0xa0,der(2,hex('02'))),der(2,serial),algorithm,name,seq(date(start),date(end)),name,publicKey.export({type:'spki',format:'der'}),extensions);
  const cert=pem('CERTIFICATE',seq(tbs,algorithm,der(3,Buffer.from([0]),crypto.sign('sha256',tbs,privateKey))));
  const identity=validateIdentity({cert,key:privateKey.export({type:'pkcs8',format:'pem'})});
  if(!new crypto.X509Certificate(cert).verify(publicKey))throw new Error('Certificate self-signature failed');
  return identity;
}
module.exports={createClientIdentity};
