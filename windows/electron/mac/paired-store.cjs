'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {endpoint,fault}=require('./paired-transport.cjs');
const {hash}=require('./paired-crypto.cjs');
function privateDirectory(directory){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const stat=fs.lstatSync(directory);if(!stat.isDirectory() || stat.isSymbolicLink())throw fault('INVALID_PRIVATE_STORAGE');
  if(process.platform!=='win32')fs.chmodSync(directory,0o700);
}
function atomicWrite(directory,file,value){
  privateDirectory(directory);
  const temporary=path.join(directory,'.'+crypto.randomUUID()+'.tmp');let fd;
  try{
    fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(temporary,file);
    // Directory fsync is required on the target macOS platform. Windows unit
    // fixtures cannot open a directory this way, and do not claim macOS durability.
    if(process.platform!=='win32'){const dir=fs.openSync(directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
async function createIdentity(directory,run=promisify(execFile)){
  privateDirectory(directory);
  const temporary=fs.mkdtempSync(path.join(directory,'identity-'));
  if(process.platform!=='win32')fs.chmodSync(temporary,0o700);
  const keyFile=path.join(temporary,'client.key'),certFile=path.join(temporary,'client.crt');
  try{
    await run('/usr/bin/openssl',['req','-new','-x509','-sha256','-nodes','-newkey','rsa:2048','-days','3650','-subj','/CN=ClipRelay Mac','-keyout',keyFile,'-out',certFile],{timeout:20000,maxBuffer:16384,windowsHide:true});
    return {key:fs.readFileSync(keyFile,'utf8'),cert:fs.readFileSync(certFile,'utf8')};
  }finally{
    // Only the two known generated files inside this private temporary directory.
    for(const file of [keyFile,certFile]){try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}}
    fs.rmdirSync(temporary);
  }
}
function validateIdentity(identity){
  const certificate=new crypto.X509Certificate(identity.cert),key=crypto.createPrivateKey(identity.key);
  if(!certificate.checkPrivateKey(key) || key.asymmetricKeyType!=='rsa' || key.asymmetricKeyDetails.modulusLength<2048)throw fault('INVALID_CLIENT_IDENTITY');
  return identity;
}
class PairedStore{
  constructor(directory,safeStorage,{generate=createIdentity,write=atomicWrite,now=Date.now,legacySelected=false}={}){
    this.directory=directory;this.file=path.join(directory,'state.json');this.safeStorage=safeStorage;this.generate=generate;this.write=write;this.now=now;
    this.data={version:1,identity:null,hosts:[],selected:null,legacySelected:legacySelected===true,receipts:{}};
    if(fs.existsSync(this.file)){
      const stat=fs.lstatSync(this.file);
      if(!stat.isFile() || stat.isSymbolicLink() || stat.size>4*1024*1024 || (process.platform!=='win32' && (stat.mode&0o077)))throw fault('INVALID_PRIVATE_STORAGE');
      this.data=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(this.data.version!==1 || !Array.isArray(this.data.hosts) || this.data.hosts.length>16 || !this.data.receipts || typeof this.data.receipts!=='object' || Array.isArray(this.data.receipts) || Object.keys(this.data.receipts).length>4096)throw fault('INVALID_PRIVATE_STORAGE');
      if(this.data.legacySelected!==true)this.data.legacySelected=false;
      if(this.data.selected!==null && this.data.legacySelected)throw fault('INVALID_PRIVATE_STORAGE');
      const ids=new Set();
      for(const host of this.data.hosts){this.validateHost(host);if(ids.has(host.id))throw fault('INVALID_PRIVATE_STORAGE');ids.add(host.id);}
      if(this.data.selected!==null && !ids.has(this.data.selected))throw fault('INVALID_PRIVATE_STORAGE');
      for(const [key,item] of Object.entries(this.data.receipts))if(!/^[a-f0-9]{64}:[a-f0-9]{32}$/.test(key) || !item || !/^[a-f0-9]{64}$/.test(item.hash) || !['pending','applied'].includes(item.state) || !Number.isSafeInteger(item.at))throw fault('INVALID_PRIVATE_STORAGE');
    }
  }
  commit(next){this.write(this.directory,this.file,next);this.data=next;}
  validateHost(host){
    if(host?.clipboardSync!==undefined && typeof host.clipboardSync!=='boolean')throw fault('INVALID_HOST');
    if(!host || !/^[a-f0-9]{64}$/.test(host.id) || typeof host.name!=='string' || !host.name || host.name.length>128 || typeof host.enabled!=='boolean' || !/^[a-f0-9]{32}$/.test(host.clientId) || typeof host.certificate!=='string' || host.certificate.length>16384)throw fault('INVALID_HOST');
    if(host.networkId!==undefined){
      if(!/^[a-f0-9]{32}$/.test(host.networkId) || ['address','port','overlay','overlayPort','routeId','routeReady'].some(key=>host[key]!==undefined))throw fault('INVALID_HOST');
      if(host.directAddress!==undefined || host.directPort!==undefined)endpoint(host.directAddress,host.directPort);
    }else endpoint(host.address,host.port);
    if(hash(new crypto.X509Certificate(host.certificate).raw).toString('hex')!==host.id)throw fault('INVALID_HOST');
  }
  async identity(){
    if(this.cachedIdentity)return this.cachedIdentity;
    if(this.creating)return this.creating;
    this.creating=(async()=>{
      if(!this.safeStorage?.isEncryptionAvailable())throw fault('KEYCHAIN_UNAVAILABLE');
      let value;
      if(this.data.identity){
        if(typeof this.data.identity.cert!=='string' || typeof this.data.identity.keyEncrypted!=='string' || this.data.identity.keyEncrypted.length>32768)throw fault('INVALID_CLIENT_IDENTITY');
        value={cert:this.data.identity.cert,key:this.safeStorage.decryptString(Buffer.from(this.data.identity.keyEncrypted,'base64'))};
      }else{
        value=validateIdentity(await this.generate(this.directory));
        const identity={cert:value.cert,keyEncrypted:this.safeStorage.encryptString(value.key).toString('base64')};
        this.commit({...this.data,identity});
      }
      this.cachedIdentity=validateIdentity(value);return this.cachedIdentity;
    })();
    try{return await this.creating;}finally{this.creating=null;}
  }
  hosts(){return this.data.hosts.map(host=>({...host}));}
  selected(){return this.hosts().find(host=>host.id===this.data.selected) || null;}
  add(host){
    this.validateHost(host);const hosts=this.hosts();const index=hosts.findIndex(item=>item.id===host.id);
    if(index<0){if(hosts.length>=16)throw fault('TOO_MANY_HOSTS');hosts.push({...host});}else hosts[index]={...host};
    this.commit({...this.data,hosts,selected:host.id,legacySelected:false});
  }
  select(id){if(id!==null && !this.data.hosts.some(host=>host.id===id))throw fault('UNKNOWN_HOST');this.commit({...this.data,selected:id,legacySelected:false});}
  selectLegacy(){this.commit({...this.data,selected:null,legacySelected:true});}
  enable(id,value){if(typeof value!=='boolean' || !this.data.hosts.some(host=>host.id===id))throw fault('UNKNOWN_HOST');this.commit({...this.data,hosts:this.hosts().map(host=>host.id===id?{...host,enabled:value}:host)});}
  setClipboardSync(id,value){if(typeof value!=='boolean' || !this.data.hosts.some(host=>host.id===id))throw fault('UNKNOWN_HOST');this.commit({...this.data,hosts:this.hosts().map(host=>host.id===id?{...host,clipboardSync:value}:host)});}
  remove(id){
    this.commit({...this.data,selected:this.data.selected===id?null:this.data.selected,hosts:this.hosts().filter(host=>host.id!==id),receipts:Object.fromEntries(Object.entries(this.data.receipts).filter(([key])=>!key.startsWith(id+':')))});
  }
  receipts(host){
    const keyFor=id=>{if(!/^[a-f0-9]{32}$/.test(id) || !this.data.hosts.some(item=>item.id===host))throw fault('UNKNOWN_HOST');return host+':'+id;};
    return {
      state:(id,digest)=>{const item=this.data.receipts[keyFor(id)];if(!item)return '';if(item.hash!==digest)throw fault('RELAY_ID_CONFLICT');return item.state;},
      save:(id,digest,state)=>{
        const key=keyFor(id);if(!/^[a-f0-9]{64}$/.test(digest) || !['pending','applied'].includes(state))throw fault('BAD_RECEIPT');
        const previous=this.data.receipts[key];if(previous && (previous.hash!==digest || (previous.state==='applied' && state!=='applied')))throw fault('RELAY_ID_CONFLICT');
        const now=this.now(),receipts=Object.fromEntries(Object.entries(this.data.receipts).filter(([_,item])=>now-item.at<3600000));
        if(!receipts[key] && Object.keys(receipts).length>=4096)throw fault('RECEIPT_STORE_FULL');
        receipts[key]={hash:digest,state,at:now};this.commit({...this.data,receipts});
      }
    };
  }
}
module.exports={PairedStore,createIdentity,atomicWrite,validateIdentity};
