'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {executable}=require('./mac/network-channel.cjs');
function verify(directory,platform=process.platform){
  executable(directory,platform);
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  const binary=platform==='win32'?'runtime/cliprelay-client-network.exe':'runtime/cliprelay-client-network';
  const required=[binary,'LICENSE','NETWORK-LICENSES.txt','cliprelay-network-source.tar.gz'];
  if(!Array.isArray(manifest.capabilities) || !manifest.capabilities.includes('pairing-bootstrap') ||
      Object.keys(manifest.files).length!==required.length || required.some(name=>!Object.hasOwn(manifest.files,name)))throw new Error('Incomplete desktop network package');
  let total=0;
  for(const name of required){
    const file=path.join(directory,name),stat=fs.lstatSync(file),hash=manifest.files[name];
    total+=stat.size;
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>128*1024*1024 || total>192*1024*1024 ||
        !/^[a-f0-9]{64}$/.test(hash) || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==hash)throw new Error('Invalid desktop network artifact');
  }
  return manifest;
}
function stage(source,destination,platform=process.platform){
  const manifest=verify(source,platform);
  // Packaging always uses a fresh directory; never replace user node state.
  fs.mkdirSync(destination);fs.mkdirSync(path.join(destination,'runtime'));
  for(const name of Object.keys(manifest.files))fs.copyFileSync(path.join(source,name),path.join(destination,name),fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  if(platform==='darwin')fs.chmodSync(path.join(destination,'runtime','cliprelay-client-network'),0o755);
  verify(destination,platform);
  return manifest;
}
module.exports={verify,stage};
