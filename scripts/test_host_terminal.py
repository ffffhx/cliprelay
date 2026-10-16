"""Exercise the complete paired Mac terminal HTTP boundary on disposable CI."""
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import signal
import ssl
import subprocess
import sys
import time

CASES = ['tls-terminal-shells-sessions-and-lost-replies',
         'tls-terminal-native-mouse-lease-and-resize',
         'tls-terminal-desktop-client',
         'tls-terminal-owner-isolation-and-live-revocation',
         'tls-terminal-output-gap-and-worker-restart',
         'terminal-eof-reaps-owned-sessions']


def request(tls, command, connection=None):
    own = connection is None
    connection = connection or http.client.HTTPSConnection('127.0.0.1', 48791, context=tls, timeout=15)
    try:
        connection.request('POST', '/v1/terminal', json.dumps(command), {'Content-Type': 'application/json'})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        if own:
            connection.close()


def checked(tls, command):
    status, reply = request(tls, command)
    assert status == 200 and reply['ok'] is True, (command['op'], status, reply)
    return reply


def eventually(condition, timeout=8):
    until = time.monotonic()+timeout
    while time.monotonic() < until:
        if condition():
            return
        time.sleep(.04)
    raise AssertionError('Native terminal condition timed out')


def octal(text):
    return ''.join('\\%03o' % value for value in text.encode())


def read_all(tls, session):
    offset, chunks = 0, []
    for _ in range(64):
        reply = checked(tls, dict(session, op='read', offset=offset))
        data = base64.b64decode(reply.get('data', ''), validate=True)
        assert reply['offset'] >= offset and reply['next'] == reply['offset']+len(data)
        chunks.append(data)
        offset = reply['next']
        if offset == reply['session']['end']:
            return b''.join(chunks).decode(errors='replace'), reply['session']
        assert data
    raise AssertionError('Terminal output did not paginate within its bound')


def open_session(tls, shell, identifier=None):
    inventory = checked(tls, {'op': 'list'})
    assert inventory['shells'] == ['zsh', 'bash'] and inventory['mouseProtocol'] == 1
    command = {'op': 'open', 'instance': inventory['instance'], 'id': identifier or secrets.token_hex(16),
               'shell': shell, 'columns': 100, 'rows': 30, 'sequence': inventory['nextOpen']}
    first = checked(tls, command)
    again = checked(tls, command)
    assert first['session']['openSequence'] == again['session']['openSequence'] == command['sequence']
    return {'instance': first['instance'], 'id': command['id']}


def write(tls, session, sequence, text, paste=False):
    command = dict(session, op='paste' if paste else 'write', sequence=sequence, data=base64.b64encode(text.encode()).decode())
    assert checked(tls, command)['session']['acceptedSequence'] == sequence
    return command


def shell_pid(tls, session):
    write(tls, session, 1, "printf '\\nCLIPRELAY_HTTP_PID_%s_END\\n' \"$$\"\r")
    found = []
    def read():
        match = re.search(r'(?:^|\n)CLIPRELAY_HTTP_PID_([0-9]+)_END\r?\n', read_all(tls, session)[0])
        if match:
            found.append(int(match[1]))
        return bool(found)
    eventually(read)
    return found[0]


def mouse_receiver():
    import select
    import termios
    import tty
    assert sys.platform == 'darwin' and os.environ.get('GITHUB_ACTIONS') == 'true'
    saved = termios.tcgetattr(0)
    try:
        tty.setraw(0)
        os.write(1, b'\x1b[?1002;1006hHTTP_MOUSE_READY\r\n')
        captured = b''
        until = time.monotonic()+8
        while time.monotonic() < until and len(captured) < 8192:
            if select.select([0], [], [], .1)[0]:
                captured += os.read(0, 512)
                if captured.endswith(b'm'):
                    os.write(1, b'\x1b[?1002;1006l\r\nHTTP_MOUSE_CAPTURE_'+base64.b64encode(captured)+b'_END\r\n')
                    return
        raise AssertionError('Native mouse cleanup missing')
    finally:
        termios.tcsetattr(0, termios.TCSANOW, saved)


def receiver_command():
    return shlex.quote(sys.executable)+' '+shlex.quote(str(Path(__file__).resolve()))+' --mouse-receiver\r'


def run_mouse(tls, session, sequence):
    for index, resize in enumerate((False, True)):
        write(tls, session, sequence+index, receiver_command())
        eventually(lambda: read_all(tls, session)[1]['mouse']['mode'] == 1002)
        state = read_all(tls, session)[1]['mouse']
        column, row = (90, 25) if resize else (5, 7)
        press = dict(session, op='mouse', sequence=state['acceptedSequence']+1, action='press', epoch=state['epoch'],
                     gesture=state['nextGesture'], column=column, row=row, button=0, modifiers=0)
        checked(tls, press)
        eventually(lambda: read_all(tls, session)[1]['mouse']['writtenSequence'] == press['sequence'])
        expected = f'\x1b[<0;{column};{row}M'
        if resize:
            sized = checked(tls, dict(session, op='resize', columns=20, rows=10))
            assert sized['session']['mouse']['epoch'] > press['epoch']
            assert request(tls, dict(press, sequence=press['sequence']+1, action='move'))[1]['code'] == 'TERMINAL_MOUSE_MODE'
            expected += '\x1b[<0;20;10m'
        else:
            move = dict(press, sequence=press['sequence']+1, action='move', column=6, row=8)
            checked(tls, move)
            checked(tls, move)
            expected += '\x1b[<32;6;8M\x1b[<0;6;8m'
        expected = base64.b64encode(expected.encode()).decode()
        eventually(lambda: 'HTTP_MOUSE_CAPTURE_'+expected+'_END' in read_all(tls, session)[0], 5)
        eventually(lambda: read_all(tls, session)[1]['mouse']['buttons'] == 0)


