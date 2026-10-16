'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {HostState,configuration,credentials}=require('../electron/mac/host-state.cjs');
const native={skip:process.platform!=='darwin'};
function fixture(t){
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-owned-host-state-')),base=fs.realpathSync(temporary),directory=path.join(base,'ClipRelay state #1');
  const key=crypto.randomBytes(32);
  const safeStorage={isEncryptionAvailable:()=>true,encryptString(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()]);},decryptString(value){const cipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));cipher.setAuthTag(value.subarray(-16));return Buffer.concat([cipher.update(value.subarray(12,-16)),cipher.final()]).toString('utf8');}};
  const state=new HostState({directory,safeStorage});
  t.after(()=>{state.close();assert.ok(base.startsWith(fs.realpathSync(os.tmpdir())+path.sep));assert.ok(path.basename(base).startsWith('cliprelay-owned-host-state-'));fs.rmSync(base,{recursive:true,force:true});});
  return {base,directory,state,safeStorage};
}
test('host configuration contains only owned relative files and cannot inject additional settings',()=>{
  const value=configuration('Mac\nupnp = enabled # comment');
  assert.equal(value.split('\n').filter(line=>line.startsWith('upnp = ')).length,1);assert.match(value,/\nupnp = disabled\n/);
  for(const key of ['file_apps','file_state','credentials_file','pkey','cert','log_path'])assert.match(value,new RegExp('\\n'+key+' = [a-z.]+\\n'));
  assert.match(value,/lan_encryption_mode = 2/);assert.match(value,/wan_encryption_mode = 2/);assert.throws(()=>configuration({}));
});
test('admin credential hashing uses the existing Sunshine reversed uppercase digest format',()=>{
  const secret='secret-password',salt='0123456789abcdef',value=credentials(secret,salt);
  assert.equal(value.username,'cliprelay');assert.equal(value.salt,salt);assert.equal(value.password.length,64);assert.match(value.password,/^[A-F0-9]{64}$/);
  const recovered=Buffer.from(value.password,'hex').reverse();assert.deepEqual(recovered,crypto.createHash('sha256').update(secret+salt).digest());
});
test('a new host has private durable files and a reusable encrypted identity',native,t=>{
  const f=fixture(t),first=f.state.prepare('Fixture Mac'),authorization=f.state.authorization(),second=new HostState({directory:f.directory,safeStorage:f.safeStorage});t.after(()=>second.close());
  assert.equal(second.prepare('Renamed Mac').id,first.id);assert.equal(second.authorization(),authorization);
  const secret=Buffer.from(authorization.slice(6),'base64').toString().slice('cliprelay:'.length);
  for(const entry of fs.readdirSync(f.directory)){const file=path.join(f.directory,entry);assert.equal(fs.statSync(file).mode&0o777,0o600);assert.ok(!fs.readFileSync(file,'utf8').includes(secret));}
  assert.equal(fs.statSync(f.directory).mode&0o777,0o700);assert.match(fs.readFileSync(path.join(f.directory,'sunshine.conf'),'utf8'),/Renamed Mac/);
  const parent={HOME:'/unchanged/fixture',EXAMPLE:'preserved'},env=second.environment(parent);assert.deepEqual(parent,{HOME:'/unchanged/fixture',EXAMPLE:'preserved'});assert.equal(env.HOME,parent.HOME);assert.equal(env.CLIPRELAY_HOST_STATE_DIR,f.directory);
});
test('keychain unavailability does not create or initialize a state directory',native,t=>{
  const f=fixture(t);f.safeStorage.isEncryptionAvailable=()=>false;
  assert.throws(()=>f.state.prepare('Mac'),{code:'HOST_KEYCHAIN_UNAVAILABLE'});assert.equal(fs.existsSync(f.directory),false);
});
test('unowned existing files and permissive directories are not adopted or repaired',native,t=>{
  const f=fixture(t);fs.mkdirSync(f.directory,{mode:0o700});fs.writeFileSync(path.join(f.directory,'existing'),'preserve');
  assert.throws(()=>f.state.prepare('Mac'),{code:'HOST_STATE_UNOWNED'});assert.equal(fs.readFileSync(path.join(f.directory,'existing'),'utf8'),'preserve');
  fs.chmodSync(f.directory,0o755);assert.throws(()=>f.state.prepare('Mac'),{code:'HOST_STATE_INVALID'});assert.equal(fs.statSync(f.directory).mode&0o777,0o755);
});
test('symlinked roots or settings cannot redirect private writes',native,t=>{
  const f=fixture(t),target=path.join(f.base,'outside');fs.mkdirSync(target,{mode:0o700});fs.symlinkSync(target,f.directory);
  assert.throws(()=>f.state.prepare('Mac'),{code:'HOST_STATE_INVALID'});assert.deepEqual(fs.readdirSync(target),[]);
  fs.unlinkSync(f.directory);f.state.prepare('Mac');fs.unlinkSync(path.join(f.directory,'credentials.json'));
  const victim=path.join(target,'victim');fs.writeFileSync(victim,'preserve');fs.symlinkSync(victim,path.join(f.directory,'credentials.json'));
  assert.throws(()=>f.state.prepare('Mac'));assert.equal(fs.readFileSync(victim,'utf8'),'preserve');
});
test('configuration preparation preserves existing server identity and paired clients',native,t=>{
  const f=fixture(t);f.state.prepare('Mac');
  for(const entry of ['cacert.pem','cakey.pem','clients.json'])fs.writeFileSync(path.join(f.directory,entry),'native owned fixture',{mode:0o600});
  f.state.prepare('Mac');for(const entry of ['cacert.pem','cakey.pem','clients.json'])assert.equal(fs.readFileSync(path.join(f.directory,entry),'utf8'),'native owned fixture');
  f.state.close();assert.throws(()=>f.state.authorization(),{code:'HOST_STATE_NOT_PREPARED'});assert.throws(()=>f.state.prepare('Mac'),{code:'HOST_STATE_CLOSED'});
});
test('a substituted directory cannot reuse a prepared host identity',native,t=>{
  const f=fixture(t);f.state.prepare('Mac');fs.renameSync(f.directory,path.join(f.base,'previous'));fs.mkdirSync(f.directory,{mode:0o700});
  assert.throws(()=>f.state.environment(),{code:'HOST_STATE_CHANGED'});assert.throws(()=>f.state.prepare('Mac'),{code:'HOST_STATE_CHANGED'});assert.deepEqual(fs.readdirSync(f.directory),[]);
});

