'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {verify,stage,nativeInfo,EXECUTABLE,FILES}=require('../electron/mac/host-companion-artifact.cjs');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function binary(){
  const data=Buffer.alloc(192);data.writeUInt32BE(0xcafebabe,0);data.writeUInt32BE(2,4);
  for(let i=0;i<2;i++){
    const cpu=i?0x0100000c:0x01000007,table=8+20*i,start=64+64*i;
    for(const [offset,value] of [[0,cpu],[8,start],[12,64],[16,4]])data.writeUInt32BE(value,table+offset);
    for(const [offset,value] of [[0,0xfeedfacf],[4,cpu],[12,2],[16,1],[20,24],[32,0x32],[36,24],[40,1],[44,0x000c0000]])data.writeUInt32LE(value,start+offset);
  }
  return data;
}
function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-companion-artifact-')),source=path.join(base,'source');fs.mkdirSync(source);fs.mkdirSync(path.join(source,'runtime'));
  for(const name of FILES)fs.writeFileSync(path.join(source,name),name===EXECUTABLE?binary():Buffer.from('fixture-'+name));
  fs.chmodSync(path.join(source,EXECUTABLE),0o755);
  const manifest={role:'host-companion',platform:'macos',protocol:1,nativeWorkers:false,pairingControl:1,files:Object.fromEntries(FILES.map(name=>[name,hash(fs.readFileSync(path.join(source,name)))]))};
  const pin={commit:'a'.repeat(40),manifestSha256:''};
  function update(){const data=JSON.stringify(manifest);fs.writeFileSync(path.join(source,'manifest.json'),data);pin.manifestSha256=hash(data);}
  update();t.after(()=>{assert.ok(path.basename(base).startsWith('cliprelay-companion-artifact-'));fs.rmSync(base,{recursive:true,force:true});});
  return {base,source,manifest,pin,update};
}
test('both native slices are verified and only pinned files are copied into a fresh package',t=>{
  const f=fixture(t);for(const name of ['process-report.json','terminal-process-report.json'])fs.writeFileSync(path.join(f.source,name),'{}');
  const dest=path.join(f.base,'staged'),result=stage(f.source,dest,f.pin);
  assert.deepEqual(result.nativeMinimumOS,{x86_64:'12.0.0',arm64:'12.0.0'});verify(dest,f.pin);
  for(const name of ['process-report.json','terminal-process-report.json'])assert.equal(fs.existsSync(path.join(dest,name)),false);assert.throws(()=>stage(f.source,dest,f.pin));
});

test('optional CI terminal receipts remain bounded and cannot redirect file access',t=>{
  const f=fixture(t),receipt=path.join(f.source,'terminal-process-report.json');
  fs.writeFileSync(receipt,Buffer.alloc(16385));assert.throws(()=>verify(f.source,f.pin));fs.unlinkSync(receipt);
  fs.linkSync(path.join(f.source,'LICENSE'),receipt);assert.throws(()=>verify(f.source,f.pin));
});
test('unselected manifests, changed payloads and unknown files fail admission',t=>{
  const f=fixture(t);assert.throws(()=>verify(f.source,{...f.pin,manifestSha256:'b'.repeat(64)}));
  fs.writeFileSync(path.join(f.source,'unmanifested'),'fixture');assert.throws(()=>verify(f.source,f.pin));fs.unlinkSync(path.join(f.source,'unmanifested'));
  fs.appendFileSync(path.join(f.source,'LICENSE'),'changed');assert.throws(()=>verify(f.source,f.pin));
});
test('alternate platform, native-worker claims and file sets are rejected even with matching hashes',t=>{
  for(const mutation of [m=>m.platform='windows',m=>m.nativeWorkers=true,m=>delete m.pairingControl,m=>m.files['../escape']='a'.repeat(64),m=>m.files.LICENSE='invalid']){
    const f=fixture(t);mutation(f.manifest);f.update();assert.throws(()=>verify(f.source,f.pin));
  }
});

test('legacy and version-one file manifests are accepted but unknown capability versions fail admission',t=>{
  const f=fixture(t);assert.equal(verify(f.source,f.pin).manifest.fileTransfer,undefined);
  f.manifest.fileTransfer=1;f.update();assert.equal(verify(f.source,f.pin).manifest.fileTransfer,1);
  for(const version of [0,2,true,'1',null]){f.manifest.fileTransfer=version;f.update();assert.throws(()=>verify(f.source,f.pin));}
});

test('clipboard capability is optional for old packages and requires its exact supported version',t=>{
  const f=fixture(t);assert.equal(verify(f.source,f.pin).manifest.clipboardExchange,undefined);
  f.manifest.clipboardExchange=1;f.update();assert.equal(verify(f.source,f.pin).manifest.clipboardExchange,1);
  for(const version of [0,2,true,'1',null]){f.manifest.clipboardExchange=version;f.update();assert.throws(()=>verify(f.source,f.pin));}
});
test('Mach-O duplicate CPUs, overlap, type, platform and minimum-OS mismatches are rejected',()=>{
  for(const mutate of [b=>b.writeUInt32BE(0x01000007,28),b=>b.writeUInt32BE(64,36),b=>b.writeUInt32LE(6,76),
    b=>b.writeUInt32LE(2,104),b=>b.writeUInt32LE(0x000f0000,108),b=>b.writeUInt32LE(0xffffffff,84),b=>b.writeUInt32BE(0xffffffff,20)]){
    const data=binary();mutate(data);assert.throws(()=>nativeInfo(data));
  }
});
test('hard links and directory links cannot redirect a package payload',t=>{
  const f=fixture(t),victim=path.join(f.base,'victim');fs.renameSync(path.join(f.source,'LICENSE'),victim);fs.linkSync(victim,path.join(f.source,'LICENSE'));
  assert.throws(()=>verify(f.source,f.pin));fs.unlinkSync(path.join(f.source,'LICENSE'));fs.copyFileSync(victim,path.join(f.source,'LICENSE'));
  const runtime=path.join(f.base,'outside-runtime');fs.renameSync(path.join(f.source,'runtime'),runtime);fs.symlinkSync(runtime,path.join(f.source,'runtime'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>verify(f.source,f.pin));
});
