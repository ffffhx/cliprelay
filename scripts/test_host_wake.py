"""Native Mac inventory/worker and paired desktop/Android protocol acceptance.

Read-only native enumeration. Never broadcasts on the runner's LAN; controlled
datagrams are covered separately by the host's loopback UDP tests.
"""
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import select
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def line(process):
    assert select.select([process.stdout], [], [], 10)[0], 'Wake worker response timed out'
    raw = process.stdout.readline(65537)
    assert raw.endswith(b'\n') and len(raw) <= 65536
    value = json.loads(raw)
    assert value['ok'] and value['supported'] and value['platform'] == 'macos' and value['wakeVerified'] is False
    assert value['adapters'], 'Native fixture requires a system Ethernet or Wi-Fi interface'
    for item in value['adapters']:
        assert all(item[key] == 'unknown' for key in ['magicPacket', 'powerManagement', 'wakeArmed', 'configuration'])
    return value


def run(binary, state, payload, tls, start, read_status, finish, wait_absent, passed, app_directory):
    worker_args = [str(binary), '--managed-wake', '--owner-pid', str(os.getpid()), '--state-dir', str(state)]
    worker = subprocess.Popen(worker_args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    try:
        worker.stdin.write(b'wake-status\n')
        line(worker)
        worker.stdin.close()
        assert worker.wait(timeout=10) == 0 and worker.stderr.read() == b''
        passed('wake-native-read-only-inventory-and-worker-EOF')
    finally:
        if worker.poll() is None:
            worker.kill(); worker.wait(timeout=10)
    for command in [b'send\n', b'wake-status\nextra', b'x'*256+b'\n']:
        result = subprocess.run(worker_args, input=command, capture_output=True, timeout=10)
        assert result.returncode != 0 and result.stderr.strip() == b'WAKE_PROTOCOL_INVALID'
    passed('wake-worker-rejects-send-and-malformed-input')

    process = start(binary, state, payload)
    status = read_status(process)
    original = (state/'clients.json').read_bytes()
    connection = http.client.HTTPSConnection('127.0.0.1', 48791, context=tls, timeout=10)
    def rpc(body):
        connection.request('POST', '/v1/wake', json.dumps(body), {'Content-Type': 'application/json'})
        response = connection.getresponse(); raw = response.read(65537)
        assert len(raw) <= 65536
        return response.status, json.loads(raw)
    try:
        code, inventory = rpc({'op': 'status'})
        assert code == 200 and inventory['platform'] == 'macos' and inventory['wakeVerified'] is False
        assert inventory['adapters']
        networks = {str(ipaddress.ip_network(f"{item['address']}/{item['prefix']}", strict=False))
                    for adapter in inventory['adapters'] for item in adapter['addresses']}
        absent = next(network for network in ['192.0.2.0/30', '198.51.100.0/30', '203.0.113.0/30'] if network not in networks)
        # The production manager must own and terminate the actual native worker.
        children = subprocess.check_output(['pgrep', '-P', str(process.pid)], text=True).split()
        workers = [int(pid) for pid in children if '--managed-wake' in subprocess.check_output(['ps', '-p', pid, '-o', 'command='], text=True)]
        assert len(workers) == 1
        passed('wake-managed-host-launches-owned-native-provider')

        config = {'cert': (state/'cacert.pem').read_text(), 'key': (state/'cakey.pem').read_text(), 'absentNetwork': absent}
        arguments = ['node', str(ROOT/'scripts/test_host_wake_client.cjs')]
        if app_directory is not None:
            arguments.append(str(app_directory))
        result = subprocess.run(arguments, input=json.dumps(config).encode(), capture_output=True, timeout=20)
        assert result.returncode == 0, result.stderr.decode()
        assert json.loads(result.stdout)['datagramsSent'] == 0
        passed('wake-desktop-native-inventory-and-off-LAN-send-rejection-over-mutual-TLS')

        # The JVM exercises the shipped parser and saved identity without
        # another send or any Android device control.
        run_android(state, absent)
        passed('wake-Android-shipped-parser-native-inventory-over-mutual-TLS')

        (state/'clients.json').write_text('{"root":{"named_devices":[]}}')
        code, denied = rpc({'op': 'status'})
        assert code == 403 and denied['code'] == 'WAKE_UNPAIRED'
        code, denied = rpc({'op': 'send', 'id': 'e'*32, 'mac': '02:11:22:33:44:55', 'network': absent})
        assert code == 403 and denied['code'] == 'WAKE_UNPAIRED'
        passed('wake-established-TLS-revocation-blocks-inventory-and-sending')
        connection.close()
        (state/'clients.json').write_bytes(original)
        process.stdin.close(); finish(process, status)
        for pid in workers:
            wait_absent(pid)
        passed('wake-host-EOF-reaps-native-worker')
    finally:
        connection.close()
        (state/'clients.json').write_bytes(original)
        if process.poll() is None:
            process.stdin.close()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=10)


def run_android(state, absent):
    from test_host_terminal_android import JSON_SHA256
    with tempfile.TemporaryDirectory(prefix='cliprelay-android-wake-') as temporary:
        directory = Path(temporary); jar = directory/'json.jar'
        with urllib.request.urlopen('https://repo.maven.apache.org/maven2/org/json/json/20260814/json-20260814.jar', timeout=20) as response:
            body = response.read(256*1024)
        assert hashlib.sha256(body).hexdigest() == JSON_SHA256
        jar.write_bytes(body)
        source = ROOT/'android-app/remote-engine/src/main/java/com/limelight/nvstream/wol'
        subprocess.run(['javac', '--release', '17', '-encoding', 'UTF-8', '-cp', str(jar), '-d', str(directory),
                        str(source/'WakeState.java'), str(source/'WakeSelection.java'), str(ROOT/'scripts/WakeMacInterop.java')], check=True, timeout=30)
        result = subprocess.run(['java', '-Xmx128m', '-cp', os.pathsep.join([str(directory), str(jar)]), 'WakeMacInterop'],
                                input=json.dumps({'state': str(state), 'absentNetwork': absent}).encode(), capture_output=True, timeout=30)
        assert result.returncode == 0, result.stderr.decode()
        assert json.loads(result.stdout)['passed'] is True
