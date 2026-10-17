"""Build pinned iOS development applications; pairing integration is not yet complete."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import subprocess
import tarfile

ROOT=Path(__file__).resolve().parents[1]

def build(sdk):
    assert platform.system()=='Darwin' and os.environ.get('GITHUB_ACTIONS')=='true'
    assert os.environ.get('GITHUB_REPOSITORY')=='ffffhx/cliprelay'
    source=ROOT/'ios-source';pin=json.loads((ROOT/'ios-app/upstream.json').read_bytes())
    assert source.resolve(strict=True)==source and sdk in ['iphonesimulator','iphoneos']
    def git(*args,cwd=source):
        return subprocess.check_output(['git',*args],cwd=cwd).decode().rstrip('\r\n')
    assert git('rev-parse','HEAD')==pin['commit']
    assert git('status','--porcelain','--untracked-files=no')==''
    assert json.loads((ROOT/'engine/desktop-client/upstream.json').read_bytes())['commonCommit']==pin['commonCommit']
    modules={}
    for line in git('submodule','status','--recursive').splitlines():
        assert line.startswith(' '),'Submodule is missing or does not match the selected parent'
        fields=line[1:].split();modules[fields[1]]=fields[0]
    for name,commit in pin['submodules'].items():
        assert modules.get(name)==commit and git('rev-parse','HEAD',cwd=source/name)==commit
    app_info=source/'Limelight/Limelight-Info.plist'
    original=app_info.read_bytes();info=plistlib.loads(original)
    info['CFBundleDisplayName']='ClipRelay'
    info['CFBundleIdentifier']=pin['bundleIdentifier']
    app_info.write_bytes(plistlib.dumps(info,sort_keys=False))
    runner=Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    derived=runner/('cliprelay-ios-derived-'+sdk);assert not derived.exists()
    output=ROOT/'.tools'/('ios-client-'+sdk);output.mkdir(parents=True,exist_ok=False)
    receipt={'protocol':1,'passed':False,'developmentOnly':True,'clipRelayPairingIntegrated':False,
             'streamingAccepted':False,'physicalDeviceAccepted':False,'signedForDevice':False,
             'testCommit':os.environ['GITHUB_SHA'],'upstreamCommit':pin['commit'],'commonCommit':pin['commonCommit'],
             'sdk':sdk,'submodules':modules,'sourceHashes':{},'scope':'Pinned native build foundation; no ClipRelay pairing, installed device or stream acceptance.'}
    try:
        for name in ['ios-app/upstream.json','scripts/build_ios_client.py','.github/workflows/ios-client.yml']:
            receipt['sourceHashes'][name]=hashlib.sha256((ROOT/name).read_bytes()).hexdigest()
        receipt['plistOverlay']={'upstreamSha256':hashlib.sha256(original).hexdigest(),
                                 'patchedSha256':hashlib.sha256(app_info.read_bytes()).hexdigest()}
        receipt['xcode']=subprocess.check_output(['xcodebuild','-version'],text=True).strip()
        command=['xcodebuild','-project',str(source/'Moonlight.xcodeproj'),'-scheme','Moonlight',
                 '-configuration','Release','-sdk',sdk,'-destination',
                 'generic/platform=iOS Simulator' if sdk=='iphonesimulator' else 'generic/platform=iOS',
                 '-derivedDataPath',str(derived),'CODE_SIGNING_ALLOWED=NO','CODE_SIGNING_REQUIRED=NO',
                 'DEVELOPMENT_TEAM=','build']
        with (output/'build.log').open('wb') as log:
            subprocess.run(command,cwd=source,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=1200)
        app=derived/'Build/Products'/('Release-'+sdk)/'Moonlight.app'
        metadata=plistlib.loads((app/'Info.plist').read_bytes())
        assert metadata['CFBundleIdentifier']==pin['bundleIdentifier'] and metadata['CFBundleDisplayName']=='ClipRelay'
        executable=app/metadata['CFBundleExecutable'];assert executable.is_file()
        receipt['architectures']=subprocess.check_output(['lipo','-archs',str(executable)],text=True).strip().split()
        assert receipt['architectures'] and set(receipt['architectures'])<=({'arm64'} if sdk=='iphoneos' else {'arm64','x86_64'})
        receipt['executableSha256']=hashlib.sha256(executable.read_bytes()).hexdigest()
        receipt['bundleIdentifier']=metadata['CFBundleIdentifier'];receipt['minimumOS']=metadata['MinimumOSVersion']
        archive=output/('ClipRelay-iOS-development-'+sdk+'.zip')
        subprocess.run(['ditto','-c','-k','--sequesterRsrc','--keepParent',str(app),str(archive)],check=True)
        receipt['archiveSha256']=hashlib.sha256(archive.read_bytes()).hexdigest()
        # Archive the complete pinned source including upstream licenses and the
        # exact Info.plist overlay. This is a development artifact, not a release.
        with tarfile.open(output/'ios-source.tar.gz','w:gz') as archive_source:
            def included(item):return None if '.git' in Path(item.name).parts else item
            archive_source.add(source,arcname='ios-source',filter=included)
        receipt['passed']=True
    except Exception as error:
        receipt['failure']=type(error).__name__
        raise
    finally:
        (output/'build-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'passed':True,'sdk':sdk,'architectures':receipt['architectures'],'developmentOnly':True}))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sdk',required=True,choices=['iphonesimulator','iphoneos'])
    build(parser.parse_args().sdk)
