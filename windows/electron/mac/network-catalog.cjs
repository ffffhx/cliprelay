'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomicWrite}=require('./paired-store.cjs');
const {credentialId}=require('./network-broker.cjs');
const {fault}=require('./paired-transport.cjs');

class NetworkCatalog{
  constructor(directory,safeStorage,{write=atomicWrite}={}){
    Object.assign(this,{directory,safeStorage,write});this.file=path.join(directory,'catalog.json');this.data={version:1,records:[]};
    if(fs.existsSync(this.file)){
      const stat=fs.lstatSync(this.file);
      if(!stat.isFile() || stat.isSymbolicLink() || stat.size>256*1024 || (process.platform!=='win32' && stat.mode&0o077))throw fault('INVALID_PRIVATE_STORAGE');
      const data=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(data.version!==1 || !Array.isArray(data.records) || data.records.length>16)throw fault('INVALID_PRIVATE_STORAGE');
      const ids=new Set(),peers=new Set();
      for(const r of data.records){
        if(!r || !/^[a-f0-9]{32}$/.test(r.id) || !/^[a-f0-9]{24}$/.test(r.deviceId) || !/^[a-f0-9]{24}$/.test(r.peerId) || ids.has(r.id) || peers.has(r.peerId) ||
            typeof r.name!=='string' || !r.name || Buffer.byteLength(r.name)>128 || /[\r\n\0]/.test(r.name) || typeof r.enabled!=='boolean' ||
            typeof r.encrypted!=='string' || r.encrypted.length>16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.encrypted))throw fault('INVALID_PRIVATE_STORAGE');
        ids.add(r.id);peers.add(r.peerId);
      }
      this.data=data;
    }
  }
  secure(){if(!this.safeStorage?.isEncryptionAvailable())throw fault('KEYCHAIN_UNAVAILABLE');}
  records(){return this.data.records.map(({id,deviceId,peerId,name,enabled})=>({id,deviceId,peerId,name,enabled}));}
  get(id){return this.records().find(record=>record.id===id) || null;}
  commit(records){const next={version:1,records};this.write(this.directory,this.file,next);this.data=next;}
  credential(id){
    this.secure();const record=this.data.records.find(record=>record.id===id);if(!record)throw fault('UNKNOWN_NETWORK');
    let value;try{value=this.safeStorage.decryptString(Buffer.from(record.encrypted,'base64'));}catch{throw fault('INVALID_NETWORK_CREDENTIAL');}
    if(credentialId(value)!==record.deviceId)throw fault('INVALID_NETWORK_CREDENTIAL');return value;
  }
  save(credential,peer){
    this.secure();const deviceId=credentialId(credential);
    if(!peer || !/^[a-f0-9]{24}$/.test(peer.id) || typeof peer.name!=='string' || !peer.name || Buffer.byteLength(peer.name)>128 || /[\r\n\0]/.test(peer.name))throw fault('BROKER_BAD_REPLY');
    const old=this.data.records.find(record=>record.peerId===peer.id);
    if(!old && this.data.records.length>=16)throw fault('TOO_MANY_HOSTS');
    const record={id:old?.id || crypto.randomBytes(16).toString('hex'),deviceId,peerId:peer.id,name:peer.name,enabled:true,encrypted:this.safeStorage.encryptString(credential).toString('base64')};
    this.commit([...this.data.records.filter(value=>value.id!==record.id),record]);return this.get(record.id);
  }
  enable(id,enabled){if(!this.get(id) || typeof enabled!=='boolean')throw fault('UNKNOWN_NETWORK');this.commit(this.data.records.map(record=>record.id===id?{...record,enabled}:record));}
  remove(id){if(!this.get(id))throw fault('UNKNOWN_NETWORK');this.commit(this.data.records.filter(record=>record.id!==id));}
}
module.exports={NetworkCatalog};
