"""Owned-window and process-death acceptance in disposable macOS CI only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import signal
import subprocess
import sys
import tarfile
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


CASES = ['native-prepare-invisible-activate-visible-stop-restores',
         'native-deadline-exits-and-removes-owned-masks',
         'native-owner-channel-EOF-removes-owned-masks',
         'native-worker-crash-removes-owned-masks',
         'privacy-production-owner-and-channel-admission',
         'privacy-parent-exit-with-writer-held',
         'privacy-parent-crash-with-writer-held',
         'privacy-signal-hides-owned-masks']


def worker_command(binary, state, owner=None):
    return [str(binary), '--managed-privacy', '--owner-pid', str(os.getpid() if owner is None else owner),
            '--state-dir', str(state)]


def owner_launcher(binary, state, reader, writer):
    child = subprocess.Popen(worker_command(binary, state), stdin=reader, stdout=writer, stderr=sys.stderr)
    os.close(reader); os.close(writer)
    print(json.dumps({'pid':child.pid}), flush=True)
    action = sys.stdin.buffer.readline(16)
    if action.strip() == b'crash': os._exit(17)


def run(output, selected_binary=None):
    if platform.system() != 'Darwin' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('Requires a disposable Mac CI runner')
    root = Path(__file__).resolve().parents[1]
    cases, observations = [], []
    native_sources = [p for p in (root/'network/hostprivacy').iterdir() if p.suffix in ('.go','.h','.m')]
    native_sources += [root/'network/cmd/cliprelay-host-network/main.go', root/'network/cmd/cliprelay-host-network/input_unix.go',
                       root/'network/go.mod', root/'network/go.sum']
    if selected_binary is not None:
        artifact = selected_binary.parent.parent
        manifest = json.loads((artifact/'manifest.json').read_bytes())
        if manifest.get('privacyWorker') != 1 or hashlib.sha256(selected_binary.read_bytes()).hexdigest() != manifest['files']['runtime/cliprelay-host-network']:
            raise RuntimeError('Selected binary is not the pinned private mask worker')
        with tarfile.open(artifact/'cliprelay-host-source.tar.gz') as archive:
            for source in native_sources:
                if archive.extractfile(source.relative_to(root).as_posix()).read() != source.read_bytes():
                    raise RuntimeError('Selected privacy worker core does not match the test revision')
    with tempfile.TemporaryDirectory(prefix='cliprelay-privacy-worker-') as temporary:
        stage = Path(temporary)
        binary, auditor = selected_binary or stage/'worker', stage/'audit'
        state = stage/'state'; state.mkdir(mode=0o700)
        if selected_binary is None:
            subprocess.run(['go', 'build', '-mod=readonly', '-o', str(binary), './cmd/cliprelay-host-network'], cwd=root/'network', check=True)
        subprocess.run(['clang++', '-fobjc-arc', '-mmacosx-version-min=14.2', str(root/'scripts/privacy_fixture/audit.mm'),
                        '-framework', 'Foundation', '-framework', 'CoreGraphics', '-o', str(auditor)], check=True)
        children, logs, orphans = [], [], []
        def audit(pid):
            return json.loads(subprocess.check_output([str(auditor), str(pid)], timeout=5))
        def start():
            log = (stage/f'worker-{len(children)}.log').open('w+b')
            logs.append(log)
            child = subprocess.Popen(worker_command(binary, state), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, bufsize=0)
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
        def hidden(pid):
            until = time.monotonic()+2
            while time.monotonic() < until:
                if not any(w['alpha'] > 0 and w['onScreen'] for w in audit(pid)): return
                time.sleep(.05)
            raise RuntimeError('Native stop did not hide masks')
        def absent(pid):
            until = time.monotonic()+2
            while time.monotonic() < until:
                try: os.kill(pid, 0)
                except ProcessLookupError: return
                time.sleep(.05)
            raise RuntimeError('Privacy worker survived parent death with writer held')
        def admission():
            arguments = [worker_command(binary,state,1), worker_command(binary,state,os.getppid()),
                         worker_command(binary,'relative'), worker_command(binary,state)+['--managed-wake'],
                         worker_command(binary,state)+['--unknown-privacy-option']]
            for args in arguments:
                result = subprocess.run(args, input=b'', capture_output=True, timeout=3)
                assert result.returncode == 2 and result.stdout == b'' and result.stderr.strip() == b'HOST_OWNER_INVALID'
            with (stage/'regular-channel').open('w+b') as regular:
                result = subprocess.run(worker_command(binary,state), stdin=regular, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
                assert result.returncode == 2 and result.stdout == b'' and result.stderr.strip() == b'HOST_OWNER_INVALID'
                result = subprocess.run(worker_command(binary,state), input=b'', stdout=regular, stderr=subprocess.PIPE, timeout=3)
                assert result.returncode == 2 and result.stderr.strip() == b'HOST_OWNER_INVALID'
                assert regular.tell() == 0
        def parent_loss(action):
            reader, held_writer = os.pipe()
            output_reader, writer = os.pipe()
            log = (stage/f'parent-{action}.log').open('w+b'); logs.append(log)
            try:
                parent = subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--owner-launcher',str(binary),str(state),str(reader),str(writer)],
                                          pass_fds=(reader,writer),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,bufsize=0)
                children.append(parent)
            finally:
                os.close(reader); os.close(writer)
            with os.fdopen(held_writer,'wb',buffering=0) as control, os.fdopen(output_reader,'rb',buffering=0) as response:
                pid = read_line(parent.stdout)['pid']; orphans.append(pid)
                # Adapt only pipe access; the actual child uses production CLI admission.
                class Channels: pass
                worker = Channels(); worker.pid=pid; worker.stdin=control; worker.stdout=response
                identifiers=prepare(worker); activate(worker,identifiers)
                began=time.monotonic()
                parent.stdin.write(action.encode()+b'\n'); parent.stdin.close(); parent.wait(timeout=2)
                assert parent.returncode == (17 if action == 'crash' else 0)
                # Keep the root's writer open while verifying process death.
                assert not control.closed
                absent(pid); gone(pid)
                observations.append({'case':'parent-'+action,'elapsedSeconds':time.monotonic()-began,'writerHeld':True})
        try:
            child=start(); identifiers=prepare(child); activate(child,identifiers)
            response=command(child,'stop')
            assert not response['active'] and not response['prepared'] and 'identity' not in response
            hidden(child.pid)
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

            admission(); cases.append('privacy-production-owner-and-channel-admission')
            for action in ('exit','crash'):
                parent_loss(action); cases.append('privacy-parent-'+action+'-with-writer-held')
            child=start(); identifiers=prepare(child); activate(child,identifiers)
            child.send_signal(signal.SIGTERM); child.wait(timeout=2); gone(child.pid)
            assert child.returncode == 0
            cases.append('privacy-signal-hides-owned-masks')
            assert cases == CASES
        finally:
            for child in children:
                if child.poll() is None: child.kill(); child.wait(timeout=5)
                for stream in (child.stdin,child.stdout):
                    if stream and not stream.closed: stream.close()
            for pid in orphans:
                # Only an exact fixture executable may be reaped on a failed test.
                result = subprocess.run(['ps','-p',str(pid),'-o','command='],capture_output=True,text=True)
                if result.returncode == 0 and result.stdout.startswith(str(binary)+' --managed-privacy '):
                    try: os.kill(pid,signal.SIGKILL)
                    except ProcessLookupError: pass
            for log in logs:
                log.flush(); log.seek(0)
                diagnostic = log.read()[-4096:].decode(errors='replace')
                if diagnostic: print(diagnostic, file=sys.stderr)
                log.close()
        sources = native_sources + [root/'scripts/privacy_fixture/audit.mm',Path(__file__).resolve()]
        report={'protocol':1,'passed':True,'architecture':platform.machine(), 'cases':cases,'observations':observations,
                'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),
                'sourceHashes':{p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sources},
                'workerSha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'productionCLI':True,
                'scope':'Owned production CLI admission, native mask visibility and process lifetime. No engine exclusion handshake, paired lease endpoint or encoded client acceptance.'}
        output.write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps({'passed':True,'cases':cases,'observations':observations}))


if __name__ == '__main__':
    if len(sys.argv) == 6 and sys.argv[1] == '--owner-launcher':
        if platform.system() != 'Darwin' or os.environ.get('GITHUB_ACTIONS') != 'true': raise SystemExit('Disposable Mac CI required')
        owner_launcher(Path(sys.argv[2]),Path(sys.argv[3]),int(sys.argv[4]),int(sys.argv[5])); raise SystemExit(0)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--binary',type=Path)
    args=parser.parse_args()
    run(args.output,args.binary.resolve() if args.binary else None)
