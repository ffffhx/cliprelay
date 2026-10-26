"""Prepare the pinned ClipRelay iOS project, without signing or touching a device."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PIN = ROOT / 'ios-app/upstream.json'


def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd).decode('utf-8').rstrip('\r\n')


def source_hashes():
    files = [*sorted((ROOT / 'ios-app').rglob('*')), ROOT / 'scripts/prepare_ios_client.py',
             ROOT / 'scripts/build_ios_client.py', ROOT / '.github/workflows/ios-client.yml']
    return {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in files if p.is_file() and '__pycache__' not in p.parts}


def wire_sources(project, names):
    text = project.read_text(encoding='utf-8')
    refs, builds, group, sources = [], [], [], []
    for name in names:
        reference = hashlib.sha256(('cliprelay-ios-file:' + name).encode()).hexdigest()[:24].upper()
        build = hashlib.sha256(('cliprelay-ios-build:' + name).encode()).hexdigest()[:24].upper()
        kind = 'sourcecode.c.objc' if name.endswith('.m') else 'sourcecode.c.h'
        refs.append(f'\t\t{reference} /* {name} */ = {{isa = PBXFileReference; lastKnownFileType = {kind}; path = {name}; sourceTree = "<group>"; }};\n')
        group.append(f'\t\t\t\t{reference} /* {name} */,\n')
        if name.endswith('.m'):
            builds.append(f'\t\t{build} /* {name} in Sources */ = {{isa = PBXBuildFile; fileRef = {reference} /* {name} */; }};\n')
            sources.append(f'\t\t\t\t{build} /* {name} in Sources */,\n')
    for anchor, addition in [
        ('/* Begin PBXFileReference section */\n', ''.join(refs)),
        ('/* Begin PBXBuildFile section */\n', ''.join(builds)),
        ('\t\t\t\tFB89461019F646E200339C8A /* HttpManager.m */,\n', ''.join(group)),
        ('\t\t\t\tFB89462C19F646E200339C8A /* HttpManager.m in Sources */,\n', ''.join(sources)),
    ]:
        if text.count(anchor) != 1:
            raise RuntimeError('Pinned Xcode project layout changed')
        text = text.replace(anchor, anchor + addition)
    text = text.replace('com.moonlight-stream.Moonlight', 'com.cliprelay.controller')
    project.write_text(text, encoding='utf-8', newline='\n')


def prepare(source, fetch=True):
    pin = json.loads(PIN.read_bytes())
    source = source.resolve()
    if not source.exists():
        if not fetch:
            raise RuntimeError('Source checkout is missing')
        source.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', 'clone', '--no-checkout', pin['repository'], str(source)], check=True)
        subprocess.run(['git', 'checkout', '--detach', pin['commit']], cwd=source, check=True)
    if run('git', 'rev-parse', 'HEAD', cwd=source) != pin['commit']:
        raise RuntimeError('Unexpected upstream revision; use a separate pinned checkout')
    if source == ROOT or source.is_symlink():
        raise RuntimeError('Use a separate upstream source directory')
    receipt_file = source / '.cliprelay-prepared.json'
    if receipt_file.exists():
        receipt = json.loads(receipt_file.read_bytes())
        if receipt['inputs'] != source_hashes():
            raise RuntimeError('Integration inputs changed; prepare a new source checkout')
        for name, digest in receipt['files'].items():
            if hashlib.sha256((source / name).read_bytes()).hexdigest() != digest:
                raise RuntimeError('Prepared source changed: ' + name)
        return receipt
    if run('git', 'status', '--porcelain', '--untracked-files=normal', cwd=source):
        raise RuntimeError('Upstream checkout is dirty; no files were overwritten')
    if fetch:
        subprocess.run(['git', 'submodule', 'update', '--init', '--recursive'], cwd=source, check=True)
    modules = {}
    for line in run('git', 'submodule', 'status', '--recursive', cwd=source).splitlines():
        if not line.startswith(' '):
            raise RuntimeError('A required submodule is missing or modified')
        commit, name, *_ = line.split()
        modules[name] = commit
    for name, commit in pin['submodules'].items():
        if modules.get(name) != commit:
            raise RuntimeError('Unexpected submodule revision: ' + name)
    if json.loads((ROOT/'engine/desktop-client/upstream.json').read_bytes())['commonCommit'] != pin['commonCommit']:
        raise RuntimeError('iOS and desktop protocol core pins differ')
    patch = ROOT / 'ios-app/upstream.patch'
    subprocess.run(['git', 'apply', '--check', str(patch)], cwd=source, check=True)
    subprocess.run(['git', 'apply', str(patch)], cwd=source, check=True)
    added = []
    for item in sorted((ROOT / 'ios-app/native').iterdir()):
        if item.suffix not in {'.h', '.m'}:
            continue
        target = source / 'Limelight/Network' / item.name
        if not target.exists():
            added.append(item.name)
        shutil.copyfile(item, target)
    wire_sources(source / 'Moonlight.xcodeproj/project.pbxproj', added)
    info_path = source / 'Limelight/Limelight-Info.plist'
    info = plistlib.loads(info_path.read_bytes())
    info.update(CFBundleDisplayName='ClipRelay', CFBundleIdentifier=pin['bundleIdentifier'],
                NSLocalNetworkUsageDescription='ClipRelay 在局域网中发现并连接你允许配对的电脑，用于远程桌面和剪贴板收发。',
                NSBluetoothAlwaysUsageDescription='ClipRelay 可连接蓝牙鼠标以操作远程电脑。',
                NSBluetoothPeripheralUsageDescription='ClipRelay 可连接蓝牙鼠标以操作远程电脑。')
    info_path.write_bytes(plistlib.dumps(info, sort_keys=False))
    tracked = run('git', 'ls-files', cwd=source).splitlines()
    names = set(tracked) | {f'Limelight/Network/{name}' for name in added}
    files = {name: hashlib.sha256((source/name).read_bytes()).hexdigest()
             for name in sorted(names) if (source/name).is_file()}
    receipt = {'protocol': 1, 'upstreamCommit': pin['commit'], 'submodules': modules,
               'inputs': source_hashes(), 'files': files, 'clipRelayPairingIntegrated': True}
    receipt_file.write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / '.tools/ios-source')
    parser.add_argument('--no-fetch', action='store_true')
    args = parser.parse_args()
    receipt = prepare(args.source, not args.no_fetch)
    print(json.dumps({'prepared': True, 'source': str(args.source.resolve()), 'files': len(receipt['files'])}))
