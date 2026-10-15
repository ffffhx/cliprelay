"""Build and package the patched pinned viewer on an isolated build runner."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

def build(source, platform):
    source=source.resolve(strict=True)
    extension=Path(__file__).resolve().parents[1]/'engine/desktop-client'
    if (source/'build').exists() or (source/'cliprelay-artifact').exists():
        raise RuntimeError('Build requires a fresh output directory')
    def run(args, cwd=source): subprocess.run(args,cwd=cwd,check=True)
    if platform=='windows':
        # Upstream's build-arch packages the exact Qt/codec DLLs, controller DB,
        # AntiHooking and VC runtime. Skip the unrelated Moonlight MSI only.
        script=source/'scripts/build-arch.bat'
        content=script.read_text()
        start=content.index('echo Building MSI\n')
        end=content.index('echo Copying application binary',start)
        script.write_text(content[:start]+content[end:])
        run([os.environ['SystemRoot']+r'\System32\WindowsPowerShell\v1.0\powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(source/'setup-deps.ps1')])
        run(['cmd.exe','/d','/c','scripts\\build-arch.bat','Release','x64'])
        runtime=source/'build/deploy-x64-release'
        (runtime/'Moonlight.exe').rename(runtime/'ClipRelayStream.exe')
        for name in ['portable.dat','portable.dat.inactive']:
            if (runtime/name).exists(): (runtime/name).unlink()
    else:
        run(['python3','setup-deps.py'])
        builddir=source/'build/client';builddir.mkdir(parents=True)
        run(['qmake',str(source/'moonlight-qt.pro'),'QMAKE_APPLE_DEVICE_ARCHS=x86_64 arm64'],builddir)
        run(['make','-j4','release'],builddir)
        bundle=builddir/'app/Moonlight.app'
        run(['macdeployqt',str(bundle),'-qmldir='+str(source/'app/gui'),'-appstore-compliant'])
        runtime=source/'build/runtime';runtime.mkdir()
        shutil.copytree(bundle,runtime/'ClipRelayStream.app',symlinks=True)
    artifact=source/'cliprelay-artifact';artifact.mkdir()
    shutil.copytree(runtime,artifact/'runtime',symlinks=True)
    for name in ['LICENSE','upstream.json','README.md','desktop-client.patch','desktop-common.patch','portmap.h','sessionimport.h','sessionimport.cpp']:
        shutil.copyfile(extension/name,artifact/name)
    # Corresponding source includes pinned submodules and the applied extension.
    # SDK binaries and generated objects are excluded; their dependency release
    # and build scripts remain in the source, as in upstream distributions.
    with tarfile.open(artifact/'corresponding-source.tar.gz','w:gz') as archive:
        for item in sorted(source.iterdir()):
            if item.name in {'.git','build','libs','cliprelay-artifact'}: continue
            archive.add(item,arcname='moonlight-qt/'+item.name,filter=lambda info: None if '/.git/' in info.name or info.name.endswith('/.git') else info)
        archive.add(extension,arcname='cliprelay-extension')
        for name in ['build_desktop_client.py','prepare_desktop_client.py','test_desktop_input.py']:
            archive.add(Path(__file__).with_name(name),arcname='scripts/'+name)
    hashes={str(p.relative_to(artifact)).replace('\\','/'):hashlib.sha256(p.read_bytes()).hexdigest() for p in artifact.rglob('*') if p.is_file() and not p.is_symlink()}
    (artifact/'manifest.json').write_text(json.dumps({'platform':platform,'protocol':1,'capabilities':['direct','embedded-network','session-events-v1','presentation-events-v1'],'files':hashes},indent=2)+'\n')
    if platform=='macos':
        # GitHub artifact transport discards executable bits and symlink types.
        # A tar container preserves both for the app and Qt frameworks.
        with tarfile.open(source/'ClipRelay-Stream-macOS.tar.gz','w:gz') as archive:
            archive.add(artifact,arcname='ClipRelay-Stream-macOS')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('source',type=Path);parser.add_argument('platform',choices=['windows','macos'])
    args=parser.parse_args();build(args.source,args.platform)
