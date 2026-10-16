'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const EXECUTABLE='Sunshine.app/Contents/MacOS/Sunshine';
const UPSTREAM='63d35f702ee9e362e43263742981836ec0710384';
const HID='53e1a949fc0784af716b782ddfa6c647cafd1f05';
const SOURCES=[
  ...['upstream.json','control.patch','cliprelay_control.h','cliprelay_audio.h','cliprelay_input.h',
    'control_test.cpp','input_test.cpp','input_integration_test.cpp','README.md','macos-control.patch',
    'libvirtualhid-macos.patch','cliprelay_macos.h','macos_mouse_test.cpp','cliprelay_capture.h',
    'macos_capture_test.mm','macos-dependencies.json','cliprelay_permissions.h','permissions_test.cpp'].map(name=>'engine/sunshine/'+name),
  'scripts/prepare_sunshine.py','scripts/package_sunshine_macos.py',
  'scripts/build_sunshine_macos_dependencies.py','.github/workflows/sunshine-macos.yml','scripts/test_sunshine_macos_permissions.py'
];
const REQUIRED=[EXECUTABLE,'Sunshine.app/Contents/Info.plist','Sunshine.app/Contents/Resources/assets/apps.json',
  'Sunshine.app/Contents/Resources/assets/web/index.html','SUNSHINE-LICENSE','LIBVIRTUALHID-LICENSE',
  'input-tests.xml','permission-tests.json','dependency-build.json','dependency-licenses/boost/LICENSE_1_0.txt',
  'dependency-licenses/icu/LICENSE','dependency-licenses/icu/license.html','dependency-licenses/miniupnpc/LICENSE',
  'dependency-licenses/openssl/LICENSE.txt','dependency-licenses/opus/COPYING',...SOURCES.map(name=>'source/'+name)];
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const sameKeys=(value,keys)=>object(value) && JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());
function reject(){throw new Error('Invalid Mac host engine artifact');}
function validName(name){
  return typeof name==='string' && name.length<=1024 && !/[\\\0-\x1f:]/.test(name) &&
    !name.startsWith('/') && name.split('/').every(part=>part!=='' && part!=='.' && part!=='..');
}
function readFile(file,limit){
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>limit)reject();
  return fs.readFileSync(file);
}
// Verify the thin Mach-O itself; manifest architecture/OS labels are insufficient.
function nativeInfo(data,arch){
  if(data.length<32 || data.readUInt32LE(0)!==0xfeedfacf ||
      data.readUInt32LE(4)!==({arm64:0x0100000c,x86_64:0x01000007})[arch])reject();
  const count=data.readUInt32LE(16),end=32+data.readUInt32LE(20);
  if(count>65536 || end>data.length)reject();
  let offset=32,minimum=null,signature=false;
  const dependencies=[];
  for(let index=0;index<count;index++){
    if(offset+8>end)reject();
    const command=data.readUInt32LE(offset),size=data.readUInt32LE(offset+4);
    if(size<8 || offset+size>end)reject();
    if([0xc,0x80000018,0x8000001f,0x80000023].includes(command)){
      if(size<24)reject();
      const start=offset+data.readUInt32LE(offset+8),zero=data.indexOf(0,start);
      if(start<offset+24 || start>=offset+size || zero<start || zero>=offset+size)reject();
      dependencies.push(new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(start,zero)));
    }else if(command===0x32 || command===0x24){
      if(minimum!==null || size<(command===0x32?24:16) || (command===0x32 && data.readUInt32LE(offset+8)!==1))reject();
      const value=data.readUInt32LE(offset+(command===0x32?12:8));
      if(value>0x000e0200)reject();
      minimum=[value>>>16,(value>>>8)&255,value&255].join('.');
    }else if(command===0x1d){
      if(size<16)reject();
      const start=data.readUInt32LE(offset+8),length=data.readUInt32LE(offset+12);
      if(start<end || length===0 || start+length>data.length)reject();
      signature=true;
    }
    offset+=size;
  }
  if(offset!==end || !signature || minimum===null)reject();
  return {minimum,dependencies};
}
function verify(directory,pin){
  if(!object(pin) || !['arm64','x86_64'].includes(pin.arch) || !/^[a-f0-9]{40}$/.test(pin.commit) || !/^[a-f0-9]{64}$/.test(pin.manifestSha256))reject();
  const root=path.resolve(directory);
  if(!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink())reject();
  const raw=readFile(path.join(root,'manifest.json'),1024*1024);
  if(hash(raw)!==pin.manifestSha256)reject();
  const manifest=JSON.parse(raw);
  if(manifest.protocol!==1 || manifest.platform!=='darwin' || manifest.arch!==pin.arch || manifest.sourceCommit!==pin.commit ||
      manifest.upstreamCommit!==UPSTREAM || manifest.libvirtualhidCommit!==HID || manifest.executable!==EXECUTABLE ||
      manifest.deploymentTarget!=='14.2' || manifest.signature!=='ad-hoc' || manifest.notarized!==false ||
      manifest.permissionCommand!==1 ||
      !object(manifest.files) || !sameKeys(manifest.sourceHashes,SOURCES) || !sameKeys(manifest.symlinks,[]) ||
      !object(manifest.nativeDependencies) || !Object.hasOwn(manifest.nativeDependencies,EXECUTABLE) ||
      !sameKeys(manifest.nativeMinimumOS,Object.keys(manifest.nativeDependencies)) ||
      !Array.isArray(manifest.inputTests) || manifest.inputTests.length!==39 || new Set(manifest.inputTests).size!==39)reject();
  const expected=Object.keys(manifest.files);
  if(expected.length>4096 || REQUIRED.some(name=>!Object.hasOwn(manifest.files,name)))reject();
  const names=new Set(['manifest.json']);
  for(const name of expected){
    const folded=name.toLowerCase().normalize('NFC');
    if(!validName(name) || name==='manifest.json' || names.has(folded) || !/^[a-f0-9]{64}$/.test(manifest.files[name]))reject();
    names.add(folded);
  }
  const files=[];
  let total=0,entries=0;
  function walk(current,relative=''){
    for(const item of fs.readdirSync(current,{withFileTypes:true})){
      if(++entries>8192)reject();
      const name=relative+item.name,file=path.join(current,item.name);
      if(!validName(name) || item.isSymbolicLink())reject();
      if(item.isDirectory())walk(file,name+'/');
      else if(item.isFile())files.push(name);
      else reject();
    }
  }
  walk(root);
  if(JSON.stringify(files.sort())!==JSON.stringify([...expected,'manifest.json'].sort()))reject();
  const actualNative=[],expectedTests=[];
  const testSuites={'source/engine/sunshine/input_integration_test.cpp':'ClipRelayInputTest',
    'source/engine/sunshine/macos_mouse_test.cpp':'ClipRelayMacMouseTest',
    'source/engine/sunshine/macos_capture_test.mm':'ClipRelayMacCaptureTest'};
  for(const name of expected){
    const data=readFile(path.join(root,name),128*1024*1024);total+=data.length;
    if(total>256*1024*1024 || hash(data)!==manifest.files[name])reject();
    if(name.startsWith('source/') && manifest.sourceHashes[name.slice(7)]!==hash(data))reject();
    if(testSuites[name])for(const match of data.toString('utf8').matchAll(new RegExp('TEST_F\\('+testSuites[name]+',\\s*(\\w+)\\)','g')))expectedTests.push(match[1]);
    if(data.length>=4 && [0xfeedfacf,0xcffaedfe,0xfeedface,0xcefaedfe,0xbebafeca,0xcafebabe,0xbfbafeca,0xcafebabf].includes(data.readUInt32LE(0))){
      const info=nativeInfo(data,pin.arch);actualNative.push(name);
      if(name===EXECUTABLE && data.readUInt32LE(12)!==2)reject();
      if(info.minimum!==manifest.nativeMinimumOS[name] || JSON.stringify(info.dependencies)!==JSON.stringify(manifest.nativeDependencies[name]))reject();
      for(const dependency of info.dependencies){
        if(dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')){
          if(path.posix.normalize(dependency)!==dependency)reject();
          continue;
        }
        let target;
        if(dependency.startsWith('@executable_path/'))target=path.posix.join(path.posix.dirname(EXECUTABLE),dependency.slice(17));
        else if(dependency.startsWith('@loader_path/'))target=path.posix.join(path.posix.dirname(name),dependency.slice(13));
        else reject();
        if(!target.startsWith('Sunshine.app/') || !Object.hasOwn(manifest.nativeDependencies,target))reject();
      }
    }
  }
  if(!sameKeys(manifest.nativeDependencies,actualNative) || JSON.stringify(expectedTests.sort())!==JSON.stringify([...manifest.inputTests].sort()))reject();
  const permissions=JSON.parse(readFile(path.join(root,'permission-tests.json'),16384));
  if(permissions.protocol!==1 || permissions.passed!==true || permissions.applicationStateUnchanged!==true || permissions.nativeRequestsExecuted!==false ||
      JSON.stringify(permissions.cases)!==JSON.stringify(['status','invalid-action','misplaced-option','repeat-status']) ||
      !sameKeys(permissions.lastStatus,['protocol','screenRecording','inputControl','requested']) || permissions.lastStatus.protocol!==1 ||
      permissions.lastStatus.requested!=='none' || typeof permissions.lastStatus.screenRecording!=='boolean' || typeof permissions.lastStatus.inputControl!=='boolean')reject();
  return manifest;
}
function stage(source,destination,pin){
  const manifest=verify(source,pin);
  fs.mkdirSync(destination); // A new package directory only; never replace user state.
  for(const name of [...Object.keys(manifest.files),'manifest.json']){
    const target=path.join(destination,name);fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.copyFileSync(path.join(source,name),target,fs.constants.COPYFILE_EXCL);
  }
  if(process.platform==='darwin')fs.chmodSync(path.join(destination,EXECUTABLE),0o755);
  verify(destination,pin);
  return manifest;
}
module.exports={verify,stage,EXECUTABLE};
