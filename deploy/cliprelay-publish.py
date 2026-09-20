#!/usr/bin/env python3
"""Receive a release tar on stdin; publish the package before its manifest.

Run as the restricted cliprelay-updates SSH user. Never extracts archive paths.
"""
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tarfile
import tempfile

ROOT = Path('/srv/cliprelay-updates')
BASE_URL = 'https://124-221-36-36.anyip.dev:8443/cliprelay'
MAX_BYTES = 512 * 1024 * 1024


def publish(stream, root=ROOT, base_url=BASE_URL):
    payload = stream.read(MAX_BYTES + 1024 * 1024 + 1)
    if len(payload) > MAX_BYTES + 1024 * 1024:
        raise ValueError('Release archive too large')
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:') as archive:
        members = archive.getmembers()
        if len(members) != 2 or any(not member.isfile() for member in members):
            raise ValueError('Expected exactly two regular files')
        names = [member.name for member in members]
        windows = 'windows-update.json' in names
        manifest = archive.getmember('windows-update.json' if windows else 'update.json')
        if manifest.size > 128 * 1024:
            raise ValueError('Manifest too large')
        info = json.load(archive.extractfile(manifest))
        version = info['versionName']
        code = info['versionCode']
        if not isinstance(version, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
            raise ValueError('Invalid version name')
        if type(code) is not int or code <= 0:
            raise ValueError('Invalid version code')
        filename = f'ClipRelay-Windows-{version}.zip' if windows else f'ClipRelay-{version}.apk'
        if len(set(names)) != 2 or set(names) != {manifest.name, filename}:
            raise ValueError('Unexpected archive entries')
        apk_member = archive.getmember(filename)
        if not 0 < apk_member.size <= MAX_BYTES:
            raise ValueError('Invalid APK size')
        apk = archive.extractfile(apk_member).read()
        if windows:
            notes = info.get('releaseNotes')
            if (type(info.get('sizeBytes')) is not int or info['sizeBytes'] != len(apk)
                    or not isinstance(notes, str) or not notes.strip() or len(notes) > 20000
                    or code > 2147483647):
                raise ValueError('Invalid Windows release metadata')
    digest = hashlib.sha256(apk).hexdigest()
    if digest != info['sha256']:
        raise ValueError('APK checksum mismatch')
    if windows:
        info['downloadUrl'] = f'{base_url}/windows/{filename}'
    else:
        info['apkUrl'] = f'{base_url}/{filename}'
    root.mkdir(parents=True, exist_ok=True)
    with (root / '.publish.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        channel = root / 'windows' if windows else root
        channel.mkdir(parents=True, exist_ok=True)
        target = channel / 'update.json'
        if target.exists():
            current = json.loads(target.read_text())
            if current['versionCode'] > code:
                print('Skipped older release; current version preserved')
                return
            if current['versionCode'] == code and (current['sha256'] != digest or current['versionName'] != version):
                raise ValueError('Refusing different package with the same version code')
            if windows and code > current['versionCode'] and tuple(map(int, version.split('.'))) <= tuple(map(int, current['versionName'].split('.'))):
                raise ValueError('Windows version name must increase')
        atomic_write(channel / filename, apk)
        atomic_write(target, (json.dumps(info, ensure_ascii=False, indent=2) + '\n').encode())
    print(f'Published {version} ({code}), SHA-256 {digest}')


def atomic_write(target, data):
    fd, name = tempfile.mkstemp(prefix='.publish-', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(name, 0o644)
        os.replace(name, target)
    finally:
        if os.path.exists(name):
            os.unlink(name)


if __name__ == '__main__':
    publish(sys.stdin.buffer)
