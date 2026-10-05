"""Install reviewed, checksum-verified binaries into isolated ClipRelay services.

Run as root from a staged directory containing this file, the deployment files,
headscale, cliprelay-pairing, and checksums.json. Existing Caddy content is backed
up and checked before a reload. No credentials are emitted to stdout.
"""
from pathlib import Path
import datetime
import hashlib
import json
import os
import pwd
import shutil
import subprocess
import tempfile
import time
import urllib.request

stage = Path(__file__).resolve().parent
assert os.geteuid() == 0, 'Run with sudo.'
HEADSCALE_SHA256 = '212ed0a884c0d3541e094c4bebbe94397df6f4e01bd3d7f059c520cb55e0d757'
checksums = json.loads((stage / 'checksums.json').read_text())
assert checksums['headscale'] == HEADSCALE_SHA256
for name, digest in checksums.items():
    assert Path(name).name == name
    assert hashlib.sha256((stage / name).read_bytes()).hexdigest() == digest, name

def run(*args):
    r = subprocess.run(args, capture_output=True, text=True, timeout=45)
    if r.returncode:
        raise RuntimeError(f'{args[0]} failed: {r.stderr[:2000]}')
    return r.stdout.strip()

def atomic(path, data, mode=0o644, owner=None):
    fd, tmp = tempfile.mkstemp(prefix='.cliprelay-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        if owner:
            os.chown(tmp, owner.pw_uid, owner.pw_gid)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

def healthy(url):
    for _ in range(30):
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return
        except OSError:
            time.sleep(.5)
    raise RuntimeError('Service did not become healthy: ' + url)

config = Path('/etc/caddy/Caddyfile')
original = config.read_bytes()
site = b'124-221-36-36.anyip.dev:8443, 124-221-36-36.anyip.dev:443 {'
include = b'\n\timport /etc/caddy/cliprelay-network.caddy'
assert original.count(site) == 1, 'Existing HTTPS site changed; review before installing.'
candidate = original if include in original else original.replace(site, site + include)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
backup = Path('/var/backups/cliprelay') / ('network-' + stamp)
backup.mkdir(parents=True, mode=0o700)
(backup / 'Caddyfile').write_bytes(original)
update_manifests = [Path('/srv/cliprelay-updates/update.json'), Path('/srv/cliprelay-updates/windows/update.json')]
manifest_hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in update_manifests if p.exists()}

try:
    user = pwd.getpwnam('cliprelay-network')
except KeyError:
    run('useradd', '--system', '--home-dir', '/var/lib/cliprelay-network', '--shell', '/usr/sbin/nologin', 'cliprelay-network')
    user = pwd.getpwnam('cliprelay-network')

bin_dir = Path('/usr/local/lib/cliprelay-network')
config_dir = Path('/etc/cliprelay-network')
state_dir = Path('/var/lib/cliprelay-network')
for p in (bin_dir, config_dir, state_dir):
    p.mkdir(parents=True, exist_ok=True)
os.chmod(state_dir, 0o700)
os.chown(state_dir, user.pw_uid, user.pw_gid)
for name in ('headscale', 'cliprelay-pairing', 'rotate-key.py'):
    atomic(bin_dir / name, (stage / name).read_bytes(), 0o755)
for name in ('headscale.yaml', 'policy.json'):
    atomic(config_dir / name, (stage / name).read_bytes(), 0o640, user)
for name in ('cliprelay-headscale.service', 'cliprelay-pairing.service', 'cliprelay-network-key.service', 'cliprelay-network-key.timer'):
    atomic(Path('/etc/systemd/system') / name, (stage / name).read_bytes())
route = Path('/etc/caddy/cliprelay-network.caddy')
old_route = route.read_bytes() if route.exists() else None
atomic(route, (stage / 'cliprelay-network.caddy').read_bytes())
temp_config = backup / 'Caddyfile.candidate'
temp_config.write_bytes(candidate)
# Validate before changing the live reverse proxy configuration.
run('caddy', 'validate', '--config', str(temp_config), '--adapter', 'caddyfile')
run('systemctl', 'daemon-reload')
run('systemctl', 'enable', '--now', 'cliprelay-headscale')
healthy('http://127.0.0.1:18080/health')
headscale = [str(bin_dir / 'headscale'), '--config', str(config_dir / 'headscale.yaml')]
run(*headscale, 'policy', 'check', '--file', str(config_dir / 'policy.json'))
key_path = state_dir / 'headscale-api-key'
if not key_path.exists():
    secret = run(*headscale, 'apikeys', 'create', '--expiration', '90d')
    assert secret and '\n' not in secret, 'Unexpected credential output; refusing to write.'
    atomic(key_path, secret.encode(), 0o600, user)
run('systemctl', 'enable', '--now', 'cliprelay-pairing')
healthy('http://127.0.0.1:18081/health')
run('systemctl', 'enable', '--now', 'cliprelay-network-key.timer')
try:
    assert config.read_bytes() == original, 'Caddy changed during staging.'
    atomic(config, candidate)
    run('caddy', 'validate', '--config', str(config), '--adapter', 'caddyfile')
    run('systemctl', 'reload', 'caddy')
    for path, digest in manifest_hashes.items():
        assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest, 'Update manifest changed.'
except Exception:
    atomic(config, original)
    if old_route is not None:
        atomic(route, old_route)
    run('systemctl', 'reload', 'caddy')
    raise
print(json.dumps({'installed': True, 'backup': str(backup), 'updatesUnchanged': True}))
