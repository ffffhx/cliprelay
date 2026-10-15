'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {atomicWrite}=require('./paired-store.cjs');
const {CHUNK,LIMIT,id,hash,integer,safeName,location,requireValue}=require('./file-protocol.cjs');
const {fault}=require('./paired-transport.cjs');
const terminal=new Set(['complete','cancelled']);
const states=new Set(['queued','hashing','uploading','preparing','downloading','verifying','publishing','paused','cancelling','cancel-pending','complete','cancelled']);
// libuv on Windows returns dev=0 for path stats but a volume number for
// descriptor stats. Canonical absolute paths bind the volume there; compare
// its stable 64-bit file index. Unix additionally compares the device number.
const device=stat=>process.platform==='win32'?'0':String(stat.dev);
const identity=stat=>({dev:device(stat),ino:String(stat.ino)});
const same=(a,b)=>!!a && !!b && a.dev===device(b) && a.ino===String(b.ino);
const validIdentity=value=>value && /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino);
const absolute=value=>typeof value==='string' && value.length<=32768 && !value.includes('\0') && path.isAbsolute(value);
function check(signal){if(signal?.aborted)throw fault('CANCELLED');}
async function digest(handle,size,signal,onProgress=()=>{}){
  const result=crypto.createHash('sha256'),buffer=Buffer.alloc(CHUNK);let offset=0;
  while(offset<size){check(signal);const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,size-offset),offset);if(!bytesRead)throw fault('FILES_SOURCE_CHANGED');result.update(buffer.subarray(0,bytesRead));offset+=bytesRead;onProgress(offset);}
  check(signal);return result.digest('hex');
}
async function source(file){
  // Only native picker results reach this function. Resolve parent aliases, but
  // reject a selected symlink itself and bind every later read to this inode.
  const original=await fsp.lstat(file,{bigint:true});requireValue(original.isFile() && !original.isSymbolicLink(),'FILES_LINK_NOT_ALLOWED');
  const name=safeName(path.basename(file)),canonical=await fsp.realpath(file),stat=await fsp.lstat(canonical,{bigint:true});
  requireValue(stat.isFile() && same(identity(original),stat),'FILES_SOURCE_CHANGED');
  const size=Number(stat.size);requireValue(integer(size),'FILES_TOO_LARGE');
  return {name,size,source:{file:canonical,...identity(stat),mtime:String(stat.mtimeNs)}};
}
async function destination(directory){
  const canonical=await fsp.realpath(directory),stat=await fsp.lstat(canonical,{bigint:true});requireValue(stat.isDirectory() && !stat.isSymbolicLink(),'FILES_BAD_PATH');
  return {directory:canonical,...identity(stat)};
}
async function directoryFor(task){
  const target=task.destination,stat=await fsp.lstat(target.directory,{bigint:true});
  requireValue(stat.isDirectory() && !stat.isSymbolicLink() && same(target,stat) && await fsp.realpath(target.directory)===target.directory,'FILES_DESTINATION_CHANGED');
  return target.directory;
}
async function openSource(task){
  const data=task.source,handle=await fsp.open(data.file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try{await verifySource(task,handle);return handle;}catch(error){await handle.close();throw error;}
}
async function verifySource(task,handle){
  const stat=await handle.stat({bigint:true});requireValue(stat.isFile() && same(task.source,stat) && String(stat.mtimeNs)===task.source.mtime && Number(stat.size)===task.size,'FILES_SOURCE_CHANGED');
}
const partPath=task=>path.join(task.destination.directory,'.cliprelay-'+task.id+'.part');
async function openPart(task,save){
  const directory=await directoryFor(task),file=partPath(task);let handle;
  try{
    if(task.part){
      const stat=await fsp.lstat(file,{bigint:true});requireValue(stat.isFile() && !stat.isSymbolicLink() && same(task.part,stat),'FILES_DESTINATION_CHANGED');
      handle=await fsp.open(file,fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const opened=await handle.stat({bigint:true});requireValue(opened.isFile() && same(task.part,opened) && Number(opened.size)>=task.offset,'FILES_DESTINATION_CHANGED');
    }else{
      handle=await fsp.open(file,'wx+',0o600);task.part=identity(await handle.stat({bigint:true}));save();
    }
    await directoryFor(task);
    const space=await fsp.statfs(directory,{bigint:true});requireValue(space.bavail*space.bsize>=BigInt(task.size-task.offset)+32n*1024n*1024n,'FILES_DISK_FULL');
    await handle.truncate(task.offset);await handle.sync();return handle;
  }catch(error){await handle?.close();throw error;}
}
async function cleanupPart(task){
  if(!task.part || !task.destination)return;
  await directoryFor(task);const file=partPath(task);let stat;
  try{stat=await fsp.lstat(file,{bigint:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
  requireValue(stat.isFile() && !stat.isSymbolicLink() && same(task.part,stat),'FILES_DESTINATION_CHANGED');await fsp.unlink(file);
}
async function syncDirectory(directory){if(process.platform==='win32')return;const handle=await fsp.open(directory,'r');try{await handle.sync();}finally{await handle.close();}}
async function published(task,signal){
  if(!task.finalName || !task.part || task.direction!=='download')return false;
  const directory=await directoryFor(task),file=path.join(directory,task.finalName);let stat;
  try{stat=await fsp.lstat(file,{bigint:true});}catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(!stat.isFile() || stat.isSymbolicLink() || !same(task.part,stat))return false;
  const handle=await fsp.open(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try{const opened=await handle.stat({bigint:true});requireValue(opened.isFile() && same(task.part,opened) && Number(opened.size)===task.size && await digest(handle,task.size,signal)===task.sha256,'FILES_DESTINATION_CHANGED');return true;}finally{await handle.close();}
}
async function publish(task,save,signal){
  const directory=await directoryFor(task),part=partPath(task);
  // The final candidate is journaled BEFORE linking. On recovery, an existing
  // candidate is ours only if it is still the staged file's inode.
  if(await published(task,signal)){task.state='complete';save();await cleanupPart(task);return;}
  const staged=await fsp.lstat(part,{bigint:true});requireValue(staged.isFile() && !staged.isSymbolicLink() && same(task.part,staged) && Number(staged.size)===task.size,'FILES_DESTINATION_CHANGED');
  const originalExt=path.extname(task.name),ext=originalExt.length<=60?originalExt:'',stem=task.name.slice(0,task.name.length-ext.length);
  for(let index=0;index<10000;index++){
    check(signal);await directoryFor(task);task.finalName=index?stem.slice(0,170-ext.length)+' ('+index+')'+ext:task.name;
    task.state='publishing';save();
    try{await fsp.link(part,path.join(directory,task.finalName));}
    catch(error){if(error.code==='EEXIST')continue;if(['EPERM','EXDEV','ENOTSUP','EOPNOTSUPP'].includes(error.code))throw fault('FILES_DESTINATION_UNSUPPORTED');throw error;}
    await syncDirectory(directory);task.state='complete';save();await cleanupPart(task);return;
  }
  throw fault('FILES_EXISTS');
}
class FileStorage{
  constructor(directory,{write=atomicWrite}={}){
    this.directory=directory;this.file=path.join(directory,'queue.json');this.write=write;this.jobs=[];
    if(fs.existsSync(this.file)){
      const dir=fs.lstatSync(directory),stat=fs.lstatSync(this.file);requireValue(dir.isDirectory() && !dir.isSymbolicLink() && stat.isFile() && !stat.isSymbolicLink() && stat.size<=1024*1024 && (process.platform==='win32' || !(stat.mode&0o077)),'INVALID_PRIVATE_STORAGE');
      const data=JSON.parse(fs.readFileSync(this.file,'utf8'));requireValue(data.version===1 && Array.isArray(data.jobs) && data.jobs.length<=128,'INVALID_PRIVATE_STORAGE');
      const seen=new Set();for(const task of data.jobs){this.validate(task);requireValue(!seen.has(task.id),'INVALID_PRIVATE_STORAGE');seen.add(task.id);if(!terminal.has(task.state))task.state=task.cancelRequested?'cancel-pending':'paused';this.jobs.push(task);}
    }
  }
  validate(task){
    requireValue(task && id(task.id) && hash(task.hostId) && id(task.clientId) && (!task.networkId || id(task.networkId)) && hash(task.identity) && typeof task.hostName==='string' && task.hostName.length<=128 && states.has(task.state) && ['upload','download'].includes(task.direction) && integer(task.size) && integer(task.offset,task.size) && integer(task.verified,task.size) && (!task.sha256 || hash(task.sha256)),'INVALID_PRIVATE_STORAGE');
    location(task.root,task.path);safeName(task.name);if(task.finalName)safeName(task.finalName);
    if(task.direction==='upload')requireValue(task.source && absolute(task.source.file) && validIdentity(task.source) && /^-?\d+$/.test(task.source.mtime),'INVALID_PRIVATE_STORAGE');
    else requireValue(task.destination && absolute(task.destination.directory) && validIdentity(task.destination) && (!task.part || validIdentity(task.part)),'INVALID_PRIVATE_STORAGE');
  }
  save(){for(const task of this.jobs)this.validate(task);const value={version:1,jobs:this.jobs};requireValue(Buffer.byteLength(JSON.stringify(value))<=1024*1024,'FILES_QUEUE_FULL');this.write(this.directory,this.file,value);}
  add(tasks){requireValue(tasks.length>0 && this.jobs.length+tasks.length<=128,'FILES_QUEUE_FULL');for(const task of tasks)this.validate(task);this.jobs.push(...tasks);try{this.save();}catch(error){this.jobs.splice(-tasks.length);throw error;}}
  get(id){const task=this.jobs.find(task=>task.id===id);requireValue(task,'FILES_NOT_FOUND');return task;}
  forget(task){requireValue(terminal.has(task.state),'FILES_INVALID_STATE');const previous=this.jobs;this.jobs=previous.filter(item=>item!==task);try{this.save();}catch(error){this.jobs=previous;throw error;}}
}
module.exports={FileStorage,terminal,source,destination,openSource,verifySource,openPart,cleanupPart,digest,publish,published,directoryFor,partPath,check};
