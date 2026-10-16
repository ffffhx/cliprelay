"""Real Mac pasteboard acceptance, restricted to disposable CI runners."""
import base64
import binascii
import http.client
import json
import os
from pathlib import Path
import select
import signal
import struct
import subprocess
import sys
import time
import zlib

CASES = ['tls-clipboard-text-image-and-idempotence', 'tls-clipboard-owner-and-live-revocation',
         'clipboard-worker-crash-recovery', 'clipboard-eof-joins-worker',
         'clipboard-parent-loss-with-writer-held', 'clipboard-owner-admission', 'tls-clipboard-desktop-client']


def png():
    def chunk(kind, value):
        return struct.pack('>I', len(value))+kind+value+struct.pack('>I', binascii.crc32(kind+value))
    return (b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 3, 8, 6, 0, 0, 0))
            +chunk(b'IDAT', zlib.compress((b'\0'+b'\xff\0\0\x80'*2)*3))+chunk(b'IEND', b''))


def request(tls, value, connection=None, image=False):
    own = connection is None
    connection = connection or http.client.HTTPSConnection('127.0.0.1', 48791, context=tls, timeout=20)
    try:
        connection.request('POST', '/v1/clipboard-image' if image else '/v1/clipboard',
                           value if image else json.dumps(value),
                           {'Content-Type': 'image/png' if image else 'application/json'})
        response = connection.getresponse()
        raw = response.read()
        return response.status, json.loads(raw) if response.getheader('Content-Type') == 'application/json' else None
    finally:
        if own:
            connection.close()


def child_pid(parent):
    children = subprocess.check_output(['pgrep', '-P', str(parent)], text=True).split()
    assert len(children) == 1, 'Expected one owned clipboard worker'
    pid = int(children[0])
    args = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True)
    assert '--managed-clipboard --owner-pid '+str(parent)+' --state-dir ' in args
    return pid


def write(text='ClipRelay CI 中文 😀\nline two', owner='a', identifier='1'):
    return {'op': 'write', 'owner': owner*64, 'id': identifier*32, 'kind': 'text', 'text': text}


