"""Publish an immutable Android release through the restricted SSH receiver."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

BASE_URL = "https://124-221-36-36.anyip.dev:8443/cliprelay"


def read_manifest(directory):
    info = json.loads((directory / "update.json").read_text(encoding="utf-8-sig"))
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", info.get("versionName", "")):
        raise ValueError("Invalid versionName")
    if type(info.get("versionCode")) is not int or info["versionCode"] <= 0:
        raise ValueError("Invalid versionCode")
    if not re.fullmatch(r"[0-9a-f]{64}", info.get("sha256", "")):
        raise ValueError("Invalid SHA-256")
    return info


def publication_needed(info, current):
    if current is None or current["versionCode"] < info["versionCode"]:
        return True
    if current["versionCode"] == info["versionCode"]:
        if any(current[field] != info[field] for field in ("versionName", "sha256")):
            raise ValueError("Published version has different content; refusing to replace it")
    return False


def fetch_manifest():
    request = urllib.request.Request(BASE_URL + "/update.json", headers={"Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read(128 * 1024 + 1)
            if len(body) > 128 * 1024:
                raise ValueError("Cloud manifest is too large")
            return json.loads(body)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def verify_package(path, info):
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != info["sha256"]:
        raise ValueError("APK SHA-256 does not match update.json")


def upload(archive, key, known_hosts, attempts=2, timeout=900, idle_timeout=120):
    command = [
        "ssh", "-i", str(key), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={known_hosts}",
        "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=10",
        "-o", "ServerAliveCountMax=3", "cliprelay-updates@124.221.36.36", "publish",
    ]
    total = archive.stat().st_size
    for attempt in range(1, attempts + 1):
        print(f"Upload attempt {attempt}/{attempts}: {total / 1048576:.1f} MiB", flush=True)
        # A regular file avoids a blocked tar/SSH pipe and exposes transfer progress.
        with archive.open("rb", buffering=0) as source, tempfile.TemporaryFile() as log:
            process = subprocess.Popen(command, stdin=source, stdout=log, stderr=log)
            started = last_progress = time.monotonic()
            previous = -1
            try:
                while process.poll() is None:
                    now = time.monotonic()
                    position = source.tell()
                    if position != previous:
                        last_progress, previous = now, position
                    print(f"Sent {position / 1048576:.1f}/{total / 1048576:.1f} MiB "
                          f"({int(now - started)}s)", flush=True)
                    if now - started > timeout or now - last_progress > idle_timeout:
                        print("Upload timed out; terminating this SSH attempt", flush=True)
                        process.kill()
                        break
                    time.sleep(10)
                process.wait(timeout=30)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=30)
            log.seek(0)
            print(log.read(64 * 1024).decode("utf-8", errors="replace"), flush=True)
            if process.returncode == 0:
                return
        if attempt < attempts:
            time.sleep(5)
    raise RuntimeError("Cloud upload failed after bounded retries")


def verify_cloud(info):
    current = fetch_manifest()
    if current is not None and current["versionCode"] > info["versionCode"]:
        print("A newer cloud release is already published; preserved it", flush=True)
        return
    if current is None or any(current[field] != info[field] for field in ("versionCode", "versionName", "sha256")):
        raise ValueError("Cloud manifest does not match the release")
    expected_url = f"{BASE_URL}/ClipRelay-{info['versionName']}.apk"
    if current["apkUrl"] != expected_url:
        raise ValueError("Unexpected cloud APK URL")
    digest = hashlib.sha256()
    deadline = time.monotonic() + 300
    with urllib.request.urlopen(expected_url, timeout=30) as response:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
            if time.monotonic() > deadline:
                raise TimeoutError("Cloud APK verification timed out")
    if digest.hexdigest() != info["sha256"]:
        raise ValueError("Downloaded cloud APK SHA-256 does not match the release")
    print(f"Verified cloud manifest and APK: v{info['versionName']} ({info['versionCode']})", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--key", type=Path)
    parser.add_argument("--known-hosts", type=Path)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    info = read_manifest(args.directory)
    needed = publication_needed(info, fetch_manifest())
    if args.check_only:
        print(f"needed={str(needed).lower()}")
        return
    if not needed:
        print("Cloud is already at this release or newer; no upload needed")
        return
    if not args.key or not args.known_hosts:
        parser.error("--key and --known-hosts are required for uploads")
    apk = args.directory / f"ClipRelay-{info['versionName']}.apk"
    verify_package(apk, info)
    with tempfile.TemporaryDirectory(prefix="cliprelay-publish-") as directory:
        archive = Path(directory) / "release.tar"
        with tarfile.open(archive, "w", format=tarfile.USTAR_FORMAT) as output:
            for path in (args.directory / "update.json", apk):
                output.add(path, arcname=path.name, recursive=False)
        upload(archive, args.key, args.known_hosts)
    verify_cloud(info)


if __name__ == "__main__":
    main()
