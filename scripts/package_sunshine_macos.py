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
import struct
import subprocess
import sys
import xml.etree.ElementTree as ET


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def inside(path, root):
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root):
        raise RuntimeError(f'Artifact reference escapes bundle: {path}')
    return resolved


def minimum_macos(data):
    """Read the loader's deployment requirement, not the compiler invocation."""
    if len(data) < 32 or data[:4] != b'\xcf\xfa\xed\xfe':
        raise RuntimeError('Expected a 64-bit little-endian Mach-O image')
    count, size = struct.unpack_from('<II', data, 16)
    position, versions = 32, []
    if position + size > len(data):
        raise RuntimeError('Invalid Mach-O load command bounds')
    for _ in range(count):
        if position + 8 > 32 + size:
            raise RuntimeError('Truncated Mach-O load command')
        command, length = struct.unpack_from('<II', data, position)
        if length < 8 or position + length > 32 + size:
            raise RuntimeError('Invalid Mach-O load command size')
        if command == 0x32:  # LC_BUILD_VERSION
            if length < 24 or struct.unpack_from('<I', data, position+8)[0] != 1:
                raise RuntimeError('Expected a macOS build-version command')
            versions.append(struct.unpack_from('<I', data, position+12)[0])
        elif command == 0x24:  # LC_VERSION_MIN_MACOSX
            if length < 16:
                raise RuntimeError('Truncated minimum-version command')
            versions.append(struct.unpack_from('<I', data, position+8)[0])
        position += length
    if position != 32 + size or len(versions) != 1:
        raise RuntimeError('Expected one macOS deployment requirement')
    value = versions[0]
    return (value >> 16, (value >> 8) & 255, value & 255)


def check_deployment(data, target):
    actual = minimum_macos(data)
    if actual > target:
        raise RuntimeError(f'Native dependency requires macOS {actual}; target is {target}')
    return '.'.join(map(str, actual))