def worker_pid(parent):
    candidates = subprocess.check_output(['pgrep', '-P', str(parent)], text=True).split()
    found = []
    for candidate in candidates:
        args = subprocess.check_output(['ps', '-p', candidate, '-o', 'command='], text=True)
        if '--managed-terminal --owner-pid '+str(parent)+' --state-dir ' in args:
            found.append(int(candidate))
    assert len(found) == 1
    return found[0]


def run(binary, state, payload, tls, start, read_status, finish, wait_absent, passed, app_directory=None):
    assert sys.platform == 'darwin' and os.environ.get('CI') == 'true' and os.geteuid() != 0
    process = start(binary, state, payload)
    status = read_status(process)
    clients = state/'clients.json'
    original = clients.read_bytes()
    sessions, pids = [], []
    try:
        assert request(tls, {'op': 'list', 'owner': 'a'*64})[0] == 400
        for shell in ('bash', 'zsh'):
            session = open_session(tls, shell)
            sessions.append(session)
            pids.append(shell_pid(tls, session))
            marker = 'HTTP-terminal-'+shell+'-中文-👋'
            command = write(tls, session, 2, "printf '\\n"+octal(marker)+"\\n'\r")
            checked(tls, command)
            eventually(lambda: marker in read_all(tls, session)[0])
            assert read_all(tls, session)[0].count(marker) == 1
            text = 'a'*14000
            write(tls, session, 3, "printf '%s' '"+text+"' | shasum -a 256\r", paste=True)
            eventually(lambda: hashlib.sha256(text.encode()).hexdigest() in read_all(tls, session)[0], 35)
        passed(CASES[0])
        for session in sessions:
            run_mouse(tls, session, 4)
        passed(CASES[1])

        desktop = subprocess.run(['node', str(Path(__file__).with_name('test_host_terminal_client.cjs'))]
                                 + ([str(app_directory)] if app_directory else []),
                                 input=json.dumps({'cert': (state/'cacert.pem').read_text(), 'key': (state/'cakey.pem').read_text(),
                                                   'mouseCommand': receiver_command()}).encode(), capture_output=True, timeout=60)
        assert desktop.returncode == 0, desktop.stderr.decode()
        assert json.loads(desktop.stdout) == {'passed': True, 'shells': ['bash', 'zsh'], 'lostReplies': True, 'mouseExpiry': True}
        passed(CASES[2])

        other = state.parent/'terminal-other'
        other.mkdir()
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=terminal-other',
                        '-keyout', str(other/'key.pem'), '-out', str(other/'cert.pem')], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        other_tls = ssl.create_default_context(cafile=str(state/'cacert.pem'))
        other_tls.load_cert_chain(str(other/'cert.pem'), str(other/'key.pem'))
        database = json.loads(original)
        database['root']['named_devices'].append({'cert': (other/'cert.pem').read_text(), 'enabled': True})
        clients.write_text(json.dumps(database))
        assert not checked(other_tls, {'op': 'list'}).get('sessions')
        assert request(other_tls, dict(sessions[0], op='read', offset=0))[1]['code'] == 'TERMINAL_NOT_FOUND'
        other_session = open_session(other_tls, 'bash', sessions[0]['id'])
        other_pid = shell_pid(other_tls, other_session)
        reused = http.client.HTTPSConnection('127.0.0.1', 48791, context=tls, timeout=15)
        try:
            assert request(tls, {'op': 'list'}, reused)[0] == 200
            connection = reused.sock
            database['root']['named_devices'][0]['enabled'] = False
            clients.write_text(json.dumps(database))
            assert reused.sock is connection and request(tls, dict(sessions[0], op='read', offset=0), reused)[0] == 403
            for pid in pids:
                wait_absent(pid)
            assert read_all(other_tls, other_session)[1]['state'] == 'running'
        finally:
            clients.write_bytes(original)
            reused.close()
        wait_absent(other_pid)
        assert all(s['state'] == 'revoked' for s in checked(tls, {'op': 'list'})['sessions'] if s['id'] in [x['id'] for x in sessions])
        passed(CASES[3])

        live = open_session(tls, 'bash')
        live_pid = shell_pid(tls, live)
        marker = 'terminal-gap-end'
        write(tls, live, 2, "head -c 1200000 /dev/zero | tr '\\000' a; printf '\\n"+octal(marker)+"\\n'\r")
        eventually(lambda: marker in read_all(tls, live)[0])
        gap = checked(tls, dict(live, op='read', offset=0))
        assert gap['gap'] and gap['offset'] > 0 and gap['session']['end']-gap['session']['start'] == 1048576
        worker = worker_pid(process.pid)
        os.kill(worker, signal.SIGKILL)
        wait_absent(worker)
        wait_absent(live_pid)
        replacement = checked(tls, {'op': 'list'})
        assert replacement['instance'] != live['instance'] and replacement['nextOpen'] == 1 and not replacement.get('sessions')
        assert request(tls, dict(live, op='read', offset=0))[1]['code'] == 'TERMINAL_STALE'
        passed(CASES[4])
        live = open_session(tls, 'zsh')
        live_pid = shell_pid(tls, live)
        worker = worker_pid(process.pid)
        process.stdin.close()
        finish(process, status)
        wait_absent(worker)
        wait_absent(live_pid)
        passed(CASES[5])
    finally:
        clients.write_bytes(original)
        if process.poll() is None:
            process.stdin.close()
            finish(process, status)


if __name__ == '__main__':
    assert sys.argv[1:] == ['--mouse-receiver']
    mouse_receiver()
