'use strict';
const net=require('node:net');
const {jsonRequest,endpoint,fault}=require('./paired-transport.cjs');
const errors=new Set(['WAKE_BUSY','WAKE_UNAVAILABLE','WAKE_ID_CONFLICT','WAKE_RATE_LIMITED','WAKE_NOT_ON_LAN','WAKE_SEND_FAILED']);
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const guid=v=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
function requireValue(value){if(!value)throw fault('WAKE_INVALID_RESPONSE');}
function ipv4(value){
  requireValue(typeof value==='string'&&net.isIP(value)===4);
  return value.split('.').reduce((ip,part)=>(ip*256+Number(part))>>>0,0);
}
const format=value=>[24,16,8,0].map(shift=>(value>>>shift)&255).join('.');
const mask=prefix=>(0xffffffff<<(32-prefix))>>>0;
function network(value){
  requireValue(typeof value==='string'&&/^[0-9.]+\/[1-9][0-9]?$/.test(value));
  const [address,bits]=value.split('/'),prefix=Number(bits),ip=ipv4(address);
  requireValue(integer(prefix,1,30)&&((ip&mask(prefix))>>>0)===ip);
  return value;
}
function mac(value){
  requireValue(typeof value==='string'&&/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(value));
  const bytes=value.split(':').map(v=>parseInt(v,16));
  requireValue(!(bytes[0]&1)&&bytes.some(v=>v!==0));return value.toUpperCase();
}
function configuration(power,magic,armed){
  if(power!=='enabled')return power==='disabled'?'disabled':'unknown';
  if(magic==='unsupported')return 'unsupported';
  if(magic==='disabled'||armed==='disabled')return 'disabled';
  return magic==='enabled'&&armed==='enabled'?'configured':'unknown';
}
function error(value){if(value?.ok===false&&errors.has(value.code))throw fault(value.code);}
function inventory(value){
  error(value);requireValue(value?.ok===true&&value.supported===true&&value.platform==='windows'&&value.wakeVerified===false&&Array.isArray(value.adapters)&&value.adapters.length<=32);
  const ids=new Set(),settings=new Set(['enabled','disabled','unsupported','unknown']);
  const adapters=value.adapters.map(a=>{
    requireValue(a&&guid(a.id)&&!ids.has(a.id.toLowerCase())&&typeof a.name==='string'&&Buffer.byteLength(a.name,'utf8')<=512&&!/[\0\r\n]/.test(a.name)&&['ethernet','wifi'].includes(a.kind)&&typeof a.connected==='boolean');
    ids.add(a.id.toLowerCase());const address=mac(a.mac);
    requireValue(settings.has(a.powerManagement)&&settings.has(a.magicPacket)&&['enabled','disabled','unknown'].includes(a.wakeArmed)&&a.configuration===configuration(a.powerManagement,a.magicPacket,a.wakeArmed));
    requireValue(Array.isArray(a.addresses)&&a.addresses.length<=8);
    const networks=new Set();
    for(const item of a.addresses){
      requireValue(item&&integer(item.prefix,1,32));const ip=ipv4(item.address),first=ip>>>24;
      requireValue(first!==0&&first!==127&&first<224);
      if(item.prefix<=30){const bits=mask(item.prefix),base=(ip&bits)>>>0,broadcast=(base|~bits)>>>0;
        if(ip!==base&&ip!==broadcast)networks.add(format(base)+'/'+item.prefix);
      }
    }
    return {id:a.id,name:a.name,mac:address,kind:a.kind,connected:a.connected,configuration:a.configuration,networks:[...networks]};
  });
  return {adapters};
}
function sent(value){error(value);requireValue(value?.ok===true&&value.state==='sent'&&value.wakeVerified===false&&integer(value.sent,1,24));return {sent:value.sent};}
function body(op,binding){
  if(op==='status'&&binding==null)return {op};
  if(op!=='send'||!binding||typeof binding.id!=='string'||!/^[0-9a-f]{32}$/.test(binding.id))throw fault('WAKE_BAD_REQUEST');
  try{return {op,id:binding.id,mac:mac(binding.mac),network:network(binding.network)};}catch{throw fault('WAKE_BAD_REQUEST');}
}
async function request(host,identity,op,binding,signal){
  const target=endpoint(host.address,host.port),value=await jsonRequest({...target,port:target.port+2,path:'/v1/wake',method:'POST',body:body(op,binding),identity,trust:{cert:host.certificate},signal,timeout:5000,limit:65536,acceptStatuses:[200,409,429,503]});
  return op==='status'?inventory(value):sent(value);
}
module.exports={inventory,sent,body,request,network,mac,configuration};
