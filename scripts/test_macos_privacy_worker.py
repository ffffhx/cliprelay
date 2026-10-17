"""Owned-window and process-death acceptance in disposable macOS CI only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import subprocess
import sys
import tempfile
import time

LEASE = '0123456789abcdef0123456789abcdef'


def read_line(stream, timeout=5):
    if not select.select([stream], [], [], timeout)[0]:
        raise RuntimeError('Native worker response timeout')
    line = stream.readline(8193)
    if not line.endswith(b'\n') or len(line) > 8192:
        raise RuntimeError('Native worker response channel closed or oversized')
    return json.loads(line)


def run(output):
    if platform.system() != 'Darwin' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('Requires a disposable Mac CI runner')
    root = Path(__file__).resolve().parents[1]
    cases, observations = [], []
    with tempfile.TemporaryDirectory(prefix='cliprelay-privacy-worker-') as temporary:
        stage = Path(temporary)
        binary, auditor = stage/'worker', stage/'audit'
        subprocess.run(['go', 'build', '-mod=readonly', '-o', str(binary), str(root/'scripts/privacy_fixture/main.go')], cwd=root/'network', check=True)
        subprocess.run(['clang++', '-fobjc-arc', '-mmacosx-version-min=14.2', str(root/'scripts/privacy_fixture/audit.mm'),
                        '-framework', 'Foundation', '-framework', 'CoreGraphics', '-o', str(auditor)], check=True)
        children = []
        def audit(pid):
            return json.loads(subprocess.check_output([str(auditor), str(pid)], timeout=5))
        def start():
            child = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            children.append(child)
            return child
        def command(child, op):
            request = {'op':op}
            if op != 'status': request['lease'] = LEASE
            child.stdin.write(json.dumps(request).encode()+b'\n'); child.stdin.flush()
            response = read_line(child.stdout)
            assert response['ok'] is True, response
            return response
        def prepare(child):
            response = command(child, 'prepare')
            identity = response['identity']
            assert identity['pid'] == child.pid and identity['birthSec'] > 0
            assert response['prepared'] is True and response['active'] is False
            assert 0 < response['expiresMs'] <= 15000
            assert not any(w['alpha'] > 0 and w['onScreen'] for w in audit(child.pid))
            return {w['id'] for w in identity['windows']}
        def activate(child, identifiers):
            response = command(child, 'activate')
            assert response['active'] is True and 0 < response['expiresMs'] <= 15000
            until = time.monotonic()+2
            while time.monotonic() < until:
                visible = {w['id'] for w in audit(child.pid) if w['alpha'] == 1 and w['onScreen']}
                if visible == identifiers: return
                time.sleep(.05)
            raise RuntimeError('Owned masks did not become visible')
        def gone(pid):
            until = time.monotonic()+2
            while time.monotonic() < until:
                if not audit(pid): return
                time.sleep(.05)
            raise RuntimeError('Native windows outlived the worker')
        try:
            child=start(); identifiers=prepare(child); activate(child,identifiers)
            response=command(child,'stop')
            assert not response['active'] and not response['prepared'] and 'identity' not in response
            assert not any(w['alpha'] > 0 and w['onScreen'] for w in audit(child.pid))
            child.stdin.close(); child.wait(timeout=2); gone(child.pid)
            cases.append('native-prepare-invisible-activate-visible-stop-restores')

            child=start(); began=time.monotonic(); identifiers=prepare(child); activate(child,identifiers)
            child.wait(timeout=16); elapsed=time.monotonic()-began
            assert child.returncode == 3 and 14.5 <= elapsed <= 16, (child.returncode,elapsed)
            gone(child.pid); observations.append({'case':'expiry','elapsedSeconds':elapsed})
            cases.append('native-deadline-exits-and-removes-owned-masks')

            child=start(); identifiers=prepare(child); activate(child,identifiers)
            began=time.monotonic(); child.stdin.close(); child.wait(timeout=2)
            gone(child.pid); observations.append({'case':'EOF','elapsedSeconds':time.monotonic()-began,'exit':child.returncode})
            cases.append('native-owner-channel-EOF-removes-owned-masks')

            child=start(); identifiers=prepare(child); activate(child,identifiers)
            child.kill();child.wait(timeout=2);gone(child.pid)
            cases.append('native-worker-crash-removes-owned-masks')
        finally:
            for child in children:
                if child.poll() is None: child.kill(); child.wait(timeout=5)
                for stream in (child.stdin,child.stdout):
                    if stream and not stream.closed: stream.close()
        sources = [p for p in (root/'network/hostprivacy').iterdir() if p.suffix in ('.go','.h','.m')]
        sources += [root/'scripts/privacy_fixture/main.go',root/'scripts/privacy_fixture/audit.mm',Path(__file__).resolve()]
        report={'protocol':1,'passed':True,'architecture':platform.machine(), 'cases':cases,'observations':observations,
                'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),
                'sourceHashes':{p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sources},
                'workerSha256':hashlib.sha256(binary.read_bytes()).hexdigest(),
                'scope':'Private native mask visibility and process lifetime only. No production CLI admission, engine exclusion handshake, paired lease endpoint or encoded client acceptance.'}
        output.write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps({'passed':True,'cases':cases,'observations':observations}))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    run(parser.parse_args().output)
