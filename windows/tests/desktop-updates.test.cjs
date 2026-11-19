const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {Updates,newer,assetFor}=require('../electron/mac/updates.cjs');
const {versionFor}=require('../../scripts/desktop-release-version.cjs');
test('main versions increase without rewriting source versions in git',()=>{
  const a=versionFor({versionName:'0.4.3',versionCode:12},400),b=versionFor({versionName:'0.4.3',versionCode:12},401);
  assert.equal(a.versionName,'0.4.403');assert.ok(newer(b.versionName,a.versionName));assert.ok(b.versionCode>a.versionCode);
});
test('development never checks or downloads the formal update feed',async()=>{
  const updates=new Updates({version:'0.4.3',development:true,fetch:()=>{throw new Error('unexpected network');}});
  assert.equal((await updates.check()).phase,'development');assert.equal((await updates.download()).phase,'development');
});
test('mac download verifies bytes and leaves installation to the user',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clip-update-'));
  try{
    const bytes=Buffer.from('verified package'),asset={archive:'ClipRelay-macOS-arm64.zip',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),downloadUrl:'https://github.com/ffffhx/cliprelay/releases/download/macos-v0.4.9/ClipRelay-macOS-arm64.zip'};
    const manifest={versionName:'0.4.9',assets:{arm64:asset}};
    const updates=new Updates({version:'0.4.3',directory,arch:'arm64',fetch:async url=>url.endsWith('.json')?{ok:true,json:async()=>manifest}:{ok:true,body:(async function*(){yield bytes;})()}});
    assert.equal((await updates.check()).phase,'available');assert.equal((await fs.readdir(directory)).length,0);
    assert.equal((await updates.download()).phase,'downloaded');assert.deepEqual(await fs.readFile(updates.state.file),bytes);
    const bad={...manifest,assets:{arm64:{...asset,downloadUrl:'https://evil.invalid/a.zip'}}};assert.throws(()=>assetFor(bad,'arm64'));
    const mismatch=new Updates({version:'0.4.3',directory,arch:'arm64',fetch:async url=>url.endsWith('.json')?{ok:true,json:async()=>manifest}:{ok:true,body:(async function*(){yield Buffer.from('corrupted');})()}});
    await mismatch.check();assert.equal((await mismatch.download()).phase,'error');assert.equal((await fs.readdir(directory)).some(name=>name.endsWith('.part')),false);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
