"""Native CI pixel checks for the production ScreenCaptureKit capture overlay."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile

CASES = [
    'native-owned-mask-exclusion-and-source-isolation',
    'native-static-desktop-current-images',
    'native-mask-removal-restores-unfiltered-image',
    'native-NV12-P010-geometry',
]


def run(source, output):
    if platform.system() != 'Darwin' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('This fixture requires a disposable native macOS CI runner')
    root = Path(__file__).resolve().parents[1]
    source = source.resolve(strict=True)
    pin = json.loads((root / 'engine/sunshine/upstream.json').read_text())['commit']
    if subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() != pin:
        raise RuntimeError('Unexpected capture source revision')
    names = ['engine/sunshine/' + name for name in ['control.patch', 'macos-control.patch', 'macos-capture.patch']]
    names += ['scripts/test_macos_capture.mm', 'scripts/test_macos_capture.py']
    with tempfile.TemporaryDirectory(prefix='cliprelay-capture-') as temporary:
        stage = Path(temporary)
        subprocess.run(['git', 'init', '-q', str(stage)], check=True)
        native = stage / 'src/platform/macos'
        native.mkdir(parents=True)
        for name in ['av_video.h', 'av_video.m']:
            (native / name).write_bytes(subprocess.check_output(['git', '-C', str(source), 'show', f'{pin}:src/platform/macos/{name}']))
        for name in names[:3]:
            subprocess.run(['git', 'apply', '--include=src/platform/macos/av_video.h', '--include=src/platform/macos/av_video.m', '-'],
                           cwd=stage, input=(root/name).read_bytes().replace(b'\r\n', b'\n'), check=True)
        subprocess.run(['clang', '-fblocks', '-fno-objc-arc', '-mmacosx-version-min=14.2', '-Wall', '-Wextra', '-Wno-unused-parameter',
                        '-c', str(native/'av_video.m'), '-o', str(stage/'capture.o')], check=True)
        binary = stage / 'capture-test'
        subprocess.run(['clang++', '-std=c++20', '-fblocks', '-fno-objc-arc', '-mmacosx-version-min=14.2',
                        '-I', str(native), str(root/'scripts/test_macos_capture.mm'), str(stage/'capture.o'),
                        '-framework', 'AppKit', '-framework', 'CoreGraphics', '-framework', 'CoreMedia',
                        '-framework', 'CoreVideo', '-framework', 'ScreenCaptureKit', '-framework', 'VideoToolbox',
                        '-o', str(binary)], check=True)
        result = subprocess.run([str(binary)], text=True, capture_output=True, timeout=75)
        print(result.stdout, end='')
        print(result.stderr, end='')
        result.check_returncode()
        actual = [line.split()[1] for line in result.stdout.splitlines() if line.startswith('PASS ')]
        if actual != CASES:
            raise RuntimeError('Native capture case inventory did not pass exactly')
        report = {'protocol': 1, 'passed': True, 'architecture': platform.machine(), 'cases': actual,
                  'sourceCommit': subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip(),
                  'upstreamCommit': pin, 'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
                  'sourceHashes': {name: hashlib.sha256((root/name).read_bytes()).hexdigest() for name in names},
                  'stdout': result.stdout, 'scope': 'Fixture-owned native pixels and capture source lifecycle; no installed privacy lease or encoded client acceptance.'}
        output.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    run(args.source, args.output)
