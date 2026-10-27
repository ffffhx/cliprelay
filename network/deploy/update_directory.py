"""Update the existing ClipRelay pairing service, with health checks and rollback."""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request


def healthy():
    credential = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")
    request = urllib.request.Request("http://127.0.0.1:18081/v1/directory", headers={"Authorization": "Bearer " + credential})
    for attempt in range(15):
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                payload = json.load(response)
            if not isinstance(payload.get("devices"), list):
                raise RuntimeError("Unexpected directory response")
            return
        except Exception:
            if attempt == 14:
                raise
            time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--sha256", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("Run with the existing server administrator account.")
    digest = hashlib.sha256(args.binary.read_bytes()).hexdigest()
    if digest != args.sha256.lower():
        raise SystemExit("Binary SHA-256 mismatch")
    target = Path("/usr/local/lib/cliprelay-network/cliprelay-pairing")
    if not target.is_file() or target.is_symlink():
        raise SystemExit("Existing pairing executable not found")
    subprocess.run(["systemctl", "is-active", "--quiet", "cliprelay-pairing"], check=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    backup = Path("/var/backups/cliprelay") / ("directory-" + stamp)
    backup.mkdir(parents=True, mode=0o700)
    shutil.copy2(target, backup / "cliprelay-pairing")
    candidate = target.with_name(".cliprelay-pairing-" + stamp)
    try:
        with candidate.open("xb") as output:
            output.write(args.binary.read_bytes())
            output.flush()
            os.fsync(output.fileno())
        os.chmod(candidate, 0o755)
        os.chown(candidate, 0, 0)
        os.replace(candidate, target)
        subprocess.run(["systemctl", "restart", "cliprelay-pairing"], check=True)
        healthy()
    except Exception:
        shutil.copy2(backup / "cliprelay-pairing", candidate)
        os.replace(candidate, target)
        subprocess.run(["systemctl", "restart", "cliprelay-pairing"], check=False)
        raise
    print(json.dumps({"updated": True, "sha256": digest, "backup": str(backup)}))


if __name__ == "__main__":
    main()
