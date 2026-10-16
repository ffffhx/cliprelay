"""Disposable Mac CI acceptance of the packaged terminal worker and guardian."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time


class Worker:
    def __init__(self, binary, directory):
        self.process = subprocess.Popen([str(binary), '--managed-terminal', '--owner-pid', str(os.getpid()), '--state-dir', str(directory)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.lines = queue.Queue(maxsize=8)
        def read():
            try:
                while True:
                    raw = self.process.stdout.readline(65537)
                    if not raw:
                        break
                    if len(raw) > 65536 or not raw.endswith(b'\n'):
                        raise RuntimeError('unbounded worker response')
                    self.lines.put(json.loads(raw), timeout=5)
            except Exception as error:
                self.lines.put(error, timeout=5)
            finally:
                self.lines.put(None, timeout=5)
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()

    def rpc(self, body):
        self.process.stdin.write(json.dumps(body).encode()+b'\n')
        self.process.stdin.flush()
        value = self.lines.get(timeout=8)
        if isinstance(value, Exception):
            raise value
        if not isinstance(value, dict):
            raise RuntimeError('worker closed before response')
        return value

    def close(self, kill=False):
        if self.process.poll() is None:
            if kill:
                self.process.kill()
            else:
                self.process.stdin.close()
        try:
            self.process.wait(timeout=7)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=3)
            raise RuntimeError('worker failed bounded shutdown')
        self.reader.join(timeout=2)
        assert not self.reader.is_alive(), 'worker stdout retained'
        self.process.stdout.close()
        self.process.stdin.close()


def eventually(predicate, seconds=6):
    deadline = time.monotonic()+seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.04)
    raise AssertionError('native terminal condition timed out')


def gone(pid):
    try:
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True


def octal(text):
    return ''.join('\\%03o' % value for value in text.encode())


def open_session(worker, shell):
    owner = 'a'*64
    assert worker.rpc({'op': 'sync', 'owners': [owner]})['ok']
    inventory = worker.rpc({'op': 'list', 'owner': owner})
    assert inventory['shells'] == ['zsh', 'bash']
    command = {'op': 'open', 'owner': owner, 'instance': inventory['instance'], 'id': 'b'*32,
               'shell': shell, 'columns': 100, 'rows': 30, 'sequence': inventory['nextOpen']}
    opened = worker.rpc(command)
    assert opened['ok'] and opened['session']['shell'] == shell
    again = worker.rpc(command)
    assert again['ok'] and again['session']['id'] == opened['session']['id']
    return {'owner': owner, 'instance': inventory['instance'], 'id': opened['session']['id']}


def read(worker, session):
    # All output in these tests is synthetic and fits the retained output ring.
    offset, chunks = 0, []
    for _ in range(32):
        reply = worker.rpc(dict(session, op='read', offset=offset))
        assert reply['ok'] and not reply['gap'] and reply['offset'] == offset
        data = base64.b64decode(reply.get('data', ''))
        assert reply['next'] == offset+len(data)
        chunks.append(data)
        offset = reply['next']
        if offset == reply['session']['end']:
            return b''.join(chunks).decode(errors='replace')
        assert data, 'output pagination made no progress'
    raise AssertionError('synthetic terminal output exceeded retained ring')


def write(worker, session, sequence, text, paste=False):
    body = dict(session, op='paste' if paste else 'write', sequence=sequence, data=base64.b64encode(text.encode()).decode())
    reply = worker.rpc(body)
    assert reply['ok'] and reply['session']['acceptedSequence'] == sequence
    return body


def shell_pid(worker, session):
    write(worker, session, 1, "printf '\\nCLIPRELAY_CHILD_%s_END\\n' \"$$\"\r")
    found = []
    def detect():
        match = re.search(r'(?:^|\n)CLIPRELAY_CHILD_([0-9]+)_END\r?\n', read(worker, session))
        if match:
            found.append(int(match[1]))
        return bool(found)
    eventually(detect)
    assert found[0] > 1
    return found[0]


def run(binary, report):
    if sys.platform != 'darwin' or os.environ.get('CI') != 'true' or os.environ.get('GITHUB_ACTIONS') != 'true' or os.geteuid() == 0:
        raise RuntimeError('Native terminals require disposable Mac CI and an ordinary user')
    cases = []
    with tempfile.TemporaryDirectory(prefix='cliprelay-terminal-') as directory:
        for shell in ['zsh', 'bash']:
            worker = Worker(binary, directory)
            try:
                session = open_session(worker, shell)
                pid = shell_pid(worker, session)
                cases.append(shell+': inventory and duplicate open')
                marker = 'packaged-terminal-中文-👋'
                command = write(worker, session, 2, "printf '\\n"+octal(marker)+"\\n'\r")
                assert worker.rpc(command)['ok']
                eventually(lambda: marker in read(worker, session))
                assert read(worker, session).count(marker) == 1
                cases.append(shell+': Unicode and lost input ACK deduplication')
                body = 'a'*14000
                write(worker, session, 3, "printf '%s' '"+body+"' | shasum -a 256\r", paste=True)
                digest = hashlib.sha256(body.encode()).hexdigest()
                try:
                    eventually(lambda: digest in read(worker, session), 10)
                except AssertionError:
                    output = read(worker, session)
                    snapshot = worker.rpc(dict(session, op='read', offset=0))['session']
                    print(json.dumps({'shell': shell, 'stage': 'paste', 'session': snapshot,
                                      'outputLength': len(output), 'syntheticOutputTail': output[-800:]}), flush=True)
                    raise
                cases.append(shell+': whole 14 KB paste digest')
                size = worker.rpc(dict(session, op='resize', columns=120, rows=40))
                assert size['ok'] and size['session']['columns'] == 120 and size['session']['rows'] == 40
                write(worker, session, 4, "printf '\\n'; stty size\r")
                eventually(lambda: '40 120' in read(worker, session))
                cases.append(shell+': native resize')
                assert worker.rpc({'op': 'sync', 'owners': []})['ok']
                eventually(lambda: gone(pid))
                assert worker.rpc({'op': 'list', 'owner': session['owner']})['code'] == 'TERMINAL_UNPAIRED'
                assert worker.rpc({'op': 'sync', 'owners': [session['owner']]})['ok']
                receipt = worker.rpc({'op': 'list', 'owner': session['owner']})
                assert receipt['sessions'][0]['state'] == 'revoked'
                cases.append(shell+': live revocation reaps native shell')
            finally:
                worker.close()
        for abrupt in [False, True]:
            worker = Worker(binary, directory)
            try:
                session = open_session(worker, 'bash')
                pid = shell_pid(worker, session)
                write(worker, session, 2, "trap '' HUP; sleep 60\r")
                worker.close(kill=abrupt)
                eventually(lambda: gone(pid))
                cases.append('worker '+('SIGKILL' if abrupt else 'EOF')+' reaps foreground shell through guardian')
            finally:
                worker.close()
    value = {'passed': True, 'scope': 'packaged owned terminal process, not HTTP/client integration',
             'architecture': os.uname().machine, 'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'cases': cases}
    report.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'passed': len(cases), 'report': str(report)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    run(args.binary.resolve(), args.report.resolve())
