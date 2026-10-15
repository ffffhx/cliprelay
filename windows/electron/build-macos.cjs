'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');

async function build(){
  if(process.platform!=='darwin')throw new Error('Build the macOS application on macOS (Xcode Command Line Tools required).');
  const architecture=process.argv[2] || process.arch;if(!['arm64','x64'].includes(architecture))throw new Error('Use arm64 or x64.');
  const {packager}=await import('@electron/packager');
  const windowsRoot=path.resolve(__dirname,'..');
  const repo=path.resolve(windowsRoot,'..');
  const staging=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-electron-mac-'));
  try{
    const source=path.join(staging,'source');fs.mkdirSync(source);
    fs.cpSync(path.join(__dirname,'mac'),path.join(source,'mac'),{recursive:true});
    if(process.env.CLIPRELAY_VIEWER_ARTIFACT){
      const artifact=path.resolve(process.env.CLIPRELAY_VIEWER_ARTIFACT);
      require('./mac/stream-viewer.cjs').executable(artifact,'darwin');
      // Preserve the relative framework symlinks made by macdeployqt.
      fs.cpSync(artifact,path.join(source,'mac','stream-viewer'),{recursive:true,verbatimSymlinks:true});
    }
    fs.writeFileSync(path.join(source,'main.js'),"require('./mac/main.cjs');\n");
    for(const name of ['package.json','package-lock.json'])fs.copyFileSync(path.join(__dirname,name),path.join(source,name));
    fs.copyFileSync(path.join(repo,'LICENSE'),path.join(source,'LICENSE'));
    execFileSync('npm',['ci','--omit=dev','--ignore-scripts'],{cwd:source,stdio:'inherit'});
    execFileSync('/usr/bin/clang',['-arch',architecture==='x64'?'x86_64':'arm64','-fobjc-arc','-framework','Foundation','-framework','ApplicationServices',path.join(source,'mac','copy-selection.m'),'-o',path.join(source,'mac','copy-selection')],{stdio:'inherit'});
    const iconset=path.join(staging,'ClipRelay.iconset');fs.mkdirSync(iconset);
    const logo=path.join(repo,'assets','logo-512.png');
    for(const size of [16,32,128,256,512]){
      execFileSync('/usr/bin/sips',['-z',String(size),String(size),logo,'--out',path.join(iconset,`icon_${size}x${size}.png`)],{stdio:'ignore'});
      if(size<512)execFileSync('/usr/bin/sips',['-z',String(size*2),String(size*2),logo,'--out',path.join(iconset,`icon_${size}x${size}@2x.png`)],{stdio:'ignore'});
    }
    const icon=path.join(staging,'ClipRelay.icns');execFileSync('/usr/bin/iconutil',['-c','icns',iconset,'-o',icon]);
    const version=JSON.parse(fs.readFileSync(path.join(windowsRoot,'version.json'),'utf8').replace(/^\uFEFF/,''));
    const output=path.resolve(repo,'.tools','mac-electron');
    const built=await packager({dir:source,name:'ClipRelay',executableName:'ClipRelay',appBundleId:'com.cliprelay.desktop',appVersion:version.versionName,platform:'darwin',arch:architecture,electronVersion:'44.4.3',out:output,icon,asar:false,overwrite:false,extendInfo:{LSUIElement:true,NSLocalNetworkUsageDescription:'ClipRelay 在局域网中发现接收设备并同步剪贴板。',NSBonjourServices:['_cliprelay._tcp']}});
    for(const bundle of built){const zip=path.join(output,`ClipRelay-macOS-${architecture}-${version.versionName}.zip`);execFileSync('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',path.join(bundle,'ClipRelay.app'),zip]);console.log(zip);}
  }finally{
    const resolved=path.resolve(staging);const temp=path.resolve(os.tmpdir())+path.sep;
    if(!resolved.startsWith(temp)||!path.basename(resolved).startsWith('cliprelay-electron-mac-'))throw new Error('Unexpected staging path');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}
build().catch(error=>{console.error(error.message);process.exitCode=1;});
