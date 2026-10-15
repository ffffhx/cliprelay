'use strict';
const net=require('node:net');
const dns=require('node:dns/promises');

function isLocalAddress(address){
  if(typeof address!=='string')return false;
  const ip=address.split('%')[0],family=net.isIP(ip);
  if(family===4){
    const [a,b]=ip.split('.').map(Number);
    return a===127 || a===10 || (a===172 && b>=16 && b<=31) || (a===192 && b===168) || (a===169 && b===254);
  }
  if(family!==6)return false;
  let value=ip.toLowerCase();
  if(value.includes('.'))value=value.replace(/(\d+\.\d+\.\d+\.\d+)$/,v=>{const b=v.split('.').map(Number);return ((b[0]<<8)|b[1]).toString(16)+':'+((b[2]<<8)|b[3]).toString(16);});
  const halves=value.split('::'),left=halves[0]?halves[0].split(':'):[],right=halves[1]?halves[1].split(':'):[];
  const words=(halves.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left).map(v=>parseInt(v,16));
  if(words.slice(0,5).every(v=>v===0) && words[5]===0xffff)return isLocalAddress([words[6]>>8,words[6]&255,words[7]>>8,words[7]&255].join('.'));
  return (words.slice(0,7).every(v=>v===0) && words[7]===1) || (words[0]&0xfe00)===0xfc00 || (words[0]&0xffc0)===0xfe80;
}
async function resolveLocal(host,lookup=dns.lookup){
  if(typeof host!=='string' || !host || host.length>253)throw new Error('旧版地址无效');
  if(net.isIP(host)){if(isLocalAddress(host))return host;throw new Error('旧版兼容仅允许局域网地址');}
  let timer;
  try{
    const addresses=await Promise.race([lookup(host,{all:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('地址解析超时')),2500);})]);
    const selected=addresses.find(item=>isLocalAddress(item.address));
    if(!selected)throw new Error('旧版兼容仅允许局域网地址');
    return selected.address;
  }finally{clearTimeout(timer);}
}
module.exports={isLocalAddress,resolveLocal};