test('native-managed state links and broad permissions are rejected before launch',native,t=>{
  const f=fixture(t);f.state.prepare('Mac');
  const victim=path.join(f.base,'victim');fs.writeFileSync(victim,'preserve',{mode:0o600});
  const clients=path.join(f.directory,'clients.json');fs.symlinkSync(victim,clients);
  assert.throws(()=>f.state.environment(),{code:'HOST_STATE_INVALID'});assert.throws(()=>f.state.prepare('Mac'),{code:'HOST_STATE_INVALID'});
  assert.equal(fs.readFileSync(victim,'utf8'),'preserve');fs.unlinkSync(clients);fs.linkSync(victim,clients);
  assert.throws(()=>f.state.prepare('Mac'),{code:'HOST_STATE_INVALID'});fs.unlinkSync(clients);
  fs.writeFileSync(clients,'native fixture',{mode:0o644});fs.chmodSync(clients,0o644);
  assert.throws(()=>f.state.prepare('Mac'),{code:'HOST_STATE_INVALID'});assert.equal(fs.statSync(clients).mode&0o777,0o644);
});

test('failed keychain refresh withdraws previously prepared authentication',native,t=>{
  const f=fixture(t);f.state.prepare('Mac');assert.match(f.state.authorization(),/^Basic /);
  f.safeStorage.isEncryptionAvailable=()=>false;
  assert.throws(()=>f.state.prepare('Mac'),{code:'HOST_KEYCHAIN_UNAVAILABLE'});
  assert.throws(()=>f.state.authorization(),{code:'HOST_STATE_NOT_PREPARED'});
  assert.throws(()=>f.state.environment(),{code:'HOST_STATE_NOT_PREPARED'});
});

test('a corrupt ownership marker is preserved and cannot silently create a new identity',native,t=>{
  const f=fixture(t);f.state.prepare('Mac');
  const marker=path.join(f.directory,'.cliprelay-host.json');fs.writeFileSync(marker,'invalid fixture');
  assert.throws(()=>f.state.prepare('Mac'),{code:'HOST_STATE_UNAVAILABLE'});
  assert.equal(fs.readFileSync(marker,'utf8'),'invalid fixture');assert.throws(()=>f.state.authorization(),{code:'HOST_STATE_NOT_PREPARED'});
});
