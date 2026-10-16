'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
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
    let hostPin=null,companionPin=null;
    if(process.env.CLIPRELAY_HOST_ENGINE_ARTIFACT || process.env.CLIPRELAY_HOST_ENGINE_PIN){
      hostPin=JSON.parse(process.env.CLIPRELAY_HOST_ENGINE_PIN || 'null');
      if(!hostPin || hostPin.arch!==(architecture==='x64'?'x86_64':'arm64') || !process.env.CLIPRELAY_HOST_ENGINE_ARTIFACT)throw new Error('Host engine selection must match the application architecture');
      const artifact=path.resolve(process.env.CLIPRELAY_HOST_ENGINE_ARTIFACT);
      require('./mac/host-engine-artifact.cjs').stage(artifact,path.join(source,'mac','host-engine'),hostPin);
      execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',path.join(source,'mac','host-engine','Sunshine.app')],{stdio:'inherit'});
      fs.writeFileSync(path.join(source,'mac','host-engine-pin.json'),JSON.stringify(hostPin,null,2)+'\n',{flag:'wx'});
    }
    if(process.env.CLIPRELAY_HOST_COMPANION_ARTIFACT || process.env.CLIPRELAY_HOST_COMPANION_PIN){
      companionPin=JSON.parse(process.env.CLIPRELAY_HOST_COMPANION_PIN || 'null');
      if(!hostPin || !companionPin || !process.env.CLIPRELAY_HOST_COMPANION_ARTIFACT)throw new Error('Host companion requires an explicitly selected host engine and companion pin');
      require('./mac/host-companion-artifact.cjs').stage(path.resolve(process.env.CLIPRELAY_HOST_COMPANION_ARTIFACT),path.join(source,'mac','host-companion'),companionPin);
      fs.writeFileSync(path.join(source,'mac','host-companion-pin.json'),JSON.stringify(companionPin,null,2)+'\n',{flag:'wx'});
    }
    if(process.env.CLIPRELAY_NETWORK_HELPER_ARTIFACT){
      require('./network-artifact.cjs').stage(path.resolve(process.env.CLIPRELAY_NETWORK_HELPER_ARTIFACT),path.join(source,'mac','network-helper'),'darwin');
    }
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
    // npm ci --omit=dev already created the production-only dependency tree.
    // A second prune incorrectly resolves intentionally absent build tools.
    const built=await packager({dir:source,name:'ClipRelay',executableName:'ClipRelay',appBundleId:'com.cliprelay.desktop',appVersion:version.versionName,platform:'darwin',arch:architecture,electronVersion:'44.4.3',out:output,icon,asar:false,prune:false,derefSymlinks:false,overwrite:false,extendInfo:{LSUIElement:true,NSLocalNetworkUsageDescription:'ClipRelay 在局域网中发现接收设备并同步剪贴板。',NSBonjourServices:['_cliprelay._tcp'],...(hostPin?{LSMinimumSystemVersion:'14.2'}:{})}});
    for(const bundle of built){
      if(process.env.CI==='true' && process.env.GITHUB_ACTIONS==='true'){
        execFileSync('python3',[path.join(repo,'scripts','test_electron_clipboard.py'),'--runtime',path.join(bundle,'ClipRelay.app'),'--modules',path.join(bundle,'ClipRelay.app','Contents','Resources','app','mac'),'--report',path.join(output,`native-clipboard-bundle-${architecture}.json`)],{stdio:'inherit'});
      }
      if(hostPin){
        const packaged=path.join(bundle,'ClipRelay.app','Contents','Resources','app','mac','host-engine');
        const manifest=require('./mac/host-engine-artifact.cjs').verify(packaged,hostPin);
        if(JSON.stringify(JSON.parse(fs.readFileSync(path.join(path.dirname(packaged),'host-engine-pin.json'),'utf8')))!==JSON.stringify(hostPin))throw new Error('Packaged host engine pin changed');
        const minimum=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :LSMinimumSystemVersion',path.join(bundle,'ClipRelay.app','Contents','Info.plist')],{encoding:'utf8'}).trim();
        if(minimum!=='14.2')throw new Error('Host application must require macOS 14.2');
        execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',path.join(packaged,'Sunshine.app')],{stdio:'inherit'});
        const permissionCommands=JSON.parse(execFileSync(process.execPath,[path.join(repo,'scripts','test_macos_host_permissions.cjs'),packaged],{encoding:'utf8',timeout:30000,maxBuffer:65536}));
        if(permissionCommands.passed!==true || permissionCommands.nativeRequestsExecuted!==false || permissionCommands.ownedChildrenReaped!==true)throw new Error('Packaged host permission command check failed');
        const stateConfiguration=JSON.parse(execFileSync(process.execPath,[path.join(repo,'scripts','test_macos_host_state.cjs'),packaged],{encoding:'utf8',timeout:60000,maxBuffer:65536}));
        if(stateConfiguration.passed!==true || stateConfiguration.stateFilesPrivate!==true || stateConfiguration.defaultStateUnchanged!==true || stateConfiguration.homeChanged!==false || stateConfiguration.hostStarted!==false || stateConfiguration.nativeRequestsExecuted!==false || stateConfiguration.ownedChildrenReaped!==true || stateConfiguration.keychainValidated!==false)throw new Error('Packaged host state configuration check failed');
        const engineLifecycle=JSON.parse(execFileSync(process.execPath,[path.join(repo,'scripts','test_macos_host_engine.cjs'),packaged],{encoding:'utf8',timeout:150000,maxBuffer:65536}));
        if(engineLifecycle.passed!==true || engineLifecycle.hostStarted!==true || engineLifecycle.ownedChildrenReaped!==true || engineLifecycle.stateFilesPrivate!==true || engineLifecycle.defaultStateUnchanged!==true || engineLifecycle.homeChanged!==false || engineLifecycle.nativeRequestsExecuted!==false || engineLifecycle.streamStarted!==false || engineLifecycle.systemInputInjected!==false || engineLifecycle.keychainValidated!==false)throw new Error('Packaged host engine lifecycle check failed');
        fs.writeFileSync(path.join(output,`host-engine-bundle-${architecture}.json`),JSON.stringify({passed:true,architecture,pin:hostPin,verifiedFiles:Object.keys(manifest.files).length,nativeMinimumOS:manifest.nativeMinimumOS,signatureVerified:true,permissionCommands,stateConfiguration,engineLifecycle,scope:'Engine packaging and actual authenticated startup/stop lifecycle on disposable macOS CI with fixture encryption. Startup display/encoder probes may run; Keychain, permission requests, streaming, system input and user GUI acceptance are not exercised.'},null,2));
      }
      if(companionPin){
        const appDirectory=path.join(bundle,'ClipRelay.app','Contents','Resources','app','mac');
        const result=require('./mac/host-companion-artifact.cjs').verify(path.join(appDirectory,'host-companion'),companionPin);
        if(JSON.stringify(JSON.parse(fs.readFileSync(path.join(appDirectory,'host-companion-pin.json'),'utf8')))!==JSON.stringify(companionPin))throw new Error('Packaged host companion pin changed');
        const session=JSON.parse(execFileSync(process.execPath,[path.join(repo,'scripts','test_macos_host_session.cjs'),appDirectory],{encoding:'utf8',timeout:240000,maxBuffer:65536}));
        if(session.passed!==true || session.actualChildStarts!==8 || session.ownedChildrenReaped!==true || session.runtimeDirectoriesRemoved!==true ||
            session.stateFilesPrivate!==true || session.defaultStateUnchanged!==true || session.homeChanged!==false || session.nativeWorkers!==false ||
            session.keychainValidated!==false || session.nativeRequestsExecuted!==false || session.streamStarted!==false || session.systemInputInjected!==false)throw new Error('Packaged host session check failed');
        let files;
        if(result.manifest.fileTransfer===1){
          const reportPath=path.join(output,`host-files-${architecture}.json`);
          execFileSync('python3',[path.join(repo,'scripts','test_host_companion.py'),path.join(appDirectory,'host-companion','runtime','cliprelay-host-network'),
            '--app-directory',appDirectory,'--report',reportPath],{stdio:'inherit',timeout:240000});
          files=JSON.parse(fs.readFileSync(reportPath,'utf8'));
          const clipboardCases=result.manifest.clipboardExchange===1?['tls-clipboard-text-image-and-idempotence','tls-clipboard-owner-and-live-revocation',
            'clipboard-worker-crash-recovery','clipboard-eof-joins-worker','clipboard-parent-loss-with-writer-held','clipboard-owner-admission','tls-clipboard-desktop-client']:[];
          const terminalCases=result.manifest.terminalControl===1?['tls-terminal-shells-sessions-and-lost-replies','tls-terminal-native-mouse-lease-and-resize',
            'tls-terminal-desktop-client','tls-terminal-android-protocol','tls-terminal-owner-isolation-and-live-revocation','tls-terminal-output-gap-and-worker-restart','terminal-eof-reaps-owned-sessions']:[];
          const expected=[...terminalCases,...clipboardCases,'tls-files-desktop-resume-and-no-overwrite','tls-files-owner-and-live-revocation','files-eof-joins-worker','files-parent-loss-with-writer-held','files-owner-admission'];
          if(files.fileTransfer!==1 || files.passed!==17+clipboardCases.length+terminalCases.length || (clipboardCases.length && files.clipboardExchange!==1) ||
              (terminalCases.length && files.terminalControl!==1) || JSON.stringify(files.cases.slice(0,expected.length))!==JSON.stringify(expected) ||
              files.executableSha256!==result.manifest.files['runtime/cliprelay-host-network'])throw new Error('Packaged Mac file acceptance failed');
        }
        fs.writeFileSync(path.join(output,`host-companion-bundle-${architecture}.json`),JSON.stringify({passed:true,architecture,pin:companionPin,
          verifiedFiles:Object.keys(result.manifest.files).length,nativeMinimumOS:result.nativeMinimumOS,session,...(files?{files}:{})},null,2));
        // Includes three independent production two-minute expiry checks.
        const pairing=JSON.parse(execFileSync(process.execPath,[path.join(repo,'scripts','test_macos_host_pairing.cjs'),appDirectory],{encoding:'utf8',timeout:480000,maxBuffer:65536}));
        if(pairing.passed!==true || pairing.actualChildStarts!==4 || pairing.realNativePairing!==true || pairing.pairedClientPersisted!==true ||
            pairing.remoteRejectionFeedback!==true || pairing.remoteExpiryFeedback!==true || !(pairing.rejectionFeedbackMs<5000) || !(pairing.expiryWaitMs>=110000 && pairing.expiryWaitMs<130000) ||
            pairing.pendingNativeResponsesReleased!==true || !(pairing.pendingNativeBeforeStop>=1 && pairing.pendingNativeBeforeStop<=2) ||
            pairing.nativeCleanup?.passed!==true || pairing.nativeCleanup.cases.length!==3 ||
            pairing.nativeCleanup.freshNativeIdentityOnNonceReuse!==true || pairing.nativeCleanup.staleReceiptRefused!==true ||
            pairing.nativeCleanup.ownerCloseCompletedNativeResponse!==true ||
            pairing.nativeCleanup.autonomousExpiry?.passed!==true || pairing.nativeCleanup.autonomousExpiry.nativeExpiryStatus!==408 ||
            pairing.nativeCleanup.autonomousExpiry.lateNativeStatus!==403 || pairing.nativeCleanup.autonomousExpiry.noPairingAPITrafficDuringWait!==true ||
            pairing.nativeCleanup.autonomousExpiry.engineUnchanged!==true || pairing.nativeCleanup.autonomousExpiry.trustUnchanged!==true ||
            pairing.unauthorizedClientRefused!==true || pairing.ownedChildrenReaped!==true || pairing.defaultStateUnchanged!==true ||
            pairing.nativeWorkers!==false || pairing.keychainValidated!==false || pairing.nativeRequestsExecuted!==false || pairing.streamStarted!==false || pairing.systemInputInjected!==false)throw new Error('Packaged host approval and pairing check failed');
        fs.writeFileSync(path.join(output,`host-pairing-bundle-${architecture}.json`),JSON.stringify({passed:true,architecture,pairing},null,2));
        const clients=JSON.parse(execFileSync(process.execPath,[path.join(repo,'scripts','test_macos_host_clients.cjs'),appDirectory],{encoding:'utf8',timeout:240000,maxBuffer:65536}));
        if(clients.passed!==true || clients.actualChildStarts!==4 || clients.realClientPairings!==3 || clients.revokePreservesOtherClient!==true ||
            clients.reusedTLSRefused!==true || clients.newTLSRefused!==true || clients.revocationPersisted!==true || clients.newPairingRequired!==true || clients.lostReplyConfirmed!==true ||
            clients.ownedChildrenReaped!==true || clients.defaultStateUnchanged!==true || clients.nativeWorkers!==false || clients.keychainValidated!==false ||
            clients.nativeRequestsExecuted!==false || clients.streamStarted!==false || clients.systemInputInjected!==false)throw new Error('Packaged host client management check failed');
        fs.writeFileSync(path.join(output,`host-clients-bundle-${architecture}.json`),JSON.stringify({passed:true,architecture,clients},null,2));
        const background=JSON.parse(execFileSync(process.execPath,[path.join(repo,'scripts','test_macos_host_background.cjs'),appDirectory],{encoding:'utf8',timeout:180000,maxBuffer:65536}));
        if(background.passed!==true || background.actualChildStarts!==2 || background.observedNoticeEvents!==2 || background.backgroundRequestsObserved!==true ||
            background.requestNotificationsDeduplicated!==true || background.startupOptInPersisted!==true || background.defaultStartupOff!==true || background.optOutReopenStopped!==true ||
            background.ownedChildrenReaped!==true || background.defaultStateUnchanged!==true || background.nativeWorkers!==false || background.keychainValidated!==false ||
            background.nativeRequestsExecuted!==false || background.nativeNotificationsDisplayed!==false || background.guiValidated!==false || background.streamStarted!==false || background.systemInputInjected!==false)throw new Error('Packaged host background and opt-in check failed');
        fs.writeFileSync(path.join(output,`host-background-bundle-${architecture}.json`),JSON.stringify({passed:true,architecture,background},null,2));
      }
      if(process.env.CLIPRELAY_NETWORK_HELPER_ARTIFACT){
        const packaged=path.join(bundle,'ClipRelay.app','Contents','Resources','app','mac','network-helper');
        const manifest=require('./network-artifact.cjs').verify(packaged,'darwin');
        const architectures=execFileSync('/usr/bin/lipo',['-archs',path.join(packaged,'runtime','cliprelay-client-network')],{encoding:'utf8'}).trim().split(/\s+/);
        if(!architectures.includes('x86_64') || !architectures.includes('arm64'))throw new Error('Expected universal desktop network helper');
        fs.writeFileSync(path.join(output,`network-bundle-${architecture}.json`),JSON.stringify({passed:true,architecture,networkArchitectures:architectures,verifiedFiles:Object.keys(manifest.files).length,networkSha256:manifest.files['runtime/cliprelay-client-network']},null,2));
      }
      if(process.env.CLIPRELAY_VIEWER_ARTIFACT){
        const packaged=path.join(bundle,'ClipRelay.app','Contents','Resources','app','mac','stream-viewer');
        const executable=require('./mac/stream-viewer.cjs').executable(packaged,'darwin');
        const manifest=JSON.parse(fs.readFileSync(path.join(packaged,'manifest.json'),'utf8'));
        for(const [name,expected] of Object.entries(manifest.files)){
          if(crypto.createHash('sha256').update(fs.readFileSync(path.join(packaged,name))).digest('hex')!==expected)throw new Error('Packaged viewer file changed: '+name);
        }
        const architectures=execFileSync('/usr/bin/lipo',['-archs',executable],{encoding:'utf8'}).trim().split(/\s+/);
        if(!architectures.includes('x86_64') || !architectures.includes('arm64'))throw new Error('Expected universal desktop viewer');
        const sourceArtifact=path.resolve(process.env.CLIPRELAY_VIEWER_ARTIFACT),links=[];
        function collectLinks(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const item=path.join(directory,entry.name),relative=path.relative(sourceArtifact,item);if(entry.isSymbolicLink())links.push({item,copied:path.join(packaged,relative),target:fs.readlinkSync(item)});else if(entry.isDirectory())collectLinks(item);}}
        collectLinks(sourceArtifact);
        // fs-extra may convert preserved links to absolute source paths. Restore
        // the original relative graph before the temporary source is removed.
        for(const link of links){
          if(path.isAbsolute(link.target) || !path.resolve(path.dirname(link.item),link.target).startsWith(sourceArtifact+path.sep) || !fs.lstatSync(link.copied).isSymbolicLink())throw new Error('Invalid viewer framework link');
          if(fs.readlinkSync(link.copied)!==link.target){fs.unlinkSync(link.copied);fs.symlinkSync(link.target,link.copied);}
        }
        for(const link of links){if(fs.readlinkSync(link.copied)!==link.target || !fs.realpathSync(link.copied).startsWith(packaged+path.sep))throw new Error('Viewer framework link escapes the packaged runtime');}
        fs.writeFileSync(path.join(output,`viewer-bundle-${architecture}.json`),JSON.stringify({passed:true,architecture,viewerArchitectures:architectures,verifiedFiles:Object.keys(manifest.files).length,verifiedSymlinks:links.length,viewerSha256:manifest.files['runtime/ClipRelayStream.app/Contents/MacOS/Moonlight']},null,2));
      }
      if(hostPin && companionPin && process.env.CLIPRELAY_VIEWER_ARTIFACT && process.env.CI==='true' && process.env.GITHUB_ACTIONS==='true'){
        const appDirectory=path.join(bundle,'ClipRelay.app','Contents','Resources','app','mac');
        const reportPath=path.join(output,`native-stream-bundle-${architecture}.json`);
        const env={...process.env,APP_SOURCE_COMMIT:process.env.GITHUB_SHA};
        delete env.CLIPRELAY_MAC_STREAM_DEBUG;
        delete env.CLIPRELAY_DIAGNOSTIC_VIEWER;
        delete env.DIAGNOSTIC_VIEWER_COMMIT;
        delete env.CLIPRELAY_MAC_STREAM_ACTIVATE;
        delete env.CLIPRELAY_MAC_STREAM_H264;
        execFileSync(process.execPath,[path.join(repo,'scripts','test_macos_host_stream.cjs'),appDirectory,reportPath],{env,stdio:'inherit',timeout:240000});
        const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
        const expected=['packaged-Mac-capture-encode-encrypted-transport-and-Qt-present',
          'production-input-ACK-pause-display-reconstruction-and-fresh-frame-resume','desktop-owner-EOF-releases-native-stream',
          'native-host-termination-after-revocation-without-client-control-polling',
          'other-paired-client-still-renders-and-EOF-releases-stream','all-owned-native-processes-reaped-and-default-state-preserved'];
        if(report.protocol!==1 || report.passed!==true || report.diagnosticOnly!==false || report.architecture!==architecture ||
          report.applicationCommit!==process.env.GITHUB_SHA || JSON.stringify(report.cases)!==JSON.stringify(expected) ||
          report.ownedChildrenReaped!==true || report.revocation?.ownerPipeStayedOpen!==true)
          throw new Error('Packaged native Mac streaming acceptance did not complete');
      }
      const zip=path.join(output,`ClipRelay-macOS-${architecture}-${version.versionName}.zip`);execFileSync('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',path.join(bundle,'ClipRelay.app'),zip]);console.log(zip);
    }
  }finally{
    const resolved=path.resolve(staging);const temp=path.resolve(os.tmpdir())+path.sep;
    if(!resolved.startsWith(temp)||!path.basename(resolved).startsWith('cliprelay-electron-mac-'))throw new Error('Unexpected staging path');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}
build().catch(error=>{console.error(error.message);process.exitCode=1;});
