'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {verify,stage}=require('../electron/network-artifact.cjs');
function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-network-artifact-')),source=path.join(base,'artifact');fs.mkdirSync(path.join(source,'runtime'),{recursive:true});
  const files={};for(const name of ['runtime/cliprelay-client-network.exe','LICENSE','NETWORK-LICENSES.txt','cliprelay-network-source.tar.gz']){
    const body=Buffer.from('synthetic inert '+name);fs.writeFileSync(path.join(source,name),body);files[name]=crypto.createHash('sha256').update(body).digest('hex');
  }
  const manifest={role:'desktop-network',platform:'windows',protocol:1,capabilities:['pairing-bootstrap'],files};
  const save=()=>fs.writeFileSync(path.join(source,'manifest.json'),JSON.stringify(manifest));save();
  t.after(()=>{assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(base).startsWith('cliprelay-network-artifact-'));fs.rmSync(base,{recursive:true,force:true});});
  return {base,source,manifest,save};
}
test('network packaging copies only four verified files and refuses existing destinations',t=>{
  const f=fixture(t),target=path.join(f.base,'network-helper');fs.writeFileSync(path.join(f.source,'unlisted-secret'),'synthetic');
  assert.equal(Object.keys(stage(f.source,target,'win32').files).length,4);assert.ok(!fs.existsSync(path.join(target,'unlisted-secret')));
  assert.deepEqual(verify(target,'win32'),f.manifest);assert.throws(()=>stage(f.source,target,'win32'),{code:'EEXIST'});
});
test('network packaging verifies notices and rejects old capabilities, unknown files and platform mismatch',t=>{
  const f=fixture(t);f.manifest.capabilities=[];f.save();assert.throws(()=>verify(f.source,'win32'),/Incomplete/);
  f.manifest.capabilities=['pairing-bootstrap'];f.manifest.files['../outside']='a'.repeat(64);f.save();assert.throws(()=>verify(f.source,'win32'),/Incomplete/);
  delete f.manifest.files['../outside'];f.manifest.platform='macos';f.save();assert.throws(()=>verify(f.source,'win32'));
  f.manifest.platform='windows';f.save();fs.appendFileSync(path.join(f.source,'NETWORK-LICENSES.txt'),'tampered');assert.throws(()=>verify(f.source,'win32'),/Invalid/);
});
