'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomicWrite}=require('./paired-store.cjs');
const {fault}=require('./paired-transport.cjs');
const protocol=require('./wake-protocol.cjs');
const lifetime=30*86400000;
const hex=(value,length)=>typeof value==='string'&&new RegExp('^[0-9a-f]{'+length+'}$').test(value);
function binding(host){
  try{
    if(!host||!hex(host.id,64)||!hex(host.clientId,32)||(host.networkId!==undefined&&!hex(host.networkId,32)))throw Error();
    if(crypto.createHash('sha256').update(new crypto.X509Certificate(host.certificate).raw).digest('hex')!==host.id)throw Error();
    return {id:host.id,clientId:host.clientId,networkId:host.networkId||''};
  }catch{throw fault('WAKE_PAIRING_CHANGED');}
}
function validateBinding(value){
  return value&&Object.keys(value).sort().join(',')==='clientId,id,networkId'&&hex(value.id,64)&&hex(value.clientId,32)&&(value.networkId===''||hex(value.networkId,32));
}
function validate(value){
  try{
    if(!value||Object.keys(value).sort().join(',')!=='adapter,capturedAt,helper,mac,network,target'||!validateBinding(value.target)||!validateBinding(value.helper)||value.target.id===value.helper.id||
      typeof value.adapter!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.adapter)||!Number.isSafeInteger(value.capturedAt)||value.capturedAt<=0||protocol.mac(value.mac)!==value.mac||protocol.network(value.network)!==value.network)throw Error();
    return value;
  }catch{throw fault('WAKE_INVALID_STORAGE');}
}
function same(value,host){try{const current=binding(host);return ['id','clientId','networkId'].every(key=>value[key]===current[key]);}catch{return false;}}
class WakeStore{
  constructor(directory,{write=atomicWrite,now=Date.now}={}){
    Object.assign(this,{directory,write,now});this.file=path.join(directory,'wake.json');this.records=[];
    if(fs.existsSync(this.file)){
      const info=fs.lstatSync(this.file);
      if(!info.isFile()||info.isSymbolicLink()||info.size>65536||(process.platform!=='win32'&&(info.mode&0o077)))throw fault('WAKE_INVALID_STORAGE');
      try{
        const value=JSON.parse(fs.readFileSync(this.file,'utf8'));
        if(!value||Object.keys(value).sort().join(',')!=='records,version'||value.version!==1||!Array.isArray(value.records)||value.records.length>16)throw Error();
        const ids=new Set();for(const record of value.records){validate(record);if(ids.has(record.target.id))throw Error();ids.add(record.target.id);}
        this.records=value.records;
      }catch{throw fault('WAKE_INVALID_STORAGE');}
    }
  }
  commit(records){this.write(this.directory,this.file,{version:1,records});this.records=records;}
  reconcile(hosts){
    const records=this.records.filter(record=>hosts.some(host=>same(record.target,host))&&hosts.some(host=>same(record.helper,host)));
    if(records.length!==this.records.length)this.commit(records);
  }
  invalidate(host){
    const records=this.records.filter(record=>!same(record.target,host)&&!same(record.helper,host));
    if(records.length!==this.records.length)this.commit(records);
  }
  get(target,hosts){
    const value=this.records.find(record=>same(record.target,target));if(!value||!hosts.some(host=>same(value.helper,host))||this.now()<value.capturedAt||this.now()-value.capturedAt>lifetime)return null;
    return structuredClone(value);
  }
  save(target,helper,adapter,network){
    if(!adapter?.connected||!Array.isArray(adapter.networks)||!adapter.networks.includes(network))throw fault('WAKE_BAD_REQUEST');
    const value=validate({target:binding(target),helper:binding(helper),adapter:adapter.id,mac:protocol.mac(adapter.mac),network:protocol.network(network),capturedAt:this.now()});
    const records=this.records.filter(record=>record.target.id!==value.target.id&&this.now()>=record.capturedAt&&this.now()-record.capturedAt<=lifetime);
    if(records.length>=16)throw fault('WAKE_STORAGE_FULL');this.commit([...records,value]);return structuredClone(value);
  }
  remove(targetId){this.commit(this.records.filter(record=>record.target.id!==targetId));}
}
module.exports={WakeStore,binding,validate,lifetime};
