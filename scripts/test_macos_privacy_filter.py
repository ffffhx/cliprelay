"""Native mask identity and capture-filter checks in disposable Mac CI only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import subprocess
import tempfile
import time

CASES = ['native-foreign-process-window-and-layout-rejected',
         'native-worker-mask-excluded-from-new-capture',
         'native-release-retains-filter-while-worker-lives',
         'native-confirmed-death-removes-filter-and-reconstructs-source']
POLICY_CASES = ['filtered-source-and-real-encoded-generation-required',
                'expiry-and-replays-retain-filter-without-renewal',
                'foreign-and-malformed-native-bindings-are-rejected',
                'unknown-worker-does-not-prove-restoration',
                'source-and-observer-replays-cannot-claim-new-readiness',
                'stream-display-and-capture-changes-withdraw-authorization',
                'release-requires-confirmed-original-worker-death',
                'concurrent-late-renewal-cannot-revive-expired-filter']
SOURCES = ['engine/sunshine/' + name for name in [
    'control.patch', 'macos-control.patch', 'macos-capture.patch', 'macos-privacy.patch',
    'cliprelay_control.h', 'cliprelay_input.h', 'cliprelay_owner.h',
    'cliprelay_privacy.h', 'cliprelay_privacy_macos.mm', 'privacy_test.cpp']]
SOURCES += ['scripts/test_macos_privacy_filter.py', 'scripts/test_macos_privacy_filter.mm',
            'scripts/privacy_fixture/main.go', 'network/go.mod', 'network/go.sum', 'LICENSE']
SOURCES += ['network/hostprivacy/' + name for name in [
    'controller.go', 'controller_test.go', 'serve.go', 'native_other.go',
    'native_darwin.go', 'native_darwin.h', 'native_darwin.m']]


def read_line(stream, timeout=8):
    deadline = time.monotonic() + timeout
    result = bytearray()
    while len(result) <= 8192:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([stream], [], [], remaining)[0]:
            raise RuntimeError('Native filter response timeout')
        value = os.read(stream.fileno(), 1)
        if not value:
            raise RuntimeError('Native filter response channel closed')
        if value == b'\n':
            return json.loads(result)
        result.extend(value)
    raise RuntimeError('Oversized native filter response')


def run(source, output):
    if platform.system() != 'Darwin' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('Requires a disposable native Mac CI runner')
    root = Path(__file__).resolve().parents[1]
    source = source.resolve(strict=True)
    pin = json.loads((root/'engine/sunshine/upstream.json').read_text())['commit']
    if subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() != pin:
        raise RuntimeError('Unexpected native capture source revision')
    with tempfile.TemporaryDirectory(prefix='cliprelay-privacy-filter-') as temporary:
        stage = Path(temporary)
        helper, binary, policy = stage/'worker', stage/'filter', stage/'policy'
        subprocess.run(['go', 'build', '-mod=readonly', '-o', str(helper), str(root/'scripts/privacy_fixture/main.go')],
                       cwd=root/'network', check=True)
        subprocess.run(['clang++', '-std=c++23', '-Wall', '-Wextra', '-Werror', '-UNDEBUG', '-pthread',
                        str(root/'engine/sunshine/privacy_test.cpp'), '-o', str(policy)], check=True)
        policy_report = json.loads(subprocess.check_output([str(policy)], timeout=15))
        if policy_report.get('passed') is not True or policy_report.get('cases') != POLICY_CASES:
            raise RuntimeError('Filter policy cases did not pass exactly')
        subprocess.run(['git', 'init', '-q', str(stage)], check=True)
        native = stage/'src/platform/macos'; native.mkdir(parents=True)
        for name in ['av_video.h', 'av_video.m']:
            (native/name).write_bytes(subprocess.check_output(['git', '-C', str(source), 'show', f'{pin}:src/platform/macos/{name}']))
        for name in SOURCES[:4]:
            subprocess.run(['git', 'apply', '--include=src/platform/macos/av_video.h', '--include=src/platform/macos/av_video.m', '-'],
                           cwd=stage, input=(root/name).read_bytes().replace(b'\r\n', b'\n'), check=True)
        subprocess.run(['clang', '-fblocks', '-fno-objc-arc', '-mmacosx-version-min=14.2',
                        '-c', str(native/'av_video.m'), '-o', str(stage/'capture.o')], check=True)
        subprocess.run(['clang++', '-std=c++23', '-fblocks', '-fobjc-arc', '-mmacosx-version-min=14.2',
                        '-I', str(root/'engine/sunshine'), '-c', str(root/'engine/sunshine/cliprelay_privacy_macos.mm'),
                        '-o', str(stage/'privacy.o')], check=True)
        subprocess.run(['clang++', '-std=c++23', '-fblocks', '-fno-objc-arc', '-mmacosx-version-min=14.2',
                        '-I', str(native), '-I', str(root/'engine/sunshine'), str(root/'scripts/test_macos_privacy_filter.mm'),
                        str(stage/'capture.o'), str(stage/'privacy.o'), '-framework', 'AppKit', '-framework', 'CoreGraphics',
                        '-framework', 'CoreMedia', '-framework', 'CoreVideo', '-framework', 'ScreenCaptureKit',
                        '-framework', 'VideoToolbox', '-o', str(binary)], check=True)
        children, logs, passed = [], [], []
        worker = None
        try:
            def start(command, **kwargs):
                log = (stage/f'child-{len(children)}.log').open('w+b'); logs.append(log)
                child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, bufsize=0, **kwargs)
                children.append(child)
                return child
            bridge = start([str(binary)], env=dict(os.environ, CLIPRELAY_HOST_OWNER_PID=str(os.getpid())))
            def event(expected, timeout=8):
                response = read_line(bridge.stdout, timeout)
                if response != {'event': expected}:
                    raise RuntimeError(f'Unexpected native filter event: {response}')
                if expected in CASES: passed.append(expected)
            def send(child, value):
                child.stdin.write(value + b'\n'); child.stdin.flush()
            event('listening')
            worker = start([str(helper), '--owner'])
            send(worker, json.dumps({'op': 'prepare', 'lease': 'b'*32}).encode())
            prepared = read_line(worker.stdout)
            if prepared.get('ok') is not True or prepared.get('prepared') is not True or prepared.get('active') is not False:
                raise RuntimeError(f'Worker did not prepare invisible windows: {prepared}')
            identity = prepared['identity']
            send(bridge, json.dumps(identity).encode())
            event(CASES[0]); event('prepared')
            send(worker, json.dumps({'op': 'activate', 'lease': 'b'*32}).encode())
            active = read_line(worker.stdout)
            if active.get('ok') is not True or active.get('active') is not True:
                raise RuntimeError(f'Worker did not activate: {active}')
            send(bridge, b'active')
            event(CASES[1], 12); event(CASES[2])
            worker.stdin.close()
            if worker.wait(timeout=4) != 0:
                raise RuntimeError('Owned worker failed while restoring')
            # The direct parent reaps its child before exiting. Check absence
            # before allowing the bridge to remove the exact original filter.
            try: os.kill(identity['pid'], 0)
            except ProcessLookupError: pass
            else: raise RuntimeError('Original native worker survived owner EOF')
            send(bridge, b'dead'); event(CASES[3])
            if bridge.wait(timeout=5) != 0 or passed != CASES:
                raise RuntimeError('Native filter cases did not complete')
        finally:
            # Close the native worker's private input first so AppKit restores
            # its own windows even if the capture fixture or assertion failed.
            if worker is not None and not worker.stdin.closed: worker.stdin.close()
            for child in reversed(children):
                if child.poll() is None:
                    try: child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        child.terminate()
                        try: child.wait(timeout=3)
                        except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=3)
                if not child.stdin.closed: child.stdin.close()
                child.stdout.close()
            for log in logs:
                log.seek(0); diagnostic = log.read()[-16384:].decode(errors='replace')
                if diagnostic: print(diagnostic)
                log.close()
        report = {'protocol': 1, 'passed': True, 'architecture': platform.machine(), 'cases': passed,
                  'policyCases': POLICY_CASES, 'actualEncodedReadiness': False, 'pairedClientAccepted': False,
                  'sourceCommit': subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip(),
                  'upstreamCommit': pin, 'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
                  'workerSha256': hashlib.sha256(helper.read_bytes()).hexdigest(),
                  'sourceHashes': {name: hashlib.sha256((root/name).read_bytes()).hexdigest() for name in SOURCES},
                  'scope': 'Owned native process/window identity, real mask pixels, filtering and death recovery. Initial display registry is a fixture; no actual encoded-generation or paired-client acceptance.'}
        output.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'passed': True, 'cases': passed, 'policyCases': POLICY_CASES}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    run(args.source, args.output)
