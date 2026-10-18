"""Verify a complete Windows archive and exercise installer preflight failures."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import zipfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def verify(archive, output):
    output.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(archive) as package:
        members = package.namelist()
        assert len(members) == len(set(n.casefold() for n in members)), 'Duplicate ZIP path'
        assert all(n.startswith('ClipRelay-Windows/') and '\\' not in n and ':' not in n
                   and all(p not in ('', '.', '..') for p in n.split('/')) for n in members), 'Unsafe ZIP path'
        manifest = json.loads(package.read('ClipRelay-Windows/package-files.json'))
        expected = {'ClipRelay-Windows/' + n for n in manifest['files']} | {'ClipRelay-Windows/package-files.json'}
        assert set(members) == expected, 'Unlisted archive content'
        for name, digest in manifest['files'].items():
            assert sha(package.read('ClipRelay-Windows/' + name)) == digest, name
        package.extractall(output)
    root = output/'ClipRelay-Windows'
    local = output/'isolated-local-appdata'
    config = local/'ClipRelay/config.json'
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({'peer':'', 'peers':[], 'port':49769, 'deviceId':'archive-fixture',
                                 'legacyReceiverEnabled':False, 'future':{'keep':[1,2,3]}}), encoding='utf-8')
    before = sha(config.read_bytes())
    env = dict(os.environ, LOCALAPPDATA=str(local))
    executable = Path(os.environ['SystemRoot'])/'System32/WindowsPowerShell/v1.0/powershell.exe'
    def preflight(success, contains):
        result = subprocess.run([str(executable), '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
                                 '-File', str(root/'install.ps1'), '-ValidateOnly'],
                                env=env, capture_output=True, timeout=60)
        log = (result.stdout+result.stderr).decode('utf-8', errors='replace')
        assert (result.returncode == 0) == success, log
        assert contains in log, log
        assert sha(config.read_bytes()) == before, 'Preflight changed configuration'
        assert list(config.parent.iterdir()) == [config], 'Preflight created installation files'
    preflight(True, 'no installation changes made')
    source = root/'remote-desktop/privacy-screen.cs'
    saved = source.read_bytes()
    try:
        source.write_bytes(saved+b'\n// synthetic checksum failure\n')
        preflight(False, 'privacy-screen.cs')
    finally:
        source.write_bytes(saved)
    hidden = source.with_suffix('.fixture')
    try:
        source.rename(hidden)
        preflight(False, 'privacy-screen.cs')
    finally:
        hidden.rename(source)
    engine = root/'remote-desktop/engine/sunshine.exe'
    top_manifest = root/'package-files.json'
    saved_manifest = top_manifest.read_bytes()
    with engine.open('rb') as file:
        prefix = file.read(4)
    try:
        with engine.open('r+b') as file:
            file.write(b'BAD!')
        manifest['files']['remote-desktop/engine/sunshine.exe'] = sha(engine.read_bytes())
        top_manifest.write_text(json.dumps(manifest), encoding='utf-8')
        # The package-level hash now agrees. The independently pinned engine hash
        # must still reject an original, damaged or substituted Sunshine binary.
        preflight(False, 'sunshine.exe')
    finally:
        with engine.open('r+b') as file:
            file.write(prefix)
        top_manifest.write_bytes(saved_manifest)
    return {'passed':True, 'archive':str(archive.resolve()), 'archiveSha256':sha(archive.read_bytes()),
            'archiveBytes':archive.stat().st_size, 'files':len(manifest['files']),
            'checks':['exact-archive-manifest','all-file-checksums','valid-installer-preflight',
                      'tampered-source-rejected','missing-source-rejected','substituted-engine-rejected',
                      'settings-and-installation-unchanged'], 'unpacked':str(root.resolve())}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    report = verify(args.archive, args.output)
    args.report.write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(report))
