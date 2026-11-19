"""Human-input regression through an isolated real Herdr core and Windows PTY.

No model is launched and no existing terminal receives input.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

worker, artifact = (Path(arg).resolve() for arg in sys.argv[1:3])
hc = Path(os.environ['LOCALAPPDATA']) / 'Programs/herdr-core/hc.exe'
session = 'cliprelay-check-' + uuid.uuid4().hex[:12]
env = dict(os.environ, HC_SESSION=session, XDG_STATE_HOME=str(artifact / 'input-core-state'))
for key in ('HC_SOCKET', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_CALLER'):
    env.pop(key, None)
owner = 'b' * 64
setup = artifact / 'test-session.json'
setup.write_text(json.dumps(dict(hc=str(hc), session=session, state=env['XDG_STATE_HOME'])), encoding='utf8')
process = subprocess.Popen([str(worker), '--herdr-probe'], stdin=subprocess.PIPE,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                           encoding='utf8', creationflags=subprocess.CREATE_NO_WINDOW)

def request(op, **fields):
    value = dict(op=op, **fields)
    if op != 'sync':
        value['owner'] = owner
    process.stdin.write(json.dumps(value, ensure_ascii=False) + '\n')
    process.stdin.flush()
    reply = json.loads(process.stdout.readline())
    assert reply['ok'], reply
    return reply

def command(*args):
    result = subprocess.run([str(hc), *args], env=env, capture_output=True,
                            text=True, encoding='utf8', timeout=20, creationflags=subprocess.CREATE_NO_WINDOW)
    assert result.returncode == 0, result.stderr
    return result.stdout

try:
    instance = request('sync', owners=[owner])['instance']
    output = artifact / ('received-input-' + uuid.uuid4().hex[:8] + '.bin')
    command('run', '--bg', '--name', 'cliprelay-keyboard-fixture', str(worker), '--input-fixture', str(output))
    deadline = time.monotonic() + 12
    while not Path(str(output) + '.ready').exists() and time.monotonic() < deadline:
        time.sleep(.1)
    assert Path(str(output) + '.ready').exists(), 'fixture did not start'
    terminal = json.loads(command('ls'))['terminals'][0]['address']
    base = dict(instance=instance, id=uuid.uuid4().hex)
    request('watch', coreSession=session, terminal=terminal, **base)
    message = '手机提交 4827'
    sent = request('send', sequence=1, text=message, **base)
    assert sent['result']['inputCode'] == '', sent
    # Reconciliation of the same receipt must never insert the text twice.
    assert request('send', sequence=1, text=message, **base) == sent
    shifted = request('keys', sequence=2, keys=['shift+left'], **base)
    assert shifted['result']['inputCode'] == '', shifted
    expected = ('\x1b[200~' + message + '\x1b[201~\x1b[13u\x1b[1;2D').encode('utf8')
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        actual = output.read_bytes() if output.exists() else b''
        if actual.endswith(b'\x1b[1;2D'):
            break
        time.sleep(.1)
    assert actual == expected, f'wrong PTY input: {actual!r}'
    print('PASS real PTY received exactly one Chinese paste, Kitty Enter and Shift+Left', flush=True)
    (artifact / 'input-native-result.json').write_text(json.dumps(dict(
        passed=True, bytes=len(actual), duplicateReceiptSentOnce=True,
        keyboardMode='Kitty over ConPTY', isolatedCore=session)), encoding='utf8')
finally:
    setup.unlink(missing_ok=True)
    command('server', 'stop')
    process.stdin.close()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