def owner_launcher(binary, state):
    process = subprocess.Popen([str(binary), '--managed-clipboard', '--owner-pid', str(os.getpid()), '--state-dir', str(state)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    process.stdin.write(('clipboard:'+json.dumps(write())+'\n').encode())
    assert select.select([process.stdout], [], [], 15)[0]
    assert json.loads(process.stdout.readline(4096))['ok'] is True
    holder = subprocess.Popen([sys.executable, '-c', 'import os,sys,time; os.fstat(int(sys.argv[1])); time.sleep(30)', str(process.stdin.fileno())],
                              pass_fds=(process.stdin.fileno(),), stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(json.dumps({'pid': process.pid, 'holder': holder.pid}), flush=True)
    assert sys.stdin.buffer.readline() == b'crash\n'
    os._exit(17)


def run(binary, state, payload, tls, start, read_status, finish, wait_absent, passed, app_directory=None):
    assert sys.platform == 'darwin' and os.environ.get('CI') == 'true', 'System clipboard fixtures require disposable CI'
    process = start(binary, state, payload)
    status = read_status(process)
    clients = state/'clients.json'
    original = clients.read_bytes()
    worker = None
    try:
        value = write()
        del value['owner']
        assert request(tls, value) == (200, {'ok': True})
        assert subprocess.check_output(['/usr/bin/pbpaste'], timeout=10).decode() == value['text']
        code, result = request(tls, {'op': 'read'})
        assert code == 200 and result == {'ok': True, 'kind': 'text', 'text': value['text']}
        subprocess.run(['/usr/bin/pbcopy'], input=b'newer local fixture', check=True, timeout=10)
        assert request(tls, value) == (200, {'ok': True})
        assert subprocess.check_output(['/usr/bin/pbpaste'], timeout=10) == b'newer local fixture'
        assert request(tls, dict(value, text='conflicting')) == (409, {'ok': False, 'code': 'CLIPBOARD_ID_CONFLICT'})
        image = png()
        assert request(tls, {'op': 'write', 'id': '2'*32, 'kind': 'png', 'data': base64.b64encode(image).decode()}) == (200, {'ok': True})
        code, result = request(tls, {'op': 'read'})
        assert code == 200 and result['ok'] is True and result['kind'] == 'png'
        returned = base64.b64decode(result['data'], validate=True)
        assert returned.startswith(b'\x89PNG\r\n\x1a\n') and struct.unpack('>II', returned[16:24]) == (2, 3)
        # Android's explicit photo picker still uses this endpoint.
        assert request(tls, image, image=True) == (200, {'ok': True, 'width': 2, 'height': 3})
        truncated = base64.b64encode(image[:33]).decode()
        assert request(tls, {'op': 'write', 'id': '3'*32, 'kind': 'png', 'data': truncated})[0] != 200
        assert request(tls, {'op': 'read'})[1]['kind'] == 'png'
        passed(CASES[0])

        # No owner supplied by the remote peer is accepted, and revocation is
        # checked again even when TLS itself is reused successfully.
        assert request(tls, write())[0] == 400
        reused = http.client.HTTPSConnection('127.0.0.1', 48791, context=tls, timeout=20)
        try:
            assert request(tls, {'op': 'read'}, reused)[0] == 200
            connection = reused.sock
            known = json.loads(original)
            known['root']['named_devices'][0]['enabled'] = False
            clients.write_text(json.dumps(known))
            assert reused.sock is connection
            assert request(tls, dict(value, id='4'*32), reused)[0] == 403
            assert request(tls, {'op': 'read'}, reused)[0] == 403
            assert request(tls, {'op': 'observe'}, reused)[0] == 403
        finally:
            clients.write_bytes(original)
            reused.close()
        passed(CASES[1])
        worker = child_pid(process.pid)
        os.kill(worker, signal.SIGKILL)
        wait_absent(worker)
        assert request(tls, dict(value, id='5'*32))[0] == 200
        replacement = child_pid(process.pid)
        assert replacement != worker
        worker = replacement
        passed(CASES[2])
        desktop = subprocess.run(['node', str(Path(__file__).with_name('test_host_clipboard_client.cjs'))]
                                 + ([str(app_directory)] if app_directory else []),
                                 input=json.dumps({'cert': (state/'cacert.pem').read_text(), 'key': (state/'cakey.pem').read_text(),
                                                   'png': base64.b64encode(png()).decode()}).encode(),
                                 capture_output=True, timeout=30)
        assert desktop.returncode == 0 and desktop.stderr == b'', 'Production desktop clipboard transport failed: '+desktop.stderr.decode()
        assert json.loads(desktop.stdout) == {'passed': True, 'text': True, 'png': True}
        process.stdin.close()
        finish(process, status)
        wait_absent(worker)
        passed(CASES[3])
    finally:
        clients.write_bytes(original)
        if process.poll() is None:
            process.stdin.close()
            finish(process, status)

    launcher = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), str(binary), str(state)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    held = None
    try:
        assert select.select([launcher.stdout], [], [], 20)[0]
        owned = json.loads(launcher.stdout.readline(4096))
        held = owned['holder']
        launcher.stdin.write(b'crash\n')
        launcher.stdin.close()
        assert launcher.wait(timeout=5) == 17
        wait_absent(owned['pid'])
        passed(CASES[4])
    finally:
        if held is not None:
            try: os.kill(held, signal.SIGTERM)
            except ProcessLookupError: pass
        if launcher.poll() is None:
            launcher.kill(); launcher.wait()

    for extra in [['--owner-pid', '1'], ['--managed-files']]:
        command = [str(binary), '--managed-clipboard', '--owner-pid', str(os.getpid()), '--state-dir', str(state), *extra]
        rejected = subprocess.run(command, input=b'', capture_output=True, timeout=5)
        assert rejected.returncode == 2 and rejected.stdout == b'' and rejected.stderr.strip() == b'HOST_OWNER_INVALID'
    passed(CASES[5])
    passed(CASES[6])


if __name__ == '__main__':
    assert os.environ.get('CI') == 'true' and sys.platform == 'darwin'
    owner_launcher(Path(sys.argv[1]), Path(sys.argv[2]))