def package(source, build, artifact, arch, test_results, dependencies, build_log, capture_results):
    if platform.system() != 'Darwin' or platform.machine() != arch:
        raise RuntimeError('Package verification requires the matching native macOS runner')
    root = Path(__file__).resolve().parents[1]
    source, build, artifact = (p.resolve(strict=True) for p in (source, build, artifact))
    pinned = json.loads((root / 'engine/sunshine/upstream.json').read_text())
    dependency_pins = json.loads((root / 'engine/sunshine/macos-dependencies.json').read_text())
    deployment_target = tuple(map(int, dependency_pins['deploymentTarget'].split('.'))) + (0,)
    if 'built for newer' in build_log.read_text(errors='replace'):
        raise RuntimeError('Linker found an object or library newer than the deployment target')
    if command('git', '-C', str(source), 'rev-parse', 'HEAD') != pinned['commit']:
        raise RuntimeError('Unexpected upstream source revision')
    suites = ET.parse(test_results).getroot()
    cases = suites.findall('.//testcase')
    expected_cases = []
    for suite, filename in [('ClipRelayInputTest', 'input_integration_test.cpp'),
                            ('ClipRelayMacMouseTest', 'macos_mouse_test.cpp'),
                            ('ClipRelayMacCaptureTest', 'macos_capture_test.mm'),
                            ('ClipRelayMacOwnerTest', 'macos_owner_test.cpp')]:
        expected_cases.extend((suite, name) for name in re.findall(r'TEST_F\('+suite+r',\s*(\w+)\)',
                              (root / 'engine/sunshine' / filename).read_text()))
    expected = [name for _, name in expected_cases]
    if (sorted((case.attrib['classname'], case.attrib['name']) for case in cases) != sorted(expected_cases)
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

    # Give the permission helper its ClipRelay bundle identity before signing.
    # The enclosing application's permission attribution still needs native QA.
    plist.update({
        'CFBundleIdentifier': 'com.cliprelay.host-engine',
        'CFBundleName': 'ClipRelay Host', 'CFBundleDisplayName': 'ClipRelay Host',
        'LSMinimumSystemVersion': '14.2',
        'NSMicrophoneUsageDescription': "ClipRelay needs microphone access to forward microphone audio to a paired device.",
        'NSAudioCaptureUsageDescription': "ClipRelay needs system audio access to stream this Mac's sound to a paired device.",
    })
    (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(plist))

    # install_name_tool changes signatures while upstream bundles dylibs. Use
    # an ad-hoc signature for this internal build, not a distribution identity.
    subprocess.run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', str(app)], check=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    subprocess.run([sys.executable, str(root / 'scripts/test_sunshine_macos_permissions.py'),
                    '--engine', str(binary), '--report', str(artifact / 'permission-tests.json')], check=True)
    subprocess.run([sys.executable, str(root / 'scripts/test_sunshine_macos_state.py'),
                    '--engine', str(binary), '--report', str(artifact / 'state-tests.json')], check=True)
    subprocess.run([sys.executable, str(root / 'scripts/test_sunshine_macos_owner.py'),
                    '--engine', str(binary), '--report', str(artifact / 'owner-tests.json')], check=True)
    native, minimum_versions = {}, {}
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
        minimum_versions[path.relative_to(artifact).as_posix()] = check_deployment(path.read_bytes(), deployment_target)
        linked_libraries = []
        for line in command('/usr/bin/otool', '-L', str(path)).splitlines()[1:]:
            name = line.strip().split(' (compatibility version', 1)[0]
            if name.startswith(('/usr/lib/', '/System/Library/')):
                linked_libraries.append(name)
                continue
            if name.startswith('@executable_path/'):
                linked_path = binary.parent / name.removeprefix('@executable_path/')
            elif name.startswith('@loader_path/'):
                linked_path = path.parent / name.removeprefix('@loader_path/')
            else:
                # BundleUtilities rewrites dependencies to executable-relative
                # paths. Reject unresolved rpaths and build/Homebrew locations.
                raise RuntimeError(f'Non-relocatable native dependency: {path}: {name}')
            inside(linked_path, app)
            linked_libraries.append(name)
        native[path.relative_to(artifact).as_posix()] = linked_libraries
    if binary.relative_to(artifact).as_posix() not in native:
        raise RuntimeError('Missing executable from native dependency inventory')

    tracked = ['engine/sunshine/' + name for name in [
        'upstream.json', 'control.patch', 'cliprelay_control.h', 'cliprelay_audio.h',
        'cliprelay_input.h', 'control_test.cpp', 'input_test.cpp', 'input_integration_test.cpp', 'README.md',
        'macos-control.patch', 'macos-capture.patch', 'libvirtualhid-macos.patch', 'cliprelay_macos.h', 'macos_mouse_test.cpp',
        'cliprelay_capture.h', 'macos_capture_test.mm', 'cliprelay_permissions.h', 'permissions_test.cpp',
        'cliprelay_state.h', 'state_test.cpp', 'cliprelay_owner.h', 'owner_test.cpp', 'macos_owner_test.cpp']]
    tracked += ['engine/sunshine/macos-dependencies.json', 'scripts/prepare_sunshine.py',
                'scripts/package_sunshine_macos.py', 'scripts/build_sunshine_macos_dependencies.py',
                '.github/workflows/sunshine-macos.yml', 'scripts/test_sunshine_macos_permissions.py', 'scripts/test_sunshine_macos_state.py', 'scripts/test_sunshine_macos_owner.py',
                'scripts/test_macos_capture.py', 'scripts/test_macos_capture.mm']
    source_hashes = {}
    for name in tracked:
        dest = artifact / 'source' / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / name, dest)
        source_hashes[name] = hashlib.sha256(dest.read_bytes()).hexdigest()
    from test_macos_capture import CASES
    capture = json.loads(capture_results.read_text())
    capture_sources = ['engine/sunshine/' + name for name in ['control.patch', 'macos-control.patch', 'macos-capture.patch']]
    capture_sources += ['scripts/test_macos_capture.py', 'scripts/test_macos_capture.mm']
    if (capture.get('protocol') != 1 or capture.get('passed') is not True or capture.get('architecture') != arch
            or capture.get('sourceCommit') != command('git', '-C', str(root), 'rev-parse', 'HEAD')
            or capture.get('upstreamCommit') != pinned['commit'] or capture.get('cases') != CASES
            or capture.get('sourceHashes') != {name: source_hashes[name] for name in capture_sources}
            or not re.fullmatch('[a-f0-9]{64}', capture.get('binarySha256', ''))):
        raise RuntimeError('Native capture evidence does not match the packaged source')
    shutil.copyfile(capture_results, artifact / 'capture-tests.json')
    shutil.copyfile(source / 'LICENSE', artifact / 'SUNSHINE-LICENSE')
    shutil.copyfile(source / 'third-party/libvirtualhid/LICENSE.md', artifact / 'LIBVIRTUALHID-LICENSE')
    shutil.copyfile(test_results, artifact / 'input-tests.xml')
    dependency_receipt = json.loads((dependencies / 'build.json').read_text())
    if (dependency_receipt['identity']['arch'] != arch
            or dependency_receipt['identity']['deploymentTarget'] != dependency_pins['deploymentTarget']
            or dependency_receipt['sources'] != dependency_pins['sources']):
        raise RuntimeError('Native dependency build does not match the pinned inputs')
    notices = artifact / 'dependency-licenses'
    shutil.copytree(dependencies / 'licenses', notices)
    shutil.copyfile(dependencies / 'build.json', artifact / 'dependency-build.json')
    manifest = {
        'protocol': 1, 'platform': 'darwin', 'arch': arch,
        'sourceCommit': command('git', '-C', str(root), 'rev-parse', 'HEAD'),
        'upstreamCommit': pinned['commit'],
        'libvirtualhidCommit': command('git', '-C', str(source / 'third-party/libvirtualhid'), 'rev-parse', 'HEAD'),
        'buildDependenciesCommit': command('git', '-C', str(source / 'third-party/build-deps'), 'rev-parse', 'HEAD'),
        'buildDependenciesTag': command('git', '-C', str(source / 'third-party/build-deps'), 'describe', '--tags', '--exact-match'),
        'executable': binary.relative_to(artifact).as_posix(), 'sourceHashes': source_hashes,
        'inputTests': expected, 'nativeDependencies': native,
        'deploymentTarget': dependency_pins['deploymentTarget'], 'nativeMinimumOS': minimum_versions,
        'signature': 'ad-hoc', 'notarized': False,
        'permissionCommand': 1,
        'stateCommand': 1,
        'ownerCommand': 1,
        'captureBackend': 'screencapturekit',
        'captureTests': CASES,
        'bundleIdentifier': plist['CFBundleIdentifier'],
        'scope': 'Internal engine build with fixture-owned native capture and exclusion checks. No installed privacy lease, host UI, permission grant, encoded client or hardware streaming acceptance.',
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
    for option in ['source', 'build', 'artifact', 'test-results', 'dependencies', 'build-log', 'capture-results']:
        parser.add_argument('--' + option, type=Path, required=True)
    parser.add_argument('--arch', choices=['arm64', 'x86_64'], required=True)
    args = parser.parse_args()
    package(args.source, args.build, args.artifact, args.arch, args.test_results, args.dependencies, args.build_log, args.capture_results)
