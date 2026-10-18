'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createClientIdentity}=require('../electron/mac/client-identity.cjs');
const {fixture}=require('./mac-pairing-fixture.cjs');
const {pairHost}=require('../electron/mac/pairing.cjs');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
test('generated desktop identity has a matching RSA key, self-signature and client purpose',async()=>{
  const identity=await createClientIdentity(),certificate=new crypto.X509Certificate(identity.cert),key=crypto.createPrivateKey(identity.key);
  assert.ok(certificate.checkPrivateKey(key));assert.ok(certificate.verify(certificate.publicKey));assert.equal(certificate.ca,false);
  assert.deepEqual(certificate.keyUsage,['1.3.6.1.5.5.7.3.2']);assert.equal(key.asymmetricKeyDetails.modulusLength,2048);
  assert.ok(Date.parse(certificate.validFrom)<Date.now());assert.ok(Date.parse(certificate.validTo)>Date.now()+31536000000);
  const another=await createClientIdentity();assert.notEqual(identity.key,another.key);assert.notEqual(certificate.serialNumber,new crypto.X509Certificate(another.cert).serialNumber);
});
test('generated identity completes the real TLS and signed-secret pairing exchange',async()=>{
  const identity=await createClientIdentity();
  const parsed=JSON.parse(execFileSync('go',['run',path.join(__dirname,'mac-pairing-fixture/main.go'),'--inspect-cert'],{input:identity.cert,encoding:'utf8',timeout:60000,windowsHide:true}));
  const f=await fixture({clientIdentity:{...identity,...parsed}});f.approve();
  try{const host=await pairHost({address:'127.0.0.1',name:'Windows Test',identity,ports:f.ports});assert.equal(f.authorized,true);assert.equal(host.certificate,f.host.cert);assert.deepEqual(f.trace,['get-cert','challenge','server-proof','client-proof','secure-challenge']);}
  finally{await f.close();}
});
