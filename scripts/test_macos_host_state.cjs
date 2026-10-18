'use strict';
// Validate the packaged configuration writer against the actual packaged engine.
// The encrypted-storage fixture does not establish macOS Keychain availability.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function snapshot(root){
  const entries={};let count=0;
  function visit(file,relative,depth){
    if(++count>10000 || depth>32)throw new Error('STATE_SNAPSHOT_TOO_LARGE');
    const info=fs.lstatSync(file);
    const value={mode:info.mode,uid:info.uid};entries[relative]=value;
    if(info.isSymbolicLink())value.link=fs.readlinkSync(file);
    else if(info.isDirectory())for(const name of fs.readdirSync(file).sort())visit(path.join(file,name),relative+'/'+name,depth+1);
    else if(info.isFile()){
      if(info.size>16*1024*1024)throw new Error('STATE_SNAPSHOT_TOO_LARGE');
      value.hash=hash(fs.readFileSync(file));
    }else throw new Error('STATE_SNAPSHOT_UNSUPPORTED');
  }
  try{visit(root,'',0);}catch(error){if(error.code==='ENOENT' && count===1)return null;throw error;}
  return entries;
}
function encryptedStorage(){
  const key=crypto.randomBytes(32);
  return {
    isEncryptionAvailable:()=>true,
    encryptString(value){
      const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
      return Buffer.concat([iv,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()]);
    },
    decryptString(value){
      const decipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12,-16)),decipher.final()]).toString('utf8');
    }
  };
}
function main(){
  assert.equal(process.platform,'darwin');
  const engineDirectory=path.resolve(process.argv[2]),appDirectory=path.dirname(engineDirectory);
  const {HostState}=require(path.join(appDirectory,'host-state.cjs'));
  const {verify}=require(path.join(appDirectory,'host-engine-artifact.cjs'));
  const pin=JSON.parse(fs.readFileSync(path.join(appDirectory,'host-engine-pin.json'),'utf8'));
  const manifest=verify(engineDirectory,pin);assert.equal(manifest.stateCommand,1);
  const engine=path.join(engineDirectory,'Sunshine.app','Contents','MacOS','Sunshine');
  const protectedDirectories=[path.join(os.homedir(),'.config','sunshine'),path.join(os.homedir(),'Library','Application Support','ClipRelay','host')];
  const protectedBefore=protectedDirectories.map(snapshot),originalHome=process.env.HOME;
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-packaged-host-state-')),base=fs.realpathSync(temporary);
  const directory=path.join(base,'ClipRelay 私有 state #1'),safeStorage=encryptedStorage(),cases=[];
  const state=new HostState({directory,safeStorage});let reopened;
  function invoke(owner,args,status){
    const env=owner.environment();assert.equal(env.HOME,originalHome);
    const result=spawnSync(engine,args,{cwd:base,env,input:'',encoding:'utf8',timeout:15000,killSignal:'SIGKILL',maxBuffer:65536});
    if(result.error || result.signal || result.status!==status || Buffer.byteLength(result.stderr)>16384)throw new Error('PACKAGED_STATE_COMMAND_FAILED');
    assert.equal(process.env.HOME,originalHome);return result.stdout;
  }
  let privateFiles;
  try{
    const identity=state.prepare('Fixture Mac\nupnp = enabled # comment'),authorization=state.authorization();
    const original=snapshot(directory);
    assert.deepEqual(JSON.parse(invoke(state,['--cliprelay-state','check'],0)),{protocol:1,ready:true});
    assert.deepEqual(snapshot(directory),original);cases.push('packaged-private-check');
    // Unknown upstream commands exit after config and logging, before capture,
    // permissions, network listeners or any full host initialization.
    invoke(state,['--cliprelay-config-fixture'],7);
    assert.ok(fs.lstatSync(path.join(directory,'engine.log')).isFile());
    for(const name of ['.cliprelay-host.json','apps.json','credentials.json','sunshine.conf']){
      assert.deepEqual(snapshot(directory)['/'+name],original['/'+name]);
    }
    cases.push('packaged-private-config');state.close();
    reopened=new HostState({directory,safeStorage});assert.equal(reopened.prepare('Renamed Fixture Mac').id,identity.id);
    assert.equal(reopened.authorization(),authorization);invoke(reopened,['--cliprelay-config-fixture'],7);
    cases.push('packaged-private-reopen');
    reopened.checkFiles();assert.equal(fs.statSync(directory).mode&0o777,0o700);
    const secret=Buffer.from(authorization.slice(6),'base64').toString('utf8').slice('cliprelay:'.length);
    privateFiles=fs.readdirSync(directory).sort();
    for(const name of privateFiles){
      const file=path.join(directory,name);assert.ok(fs.lstatSync(file).isFile());
      assert.equal(fs.statSync(file).mode&0o777,0o600);assert.ok(!fs.readFileSync(file,'utf8').includes(secret));
    }
    assert.deepEqual(fs.readdirSync(base),[path.basename(directory)]);
    assert.deepEqual(protectedDirectories.map(snapshot),protectedBefore);
  }finally{
    state.close();reopened?.close();
    assert.ok(base.startsWith(fs.realpathSync(os.tmpdir())+path.sep));
    assert.ok(path.basename(base).startsWith('cliprelay-packaged-host-state-'));
    fs.rmSync(base,{recursive:true,force:true});
  }
  process.stdout.write(JSON.stringify({protocol:1,passed:true,cases,privateFiles,stateFilesPrivate:true,defaultStateUnchanged:true,
    homeChanged:false,nativeRequestsExecuted:false,hostStarted:false,ownedChildrenReaped:true,keychainValidated:false,
    scope:'Actual packaged configuration writer and native config/log initialization with fixture encryption. No Keychain, permissions, capture, listeners or full host startup.'})+'\n');
}
module.exports={snapshot,encryptedStorage};
if(require.main===module){
  try{main();}catch(error){console.error(error.code || 'PACKAGED_HOST_STATE_CHECK_FAILED');process.exitCode=1;}
}
