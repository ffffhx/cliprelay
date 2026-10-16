"""Native packaged file acceptance with disposable CI directories and identities."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import select
import signal
import ssl
import subprocess
import sys
import tempfile
import time

CASES = ['tls-files-desktop-resume-and-no-overwrite', 'tls-files-owner-and-live-revocation',
         'files-eof-joins-worker', 'files-parent-loss-with-writer-held', 'files-owner-admission']


def request(tls, command, connection=None):
    own = connection is None
    connection = connection or http.client.HTTPSConnection('127.0.0.1', 48791, context=tls, timeout=20)
    try:
        connection.request('POST', '/v1/files', json.dumps(command), {'Content-Type': 'application/json'})
        response = connection.getresponse()
        raw = response.read()
        return response.status, json.loads(raw) if response.status != 403 else None
    finally:
        if own:
            connection.close()


def child_pid(parent):
    children = subprocess.check_output(['pgrep', '-P', str(parent)], text=True).split()
    assert len(children) == 1, 'Expected exactly one owned file worker'
    pid = int(children[0])
    args = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True)
    assert '--managed-files --owner-pid '+str(parent)+' --state-dir ' in args
    return pid


def stage(client):
    assert select.select([client.stdout], [], [], 45)[0], 'Desktop file client timed out'
    line = client.stdout.readline(8193)
    assert line and len(line) <= 8192, 'Desktop file client did not produce a bounded receipt'
    return json.loads(line)


def owner_launcher(binary, state):
    process = subprocess.Popen([str(binary), '--managed-files', '--owner-pid', str(os.getpid()), '--state-dir', str(state)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    process.stdin.write(b'files:{"op":"roots","owner":"'+b'a'*64+b'"}\n')
    assert select.select([process.stdout], [], [], 10)[0]
    assert json.loads(process.stdout.readline(4096))['ok'] is True
    holder = subprocess.Popen([sys.executable, '-c', 'import os,sys,time; os.fstat(int(sys.argv[1])); time.sleep(30)', str(process.stdin.fileno())],
                              pass_fds=(process.stdin.fileno(),), stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(json.dumps({'pid': process.pid, 'holder': holder.pid}), flush=True)
    assert sys.stdin.buffer.readline() == b'crash\n'
    os._exit(17)


def run(binary, state, payload, tls, start, read_status, finish, wait_absent, passed, app_directory=None):
    assert sys.platform == 'darwin'
    with tempfile.TemporaryDirectory(prefix='ClipRelay-CI-Files-', dir=Path.home()) as remote_temporary, \
            tempfile.TemporaryDirectory(prefix='cliprelay-files-client-') as local_temporary:
        remote = Path(remote_temporary).resolve()
        assert remote.parent == Path.home().resolve()
        (remote/'fixture.bin').write_bytes(b'preserved remote file')
        process = start(binary, state, payload)
        status = read_status(process)
        client = None
        try:
            client = subprocess.Popen(['node', str(Path(__file__).with_name('test_host_files_client.cjs'))] + ([str(app_directory)] if app_directory else []),
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            client.stdin.write((json.dumps({'cert': (state/'cacert.pem').read_text(), 'key': (state/'cakey.pem').read_text(),
                                           'local': str(Path(local_temporary).resolve()), 'remote': remote.name})+'\n').encode())
            receipt = stage(client)
            assert receipt['stage'] == 'paused' and receipt['offset'] == 256*1024
            first_worker = child_pid(process.pid)
            os.kill(first_worker, signal.SIGKILL)
            wait_absent(first_worker)  # The actual host reaps the idle child.
            client.stdin.write(b'{"op":"resume"}\n')
            complete = stage(client)
            assert complete['stage'] == 'complete' and complete['id'] == receipt['id']
            assert client.wait(timeout=10) == 0, 'Desktop file client failed'
            assert client.stderr.read() == b''
            assert (remote/'fixture.bin').read_bytes() == b'preserved remote file'
            assert complete['finalName'] != 'fixture.bin'
            content = (remote/complete['finalName']).read_bytes()
            assert len(content) == receipt['size'] and hashlib.sha256(content).hexdigest() == receipt['sha256']
            assert (remote/'created-directory').is_dir()
            current_worker = child_pid(process.pid)
            assert current_worker != first_worker
            passed(CASES[0])

            # An independently paired certificate cannot read/cancel this journal.
            local = Path(local_temporary)
            cert, key = local/'second.pem', local/'second.key'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=second-ci-peer',
                            '-keyout', str(key), '-out', str(cert)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            clients = state/'clients.json'
            original = clients.read_bytes()
            known = json.loads(original)
            known['root']['named_devices'].append({'cert': cert.read_text(), 'enabled': True})
            second = ssl.create_default_context(cafile=str(state/'cacert.pem'))
            second.load_cert_chain(str(cert), str(key))
            reused = http.client.HTTPSConnection('127.0.0.1', 48791, context=tls, timeout=10)
            try:
                clients.write_text(json.dumps(known))
                assert request(second, {'op': 'roots'})[0] == 200
                for op in ['status', 'cancel']:
                    code, result = request(second, {'op': op, 'id': receipt['id']})
                    assert code == 409 and result['code'] == 'FILES_NOT_FOUND'
                assert request(tls, {'op': 'status', 'id': receipt['id']}, reused)[0] == 200
                connection = reused.sock
                assert connection is not None
                known['root']['named_devices'][0]['enabled'] = False
                clients.write_text(json.dumps(known))
                assert reused.sock is connection
                assert request(tls, {'op': 'roots'}, reused)[0] == 403
                # The other peer cannot impersonate a journal owner in JSON.
                assert request(second, {'op': 'status', 'id': receipt['id'], 'owner': 'a'*64})[0] == 400
            finally:
                reused.close()
                clients.write_bytes(original)
            passed(CASES[1])
            process.stdin.close()
            finish(process, status)
            wait_absent(current_worker)
            passed(CASES[2])
        finally:
            if client is not None:
                if client.poll() is None:
                    client.kill()
                client.wait()
                error = client.stderr.read(8192)
                if error:
                    print(error.decode(errors='replace'), file=sys.stderr)
            if process.poll() is None:
                process.stdin.close()
                finish(process, status)

        launcher = subprocess.Popen([sys.executable, __file__, str(binary), str(state)],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        owned = None
        try:
            owned = stage(launcher)
            launcher.stdin.write(b'crash\n')
            assert launcher.wait(timeout=5) == 17
            os.kill(owned['holder'], 0)
            wait_absent(owned['pid'])
            os.kill(owned['holder'], 0)
            passed(CASES[3])
        finally:
            if launcher.poll() is None:
                launcher.kill()
            launcher.wait()
            if owned:
                for pid in [owned['holder'], owned['pid']]:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        for mode in ['wrong-parent', 'regular-input']:
            with open(state/'cacert.pem', 'rb') as regular:
                denied = subprocess.run([str(binary), '--managed-files', '--owner-pid', str(os.getpid()+1 if mode == 'wrong-parent' else os.getpid()), '--state-dir', str(state)],
                                        stdin=regular if mode == 'regular-input' else subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
            assert denied.returncode == 2 and denied.stdout == b'' and denied.stderr.strip() == b'HOST_OWNER_INVALID'
        passed(CASES[4])


if __name__ == '__main__':
    owner_launcher(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
