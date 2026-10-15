"""Exercise the actual owned network process without a production coordinator."""
import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time


def run(binary):
    with tempfile.TemporaryDirectory(prefix='cliprelay-network-owner-') as temporary:
        directory = Path(temporary)
        state = directory / 'node'
        process = subprocess.Popen([str(binary), '--state-dir', str(state)], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        lines = queue.Queue()
        reader = threading.Thread(target=lambda: [lines.put(line) for line in process.stdout], daemon=True)
        reader.start()
        request = {'version': 1, 'controlUrl': 'https://127.0.0.1:9', 'hostname': 'cr-012345678901234567890123',
                   'authKey': 'fixture-sensitive-enrollment-key', 'peerIP': '100.64.0.2'}
        try:
            process.stdin.write(json.dumps(request).encode() + b'\n')
            process.stdin.flush()
            initial = json.loads(lines.get(timeout=12))
            assert initial == {'type': 'status', 'ready': False, 'port': 0, 'path': 'connecting'}, initial
            # Let production tsnet enter registration; the only coordinator is a
            # deliberately closed loopback socket. EOF must interrupt this wait.
            time.sleep(.3)
            start = time.monotonic()
            process.stdin.close()
            process.wait(timeout=8)
            elapsed = round((time.monotonic() - start) * 1000)
            reader.join(timeout=2)
            stderr = process.stderr.read()
            stdout = b''.join(list(lines.queue))
            assert process.returncode == 0, (process.returncode, stdout.decode(errors='replace'))
            assert b'fixture-sensitive-enrollment-key' not in stderr + stdout
            # The CLI must reject regular-file stdin, even if its contents are
            # valid. Credential files are never an alternate launch mechanism.
            input_file = directory / 'empty-input'
            input_file.write_bytes(b'')
            with input_file.open('rb') as stream:
                rejected = subprocess.run([str(binary), '--state-dir', str(directory / 'rejected')], stdin=stream,
                                          capture_output=True, timeout=5,
                                          creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            assert rejected.returncode == 2 and not (directory / 'rejected').exists()
            return {'passed': True, 'ownerCloseToExitMs': elapsed, 'exitCode': process.returncode,
                    'pendingRegistrationCancelled': True, 'regularFileInputRejected': True,
                    'credentialInOutput': False, 'configuredCoordinator': 'closed-loopback-fixture'}
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    result = run(args.binary.resolve(strict=True))
    if args.report:
        args.report.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))
