'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const EXECUTABLE='runtime/cliprelay-host-network';
const FILES=['LICENSE','NETWORK-LICENSES.txt','cliprelay-host-source.tar.gz',EXECUTABLE];
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const keys=(value,names)=>value && typeof value==='object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort())===JSON.stringify([...names].sort());
function reject(){throw new Error('Invalid Mac host companion artifact');}
function read(file,limit){
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.size>limit)reject();
  const data=fs.readFileSync(file);if(data.length>limit)reject();return data;
}
// Inspect both executable slices. A manifest label alone does not establish
// architecture, file type or compatibility with the application's minimum OS.
function nativeInfo(data){
  if(data.length<48 || data.readUInt32BE(0)!==0xcafebabe || data.readUInt32BE(4)!==2)reject();
  const result={},ranges=[];
  for(let index=0;index<2;index++){
    const start=8+20*index,cpu=data.readUInt32BE(start),offset=data.readUInt32BE(start+8),size=data.readUInt32BE(start+12),align=data.readUInt32BE(start+16);
    const arch=cpu===0x0100000c?'arm64':cpu===0x01000007?'x86_64':null;
    if(!arch || Object.hasOwn(result,arch) || offset<48 || size<32 || offset+size>data.length || align>30 || offset%(2**align)!==0 ||
        ranges.some(([from,to])=>offset<to && offset+size>from))reject();
    ranges.push([offset,offset+size]);const image=data.subarray(offset,offset+size);
    if(image.readUInt32LE(0)!==0xfeedfacf || image.readUInt32LE(4)!==cpu || image.readUInt32LE(12)!==2)reject();
    const count=image.readUInt32LE(16),end=32+image.readUInt32LE(20);
    if(count>65536 || end>image.length)reject();
    let cursor=32,minimum=null;
    for(let commandIndex=0;commandIndex<count;commandIndex++){
      if(cursor+8>end)reject();const command=image.readUInt32LE(cursor),length=image.readUInt32LE(cursor+4);
      if(length<8 || cursor+length>end)reject();
      if(command===0x32 || command===0x24){
        if(minimum!==null || length<(command===0x32?24:16) || (command===0x32 && image.readUInt32LE(cursor+8)!==1))reject();
        minimum=image.readUInt32LE(cursor+(command===0x32?12:8));
        if(minimum===0 || minimum>0x000e0200)reject();
      }
      cursor+=length;
    }
    if(cursor!==end || minimum===null)reject();
    result[arch]=[minimum>>>16,(minimum>>>8)&255,minimum&255].join('.');
  }
  return result;
}
function verify(directory,pin){
  if(!keys(pin,['commit','manifestSha256']) || !/^[a-f0-9]{40}$/.test(pin.commit) || !/^[a-f0-9]{64}$/.test(pin.manifestSha256))reject();
  const root=path.resolve(directory),info=fs.lstatSync(root);
  if(!info.isDirectory() || info.isSymbolicLink())reject();
  const raw=read(path.join(root,'manifest.json'),16384);
  if(hash(raw)!==pin.manifestSha256)reject();
  const manifest=JSON.parse(raw);
  const fields=['role','platform','protocol','nativeWorkers','pairingControl','files'];
  if(Object.hasOwn(manifest,'fileTransfer')){fields.push('fileTransfer');if(manifest.fileTransfer!==1)reject();}
  if(Object.hasOwn(manifest,'clipboardExchange')){fields.push('clipboardExchange');if(manifest.clipboardExchange!==1)reject();}
  if(Object.hasOwn(manifest,'wakeControl')){fields.push('wakeControl');if(manifest.wakeControl!==1)reject();}
  // Private worker availability is separate from a paired privacy capability.
  if(Object.hasOwn(manifest,'privacyWorker')){fields.push('privacyWorker');if(manifest.privacyWorker!==1)reject();}
  if(Object.hasOwn(manifest,'terminalControl')){fields.push('terminalControl');if(manifest.terminalControl!==1)reject();}
  if(!keys(manifest,fields) || manifest.role!=='host-companion' ||
      manifest.platform!=='macos' || manifest.protocol!==1 || manifest.nativeWorkers!==false || manifest.pairingControl!==1 || !keys(manifest.files,FILES))reject();
  const expected=new Set([...FILES,'manifest.json']);
  // CI adds this unpinned receipt after building the manifest. It is verified
  // against the selected run by the fetcher and never copied into the app.
  const optional=new Set(['process-report.json','terminal-process-report.json','privacy-process-report.json']);
  function visit(current,relative=''){
    for(const entry of fs.readdirSync(current,{withFileTypes:true})){
      const name=relative+entry.name,file=path.join(current,entry.name);
      if(entry.isSymbolicLink())reject();
      if(entry.isDirectory()){
        if(name!=='runtime')reject();visit(file,name+'/');
      }else if(entry.isFile()){
        if(optional.has(name))read(file,16384);
        else if(!expected.delete(name))reject();
      }else reject();
    }
  }
  visit(root);if(expected.size)reject();
  let nativeMinimumOS;
  for(const name of FILES){
    const data=read(path.join(root,name),name===EXECUTABLE?64*1024*1024:4*1024*1024);
    if(!/^[a-f0-9]{64}$/.test(manifest.files[name]) || hash(data)!==manifest.files[name])reject();
    if(name===EXECUTABLE){nativeMinimumOS=nativeInfo(data);if(process.platform==='darwin')fs.accessSync(path.join(root,name),fs.constants.X_OK);}
  }
  return {manifest,nativeMinimumOS};
}
function stage(source,destination,pin){
  const result=verify(source,pin);fs.mkdirSync(destination);
  for(const name of [...FILES,'manifest.json']){
    const target=path.join(destination,name);fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.copyFileSync(path.join(source,name),target,fs.constants.COPYFILE_EXCL);
  }
  if(process.platform==='darwin')fs.chmodSync(path.join(destination,EXECUTABLE),0o755);
  verify(destination,pin);return result;
}
module.exports={verify,stage,nativeInfo,EXECUTABLE,FILES};
