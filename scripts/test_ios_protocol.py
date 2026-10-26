"""Compile and exercise iOS protocol modules on macOS with local synthetic TLS peers."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import platform
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]


def test(output):
    if platform.system() != 'Darwin':
        raise RuntimeError('Native Foundation and Security tests require macOS')
    with tempfile.TemporaryDirectory(prefix='cliprelay-ios-protocol-') as temporary:
        directory = Path(temporary)
        openssl = shutil.which('openssl')
        def command(*args):
            return subprocess.check_output(args, cwd=directory, stderr=subprocess.STDOUT)
        for name in ('server', 'client', 'wrong'):
            command(openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', name+'.key', '-out', name+'.crt',
                    '-subj', '/CN=ClipRelay iOS fixture '+name, '-days', '1')
            command(openssl, 'x509', '-in', name+'.crt', '-outform', 'DER', '-out', name+'.der')
        command(openssl, 'pkcs12', '-export', '-inkey', 'client.key', '-in', 'client.crt', '-out', 'client.p12',
                '-passout', 'pass:limelight', '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1')
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                seen.append((self.server.role, self.path))
                self.rfile.read(int(self.headers.get('Content-Length', 0)))
                if self.path == '/slow':
                    time.sleep(3)
                status = 302 if self.path == '/redirect' else 403 if self.path == '/revoked' else 200
                data = b'x'*4096 if self.path in ('/large', '/chunked') else b'[]' if self.path == '/invalid' else b'{"ok":true}'
                self.send_response(status)
                if self.path == '/redirect':
                    self.send_header('Location', '/leak')
                if self.path != '/chunked':
                    self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
                    pass
            def do_DELETE(self):
                seen.append((self.server.role, self.path))
                self.send_response(204); self.end_headers()
        servers = []
        for base in range(32100, 33000, 11):
            try:
                for role, offset in [('wrong', 2), ('server', 3)]:
                    server = ThreadingHTTPServer(('127.0.0.1', base + offset), Handler)
                    server.daemon_threads = True; server.role = role; servers.append(server)
                break
            except OSError:
                for server in servers: server.server_close()
                servers = []
        if len(servers) != 2:
            raise RuntimeError('No fixture ports available')
        for server in servers:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.load_cert_chain(str(directory/(server.role+'.crt')), str(directory/(server.role+'.key')))
            context.load_verify_locations(str(directory/'client.crt')); context.verify_mode = ssl.CERT_REQUIRED
            server.socket = context.wrap_socket(server.socket, server_side=True)
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            nonce = '0123456789abcdef0123456789abcdef'; now = int(time.time())
            digest = hashlib.sha256(b'cliprelay-lan-pair-v1\n'+(directory/'server.der').read_bytes()+
                                    (directory/'client.der').read_bytes()+nonce.encode()).hexdigest()
            fixture = {'server': str(directory/'server.der'), 'client': str(directory/'client.der'),
                       'pkcs12': str(directory/'client.p12'), 'port': base, 'nonce': nonce, 'now': now,
                       'ticket': {'id': digest[:32], 'verification': ' '.join(digest[i:i+4] for i in (0, 4, 8)).upper(),
                                  'expires': now+120, 'feedback': {'protocol': 1, 'receipt': '1'*32},
                                  'native': {'protocol': 1, 'id': '2'*32}}}
            (directory/'fixture.json').write_text(json.dumps(fixture))
            native = ROOT/'ios-app/native'
            executable = directory/'protocol-test'
            subprocess.run(['xcrun', 'clang', '-fobjc-arc', '-fmodules', '-Wno-deprecated-declarations',
                            '-framework', 'Foundation', '-framework', 'Security', '-I', str(native),
                            str(ROOT/'ios-app/tests/protocol.m'), str(native/'CRTransport.m'), str(native/'CRPairingTicket.m'),
                            '-o', str(executable)], check=True)
            result = json.loads(subprocess.check_output([str(executable), str(directory/'fixture.json')], timeout=45))
            assert result['passed'] and not any(role == 'wrong' or path == '/leak' for role, path in seen)
            assert ('server', '/v1/pair/cleanup') in seen
            result['requestBoundaryChecked'] = True
            result['sourceHashes'] = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                                      for p in [native/'CRTransport.m', native/'CRPairingTicket.m', ROOT/'ios-app/tests/protocol.m', Path(__file__)]}
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
            print(json.dumps(result))
        finally:
            for server in servers:
                server.shutdown(); server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'.tools/ios-protocol/report.json')
    test(parser.parse_args().output)
