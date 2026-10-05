"""Rotate the server-only Headscale API credential; never print either key."""
from pathlib import Path
import os
import pwd
import subprocess
import tempfile

state = Path('/var/lib/cliprelay-network')
user = pwd.getpwnam('cliprelay-network')
result = subprocess.run([
    '/usr/local/lib/cliprelay-network/headscale', '--config',
    '/etc/cliprelay-network/headscale.yaml', 'apikeys', 'create', '--expiration', '90d',
], capture_output=True, text=True, timeout=30, check=True)
value = result.stdout.strip()
assert value and '\n' not in value
fd, tmp = tempfile.mkstemp(prefix='.api-key-', dir=state)
try:
    with os.fdopen(fd, 'w') as output:
        output.write(value)
        output.flush()
        os.fsync(output.fileno())
    os.chmod(tmp, 0o600)
    os.chown(tmp, user.pw_uid, user.pw_gid)
    os.replace(tmp, state / 'headscale-api-key')
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
subprocess.run(['systemctl', 'restart', 'cliprelay-pairing'], check=True, timeout=30)
