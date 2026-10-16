"""Exercise the packaged Mac host companion only with disposable CI fixtures."""
import argparse
import base64
import hashlib
import http.client
import json
import os
import platform
from pathlib import Path
import secrets
import select
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time


def read_status(process):
    if not select.select([process.stdout], [], [], 12)[0]:
        raise RuntimeError('Companion did not report bound listeners')
    line = process.stdout.readline(2049)
    if not line or len(line) > 2048:
        raise RuntimeError('Invalid companion status envelope')
    value = json.loads(line)
    assert set(value) == {'type', 'protocol', 'pid', 'ownerPid', 'ipc', 'nativeWorkers'}
    assert value['type'] == 'listening' and value['protocol'] == 1
    assert value['pid'] == process.pid and value['ownerPid'] == os.getpid()
    assert value['nativeWorkers'] is False
    ipc = Path(value['ipc'])
    assert ipc.name == 'clipboard-relay.sock' and ipc.parent.name.startswith('cliprelay-host-')
    assert ipc.parent.resolve() == ipc.parent and ipc.parent.stat().st_mode & 0o7777 == 0o700
    assert ipc.stat().st_mode & 0o7777 == 0o600
    return value


def command(binary, state, owner=None):
    return [str(binary), '--state-dir', str(state), '--owner-pid', str(os.getpid() if owner is None else owner)]


def start(binary, state, payload, stdin=None):
    process = subprocess.Popen(command(binary, state), stdin=subprocess.PIPE if stdin is None else stdin,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    if stdin is None:
        process.stdin.write(payload)
    return process


def ports_free():
    for port, kind in [(48791, socket.SOCK_STREAM), (48792, socket.SOCK_STREAM), (47634, socket.SOCK_DGRAM)]:
        with socket.socket(socket.AF_INET, kind) as probe:
            if kind == socket.SOCK_STREAM:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('127.0.0.1', port))


def wait_absent(pid):
    deadline = time.monotonic()+10
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(.05)
    raise RuntimeError('Owned companion survived parent loss')


