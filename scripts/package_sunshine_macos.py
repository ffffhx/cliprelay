"""Verify and record an internal macOS host engine artifact; does not launch capture."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def inside(path, root):
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root):
        raise RuntimeError(f'Artifact reference escapes bundle: {path}')
    return resolved


def package(source, build, artifact, arch, test_results):
    if platform.system() != 'Darwin' or platform.machine() != arch:
        raise RuntimeError('Package verification requires the matching native macOS runner')
    root = Path(__file__).resolve().parents[1]
    source, build, artifact = (p.resolve(strict=True) for p in (source, build, artifact))
    pinned = json.loads((root / 'engine/sunshine/upstream.json').read_text())
    if command('git', '-C', str(source), 'rev-parse', 'HEAD') != pinned['commit']:
        raise RuntimeError('Unexpected upstream source revision')
    suites = ET.parse(test_results).getroot()
    cases = suites.findall('.//testcase')
    expected = re.findall(r'TEST_F\(ClipRelayInputTest,\s*(\w+)\)',
                          (root / 'engine/sunshine/input_integration_test.cpp').read_text())
    if (sorted(case.attrib['name'] for case in cases) != sorted(expected)
            or any(case.find('failure') is not None or case.find('skipped') is not None
                   or case.attrib.get('status') != 'run' for case in cases)):
        raise RuntimeError('Input integration case inventory did not pass exactly')
    apps = list(artifact.glob('*.app'))
    if len(apps) != 1:
        raise RuntimeError('Expected exactly one installed engine application')
    app = apps[0]
    plist = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    executable = plist['CFBundleExecutable']
    if not re.fullmatch(r'[A-Za-z0-9._-]+', executable):
        raise RuntimeError('Unexpected bundle executable name')
    binary = inside(app / 'Contents/MacOS' / executable, app)
    assets = app / 'Contents/Resources/assets'
    # Runtime includes platform assets; the build tree contains the common and
    # generated web assets too. Merge them before signing the application.
    shutil.copytree(build / 'assets', assets, dirs_exist_ok=True)
    if not (assets / 'web/index.html').is_file() or not (assets / 'apps.json').is_file():
        raise RuntimeError('Incomplete engine assets')

    # install_name_tool changes signatures while upstream bundles dylibs. Use
    # an ad-hoc signature for this internal build, not a distribution identity.
    subprocess.run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', str(app)], check=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    native = {}
    for path in sorted(app.rglob('*')):
        if path.is_symlink():
            inside(path, app)
            continue
        if not path.is_file():
            continue
        with path.open('rb') as stream:
            magic = stream.read(4)
        if magic not in [b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xce\xfa\xed\xfe',
                         b'\xfe\xed\xfa\xce', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca',
                         b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca']:
            continue
        architectures = command('/usr/bin/lipo', '-archs', str(path)).split()
        if architectures != [arch]:
            raise RuntimeError(f'Unexpected native architectures: {path}: {architectures}')
        dependencies = []
        for line in command('/usr/bin/otool', '-L', str(path)).splitlines()[1:]:
            name = line.strip().split(' (compatibility version', 1)[0]
            if name.startswith(('/usr/lib/', '/System/Library/')):
                dependencies.append(name)
                continue
            if name.startswith('@executable_path/'):
                target = binary.parent / name.removeprefix('@executable_path/')
            elif name.startswith('@loader_path/'):
                target = path.parent / name.removeprefix('@loader_path/')
            else:
                # BundleUtilities rewrites dependencies to executable-relative
                # paths. Reject unresolved rpaths and build/Homebrew locations.
                raise RuntimeError(f'Non-relocatable native dependency: {path}: {name}')
            inside(target, app)
            dependencies.append(name)
        native[path.relative_to(artifact).as_posix()] = dependencies
    if binary.relative_to(artifact).as_posix() not in native:
        raise RuntimeError('Missing executable from native dependency inventory')

    tracked = ['engine/sunshine/' + name for name in [
        'upstream.json', 'control.patch', 'cliprelay_control.h', 'cliprelay_audio.h',
        'cliprelay_input.h', 'control_test.cpp', 'input_test.cpp', 'input_integration_test.cpp', 'README.md']]
    tracked += ['scripts/prepare_sunshine.py', 'scripts/package_sunshine_macos.py', '.github/workflows/sunshine-macos.yml']
    source_hashes = {}
    for name in tracked:
        dest = artifact / 'source' / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / name, dest)
        source_hashes[name] = hashlib.sha256(dest.read_bytes()).hexdigest()
    shutil.copyfile(source / 'LICENSE', artifact / 'SUNSHINE-LICENSE')
    shutil.copyfile(test_results, artifact / 'input-tests.xml')
    manifest = {
        'protocol': 1, 'platform': 'darwin', 'arch': arch,
        'sourceCommit': command('git', '-C', str(root), 'rev-parse', 'HEAD'),
        'upstreamCommit': pinned['commit'],
        'buildDependenciesCommit': command('git', '-C', str(source / 'third-party/build-deps'), 'rev-parse', 'HEAD'),
        'buildDependenciesTag': command('git', '-C', str(source / 'third-party/build-deps'), 'describe', '--tags', '--exact-match'),
        'executable': binary.relative_to(artifact).as_posix(), 'sourceHashes': source_hashes,
        'inputTests': expected, 'nativeDependencies': native,
        'signature': 'ad-hoc', 'notarized': False,
        'scope': 'Internal engine build only. No ClipRelay host UI, permission grant, capture, network listener or hardware streaming acceptance.',
        'files': {}, 'symlinks': {}
    }
    for path in sorted(artifact.rglob('*')):
        name = path.relative_to(artifact).as_posix()
        if path.is_symlink():
            inside(path, artifact)
            manifest['symlinks'][name] = os.readlink(path)
        elif path.is_file():
            manifest['files'][name] = hashlib.sha256(path.read_bytes()).hexdigest()
    (artifact / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'passed': True, 'arch': arch, 'nativeFiles': len(native), 'inputTests': len(cases), 'files': len(manifest['files'])}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ['source', 'build', 'artifact', 'test-results']:
        parser.add_argument('--' + option, type=Path, required=True)
    parser.add_argument('--arch', choices=['arm64', 'x86_64'], required=True)
    args = parser.parse_args()
    package(args.source, args.build, args.artifact, args.arch, args.test_results)
