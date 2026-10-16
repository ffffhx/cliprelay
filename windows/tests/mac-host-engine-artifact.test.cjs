'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {verify,stage,EXECUTABLE}=require('../electron/mac/host-engine-artifact.cjs');
const root=path.resolve(__dirname,'../..'),sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const commit='9'.repeat(40);
// Synthetic Mach-O command boundaries only. No executable is run by these tests.
function native({arch='arm64',minimum=0x000e0200,dependency='/usr/lib/libSystem.B.dylib',signed=true}={}){
  const name=Buffer.from(dependency+'\0'),loadSize=Math.ceil((24+name.length)/8)*8;
  const end=32+24+loadSize+(signed?16:0),data=Buffer.alloc(end+16);
  data.writeUInt32LE(0xfeedfacf);data.writeUInt32LE(arch==='arm64'?0x0100000c:0x01000007,4);
  data.writeUInt32LE(2,12);data.writeUInt32LE(signed?3:2,16);data.writeUInt32LE(end-32,20);
  data.writeUInt32LE(0x32,32);data.writeUInt32LE(24,36);data.writeUInt32LE(1,40);data.writeUInt32LE(minimum,44);
  data.writeUInt32LE(0xc,56);data.writeUInt32LE(loadSize,60);data.writeUInt32LE(24,64);name.copy(data,80);
  if(signed){const offset=56+loadSize;data.writeUInt32LE(0x1d,offset);data.writeUInt32LE(16,offset+4);data.writeUInt32LE(end,offset+8);data.writeUInt32LE(16,offset+12);}
  return data;
}
function fixture(t,arch='arm64'){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-host-artifact-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const source=path.join(directory,'source');fs.mkdirSync(source);
  const sources=[...['upstream.json','control.patch','cliprelay_control.h','cliprelay_audio.h','cliprelay_input.h',
    'control_test.cpp','input_test.cpp','input_integration_test.cpp','README.md','macos-control.patch',
    'libvirtualhid-macos.patch','cliprelay_macos.h','macos_mouse_test.cpp','cliprelay_capture.h','macos_capture_test.mm',
    'macos-dependencies.json'].map(name=>'engine/sunshine/'+name),'scripts/prepare_sunshine.py',
    'scripts/package_sunshine_macos.py','scripts/build_sunshine_macos_dependencies.py','.github/workflows/sunshine-macos.yml'];
  const manifest={protocol:1,platform:'darwin',arch,sourceCommit:commit,
    upstreamCommit:'63d35f702ee9e362e43263742981836ec0710384',libvirtualhidCommit:'53e1a949fc0784af716b782ddfa6c647cafd1f05',
    executable:EXECUTABLE,deploymentTarget:'14.2',signature:'ad-hoc',notarized:false,files:{},symlinks:{},sourceHashes:{},
    nativeMinimumOS:{[EXECUTABLE]:'14.2.0'},nativeDependencies:{[EXECUTABLE]:['/usr/lib/libSystem.B.dylib']},inputTests:[]};
  function put(name,data){const file=path.join(source,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);manifest.files[name]=sha(data);}
  for(const name of sources){const data=fs.readFileSync(path.join(root,name));put('source/'+name,data);manifest.sourceHashes[name]=sha(data);
    for(const match of data.toString().matchAll(/TEST_F\(ClipRelay(?:Input|MacMouse|MacCapture)Test,\s*(\w+)\)/g))manifest.inputTests.push(match[1]);}
  for(const name of ['Sunshine.app/Contents/Info.plist','Sunshine.app/Contents/Resources/assets/apps.json',
    'Sunshine.app/Contents/Resources/assets/web/index.html','SUNSHINE-LICENSE','LIBVIRTUALHID-LICENSE','input-tests.xml',
    'dependency-build.json','dependency-licenses/boost/LICENSE_1_0.txt','dependency-licenses/icu/LICENSE',
    'dependency-licenses/icu/license.html','dependency-licenses/miniupnpc/LICENSE','dependency-licenses/openssl/LICENSE.txt',
    'dependency-licenses/opus/COPYING'])put(name,Buffer.from('fixture'));
  put(EXECUTABLE,native({arch}));
  function pin(){const bytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(path.join(source,'manifest.json'),bytes);return {arch,commit,manifestSha256:sha(bytes)};}
  return {directory,source,manifest,put,pin};
}
test('stages a complete pinned engine without starting it or replacing a destination',t=>{
  const f=fixture(t),pin=f.pin(),destination=path.join(f.directory,'staged');
  const result=stage(f.source,destination,pin);
  assert.equal(result.inputTests.length,39);assert.equal(verify(destination,pin).sourceCommit,commit);
  assert.deepEqual(fs.readFileSync(path.join(destination,EXECUTABLE)),fs.readFileSync(path.join(f.source,EXECUTABLE)));
  assert.throws(()=>stage(f.source,destination,pin),{code:'EEXIST'});
});
test('manifest and source version must match the caller pin',t=>{
  const f=fixture(t),pin=f.pin();
  assert.throws(()=>verify(f.source,{...pin,commit:'8'.repeat(40)}));
  f.manifest.scope='changed';f.pin();assert.throws(()=>verify(f.source,pin));
});
test('Intel artifacts have their own architecture pin and verified native binary',t=>{
  const f=fixture(t,'x86_64'),pin=f.pin();assert.equal(verify(f.source,pin).arch,'x86_64');
  assert.throws(()=>verify(f.source,{...pin,arch:'arm64'}));
});
test('actual Mach-O architecture overrides a misleading manifest label',t=>{
  const f=fixture(t);f.put(EXECUTABLE,native({arch:'x86_64'}));assert.throws(()=>verify(f.source,f.pin()));
});
test('actual minimum macOS version cannot exceed 14.2',t=>{
  const f=fixture(t);f.put(EXECUTABLE,native({minimum:0x001a0000}));assert.throws(()=>verify(f.source,f.pin()));
});
test('unsigned or truncated load commands are rejected',t=>{
  const f=fixture(t);f.put(EXECUTABLE,native({signed:false}));assert.throws(()=>verify(f.source,f.pin()));
  const truncated=native();truncated.writeUInt32LE(0xffffffff,36);f.put(EXECUTABLE,truncated);assert.throws(()=>verify(f.source,f.pin()));
});
test('external build-machine libraries cannot enter the application',t=>{
  const f=fixture(t),dependency='/opt/homebrew/lib/libexample.dylib';
  f.put(EXECUTABLE,native({dependency}));f.manifest.nativeDependencies[EXECUTABLE]=[dependency];assert.throws(()=>verify(f.source,f.pin()));
});
test('every native file must be declared and match native metadata',t=>{
  const f=fixture(t);f.put('Sunshine.app/Contents/MacOS/extra',native());assert.throws(()=>verify(f.source,f.pin()));
});
test('modified and extra files fail even when they are outside the executable',t=>{
  const f=fixture(t),pin=f.pin();fs.appendFileSync(path.join(f.source,'SUNSHINE-LICENSE'),'changed');assert.throws(()=>verify(f.source,pin));
  f.put('SUNSHINE-LICENSE',Buffer.from('fixture'));const fixed=f.pin();fs.writeFileSync(path.join(f.source,'extra'),'extra');assert.throws(()=>verify(f.source,fixed));
});
test('missing licenses and incomplete capture-test inventory are rejected',t=>{
  const f=fixture(t);f.manifest.inputTests.pop();assert.throws(()=>verify(f.source,f.pin()));
  const other=fixture(t);delete other.manifest.files['LIBVIRTUALHID-LICENSE'];fs.unlinkSync(path.join(other.source,'LIBVIRTUALHID-LICENSE'));
  assert.throws(()=>verify(other.source,other.pin()));
});
test('case aliases and parent traversal are rejected before copying',t=>{
  const f=fixture(t);f.manifest.files['../outside']=sha(Buffer.from('outside'));assert.throws(()=>verify(f.source,f.pin()));
  delete f.manifest.files['../outside'];f.manifest.files['sunshine-license']=f.manifest.files['SUNSHINE-LICENSE'];assert.throws(()=>verify(f.source,f.pin()));
});
test('directory links cannot bypass inventory checks',t=>{
  const f=fixture(t),pin=f.pin();fs.symlinkSync(path.join(f.source,'source'),path.join(f.source,'alias'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>verify(f.source,pin));
});
test('source receipts must match the actual included source',t=>{
  const f=fixture(t),name='engine/sunshine/cliprelay_capture.h';
  f.put('source/'+name,Buffer.from('changed'));assert.throws(()=>verify(f.source,f.pin()));
});