def owner_launcher(binary, state):
    payload = sys.stdin.buffer.readline(100000)
    process = start(binary, state, payload)
    value = read_status(process)
    holder = subprocess.Popen([sys.executable, '-c', 'import os,sys,time; os.fstat(int(sys.argv[1])); time.sleep(30)', str(process.stdin.fileno())],
                              pass_fds=(process.stdin.fileno(),), stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(json.dumps({'pid': process.pid, 'holder': holder.pid, 'ipc': value['ipc']}), flush=True)
    action = sys.stdin.buffer.readline().strip()
    os._exit(17 if action == b'crash' else 0)


def main(binary, report):
    assert sys.platform == 'darwin', 'Run positive native ownership cases only on disposable macOS CI'
    cases = []
    with tempfile.TemporaryDirectory(prefix='cliprelay-companion-ci-') as temporary:
        root = Path(temporary).resolve()
        state = root/'state'
        state.mkdir(mode=0o700)
        config = root/'certificate.conf'
        config.write_text('[req]\ndistinguished_name=dn\n[dn]\n[extensions]\nsubjectAltName=IP:127.0.0.1\n')
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=localhost', '-config', str(config), '-extensions', 'extensions',
                        '-keyout', str(state/'cakey.pem'), '-out', str(state/'cacert.pem')],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cert = (state/'cacert.pem').read_text()
        (state/'clients.json').write_text(json.dumps({'root': {'named_devices': [{'cert': cert, 'enabled': True}]}}))
        for file in state.iterdir():
            file.chmod(0o600)
        fingerprints = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in state.iterdir()}
        secret = secrets.token_urlsafe(32)
        payload = (json.dumps({'protocol': 1, 'password': secret,
                              'certificate': base64.b64encode(ssl.PEM_cert_to_DER_cert(cert)).decode()})+'\n').encode()
        tls = ssl.create_default_context(cafile=str(state/'cacert.pem'))
        tls.load_cert_chain(str(state/'cacert.pem'), str(state/'cakey.pem'))

        def assert_state():
            for name, digest in fingerprints.items():
                assert hashlib.sha256((state/name).read_bytes()).hexdigest() == digest
            assert not (state/'service.json').exists()
            pending = state/'lan-pairing'
            assert not pending.exists() or not list(pending.iterdir())

        def finish(process, status, code=0, expected_error=b''):
            try:
                assert process.wait(timeout=10) == code
                stderr = process.stderr.read(4096)
                assert stderr.strip() == expected_error and secret.encode() not in stderr
                assert not Path(status['ipc']).parent.exists()
                assert_state()
                ports_free()
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()

        process = start(binary, state, payload)
        status = read_status(process)
        control = http.client.HTTPSConnection('127.0.0.1', 48791, context=tls, timeout=3)
        control.request('GET', '/not-a-command')
        response = control.getresponse()
        assert response.status == 404
        response.read()
        control.close()
        pair = http.client.HTTPSConnection('127.0.0.1', 48792, context=tls, timeout=3)
        pair.request('POST', '/v1/pair', json.dumps({'name': 'disposable CI peer', 'nonce': 'a'*32, 'pin': '1234'}), {'Content-Type': 'application/json'})
        response = pair.getresponse()
        pending = json.loads(response.read())
        assert response.status == 200 and (state/'lan-pairing'/(pending['id']+'.json')).exists()
        pair.close()
        ipc = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        ipc.connect(status['ipc'])
        ipc.sendall(b'{"op":')
        process.stdin.close()
        finish(process, status)
        ipc.settimeout(1)
        assert ipc.recv(1) == b''
        ipc.close()
        cases.append('tls-pairing-ipc-and-eof-cleanup')

        child_input, parent_input = socket.socketpair()
        process = start(binary, state, payload, child_input)
        child_input.close()
        parent_input.sendall(payload)
        status = read_status(process)
        parent_input.shutdown(socket.SHUT_WR)
        finish(process, status)
        parent_input.close()
        cases.append('inherited-unix-stream-owner')

        process = start(binary, state, payload)
        status = read_status(process)
        process.stdin.write(b'x')
        finish(process, status, 1, b'HOST_PROTOCOL_INVALID')
        cases.append('extra-byte-without-newline-stops-service')

        for action in ['exit', 'crash']:
            launcher = subprocess.Popen([sys.executable, __file__, str(binary), '--owner-launcher', str(state)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            launcher.stdin.write(payload)
            assert select.select([launcher.stdout], [], [], 15)[0]
            owned = json.loads(launcher.stdout.readline())
            launcher.stdin.write(action.encode()+b'\n')
            assert launcher.wait(timeout=5) == (17 if action == 'crash' else 0)
            child_exited = False
            try:
                os.kill(owned['holder'], 0)  # A live process still owns the writer.
                wait_absent(owned['pid'])
                child_exited = True
                os.kill(owned['holder'], 0)
                assert not Path(owned['ipc']).parent.exists()
                ports_free()
                assert_state()
            finally:
                for pid in [owned['holder']] + ([] if child_exited else [owned['pid']]):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            cases.append('parent-'+action+'-with-inherited-writer-held')

        for name, frame in [('invalid-frame', b'{"password":"not-a-complete-init"}\n'),
                            ('oversized-frame', b'x'*(96*1024+2)), ('initialization-timeout', None)]:
            process = subprocess.Popen(command(binary, state), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            if frame is not None:
                try:
                    process.stdin.write(frame)
                except BrokenPipeError:
                    pass
            assert process.wait(timeout=8) == 1
            assert process.stdout.read() == b''
            assert process.stderr.read().strip() == (b'HOST_INIT_TIMEOUT' if frame is None else b'HOST_INIT_INVALID')
            process.stdin.close()
            assert_state()
            ports_free()
            cases.append(name)

        before_runtime = {str(path) for path in Path('/private/tmp').glob('cliprelay-host-*')}
        with socket.socket() as conflict:
            conflict.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            conflict.bind(('127.0.0.1', 48792))
            conflict.listen()
            process = start(binary, state, payload)
            assert process.wait(timeout=5) == 1
            assert process.stdout.read() == b''
            assert process.stderr.read().strip() == b'HOST_SERVICE_UNAVAILABLE'
            process.stdin.close()
        assert {str(path) for path in Path('/private/tmp').glob('cliprelay-host-*')} == before_runtime
        ports_free()
        assert_state()
        cases.append('required-listener-conflict-rolls-back-runtime')

        for name, stdin, owner in [('wrong-parent', subprocess.PIPE, os.getpid()+1),
                                   ('regular-input', open(state/'cacert.pem', 'rb'), None)]:
            try:
                process = subprocess.Popen(command(binary, state, owner), stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                stdout, stderr = process.communicate(timeout=3)
                assert process.returncode == 2 and stdout == b'' and stderr.strip() == b'HOST_OWNER_INVALID'
            finally:
                if hasattr(stdin, 'close'):
                    stdin.close()
            cases.append(name)
        assert_state()
    result = {'cases': cases, 'passed': len(cases), 'nativeWorkers': False,
              'architecture': platform.machine(), 'executableSha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'limits': 'Disposable CI certificates/listeners only; no native desktop providers, streaming client, user Keychain or production installation.'}
    report.write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--owner-launcher', type=Path)
    args = parser.parse_args()
    if args.owner_launcher:
        owner_launcher(args.binary.resolve(), args.owner_launcher.resolve())
    else:
        main(args.binary.resolve(), args.report.resolve())
