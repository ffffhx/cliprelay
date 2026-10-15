'use strict';
// Main-process storage integration only: no browser window, network, clipboard
// access or production app startup. The parent supplies a private fixture path.
const {app,safeStorage}=require('electron');
const path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
const {PairedStore}=require('../electron/mac/paired-store.cjs');
const {createClientIdentity}=require('../electron/mac/client-identity.cjs');
const {NetworkCatalog}=require('../electron/mac/network-catalog.cjs');
const directory=process.env.CLIPRELAY_IDENTITY_FIXTURE;
if(!directory || !path.isAbsolute(directory) || !path.basename(directory).startsWith('cliprelay-identity-'))throw new Error('Expected isolated identity fixture');
app.setPath('userData',directory);
app.whenReady().then(async()=>{
  if(!safeStorage.isEncryptionAvailable())throw new Error('safeStorage encryption unavailable');
  const location=path.join(directory,'paired'),first=new PairedStore(location,safeStorage,{generate:createClientIdentity});
  const identity=await first.identity(),certificate=new crypto.X509Certificate(identity.cert),id=crypto.createHash('sha256').update(certificate.raw).digest('hex');
  first.add({id,name:'Synthetic host',enabled:true,address:'127.0.0.1',port:48789,clientId:'c'.repeat(32),certificate:identity.cert});
  const persisted=fs.readFileSync(path.join(location,'state.json'),'utf8');
  if(persisted.includes('PRIVATE KEY') || persisted.includes(identity.key))throw new Error('Plaintext private key persisted');
  const second=new PairedStore(location,safeStorage,{generate:()=>{throw new Error('Identity was regenerated');}}),recovered=await second.identity();
  if(recovered.key!==identity.key || recovered.cert!==identity.cert || second.selected()?.id!==id)throw new Error('Stored identity or pairing changed');
  const credential=crypto.randomBytes(32).toString('base64url'),catalog=new NetworkCatalog(path.join(directory,'network'),safeStorage);
  const record=catalog.save(credential,{id:'1'.repeat(24),name:'Synthetic network host'});
  if(fs.readFileSync(catalog.file,'utf8').includes(credential))throw new Error('Plaintext network credential persisted');
  if(new NetworkCatalog(catalog.directory,safeStorage).credential(record.id)!==credential)throw new Error('Network credential changed');
  const report={passed:true,platform:process.platform,electron:process.versions.electron,encryptedStorage:true,identityReloaded:true,pairingReloaded:true,networkCredentialEncrypted:true,networkCredentialReloaded:true};
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(report));
  app.exit(0);
}).catch(error=>{fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({passed:false,error:error.message}));app.exit(1);});
