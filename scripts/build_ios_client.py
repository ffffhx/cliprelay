"""Build the integrated iOS client. Compilation never implies device acceptance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import subprocess
import tarfile
import tempfile

from prepare_ios_client import ROOT, prepare


def build(sdk, source, output=None):
    if platform.system() != 'Darwin':
        raise RuntimeError('Building iOS requires macOS and Xcode; use the iOS CI workflow on other systems')
    source = source.resolve()
    prepared = prepare(source)
    output = (output or ROOT / '.tools' / ('ios-client-' + sdk)).resolve()
    output.mkdir(parents=True, exist_ok=False)
    pin = json.loads((ROOT/'ios-app/upstream.json').read_bytes())
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    receipt = {'protocol': 2, 'passed': False, 'developmentOnly': True,
               'clipRelayPairingIntegrated': True, 'streamingAccepted': False,
               'physicalDeviceAccepted': False, 'signedForDevice': False,
               'testCommit': commit, 'upstreamCommit': pin['commit'], 'commonCommit': pin['commonCommit'],
               'sdk': sdk, 'submodules': prepared['submodules'], 'sourceHashes': prepared['inputs'],
               'scope': 'Integrated iOS native compilation only. Pairing UI, streaming, audio, touch, clipboard and device signing require later device validation.'}
    try:
        receipt['xcode'] = subprocess.check_output(['xcodebuild', '-version'], text=True).strip()
        with tempfile.TemporaryDirectory(prefix='cliprelay-ios-derived-', dir=os.environ.get('RUNNER_TEMP')) as temporary:
            derived = Path(temporary)
            command = ['xcodebuild', '-project', str(source/'Moonlight.xcodeproj'), '-scheme', 'Moonlight',
                       '-configuration', 'Release', '-sdk', sdk, '-destination',
                       'generic/platform=iOS Simulator' if sdk == 'iphonesimulator' else 'generic/platform=iOS',
                       '-derivedDataPath', str(derived), 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO',
                       'DEVELOPMENT_TEAM=', 'build']
            with (output/'build.log').open('wb') as log:
                subprocess.run(command, cwd=source, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=1800)
            app = derived/'Build/Products'/('Release-' + sdk)/'Moonlight.app'
            metadata = plistlib.loads((app/'Info.plist').read_bytes())
            if metadata['CFBundleIdentifier'] != pin['bundleIdentifier'] or metadata['CFBundleDisplayName'] != 'ClipRelay':
                raise RuntimeError('Built application identity mismatch')
            executable = app/metadata['CFBundleExecutable']
            receipt['architectures'] = subprocess.check_output(['lipo', '-archs', str(executable)], text=True).strip().split()
            if not receipt['architectures'] or not set(receipt['architectures']) <= ({'arm64'} if sdk == 'iphoneos' else {'arm64', 'x86_64'}):
                raise RuntimeError('Unexpected application architecture')
            receipt['executableSha256'] = hashlib.sha256(executable.read_bytes()).hexdigest()
            receipt['bundleIdentifier'] = metadata['CFBundleIdentifier']; receipt['minimumOS'] = metadata['MinimumOSVersion']
            archive = output/('ClipRelay-iOS-development-' + sdk + '.zip')
            subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(archive)], check=True)
            receipt['archiveSha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
        with tarfile.open(output/'ios-source.tar.gz', 'w:gz') as archive:
            def included(item):
                return None if '.git' in Path(item.name).parts else item
            archive.add(source, arcname='ios-source', filter=included)
        (output/'prepared-source.json').write_text(json.dumps(prepared, indent=2) + '\n', encoding='utf-8')
        receipt['passed'] = True
    except Exception as error:
        receipt['failure'] = type(error).__name__
        raise
    finally:
        (output/'build-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'passed': True, 'sdk': sdk, 'architectures': receipt['architectures'], 'physicalDeviceAccepted': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sdk', required=True, choices=['iphonesimulator', 'iphoneos'])
    parser.add_argument('--source', type=Path, default=ROOT/'ios-source')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    build(args.sdk, args.source, args.output)
