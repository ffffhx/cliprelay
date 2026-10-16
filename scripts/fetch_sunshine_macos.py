"""Fetch a successful native Mac host build for an explicit application package."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import unicodedata


def unpack(archive_path: Path, directory: Path) -> Path:
    """Accept only the bounded regular-file engine format, before extracting it."""
    if (directory / 'engine-artifact').exists():
        raise ValueError('Engine destination already exists')
    with tarfile.open(archive_path) as archive:
        names, total = set(), 0
        members = []
        for member in archive:
            members.append(member)
            if len(members) > 8192:
                raise ValueError('Too many engine archive entries')
            name = member.name.rstrip('/')
            parts = name.split('/')
            folded = unicodedata.normalize('NFC', name).casefold()
            if (not name or len(name) > 1024 or parts[0] != 'engine-artifact'
                    or any(part in ('', '.', '..') for part in parts)
                    or any(ord(char) < 32 or char in '\\:' for char in name)
                    or str(PurePosixPath(name)) != name or folded in names
                    or not (member.isdir() or member.isfile())):
                raise ValueError('Invalid engine archive member')
            names.add(folded)
            total += member.size
            if member.size < 0 or member.size > 128 * 1024 * 1024 or total > 256 * 1024 * 1024:
                raise ValueError('Engine archive exceeds size limit')
        archive.extractall(directory, members=members, filter='data')
    return directory / 'engine-artifact'


def fetch(run: str, arch: str, directory: Path) -> dict:
    if not re.fullmatch(r'[0-9]+', run) or arch not in ('arm64', 'x86_64'):
        raise ValueError('Invalid native host build selection')
    root = Path(__file__).resolve().parents[1]

    def output(*args):
        return subprocess.check_output(args, cwd=root)

    metadata = json.loads(output('gh', 'run', 'view', run, '--json', 'conclusion,name,headSha'))
    commit = metadata['headSha']
    if (metadata['conclusion'] != 'success' or metadata['name'] != 'Sunshine macOS Host Build'
            or not re.fullmatch(r'[a-f0-9]{40}', commit)):
        raise ValueError('Native host build has not completed successfully')
    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=False)
    subprocess.run(['gh', 'run', 'download', run, '-n', 'sunshine-cliprelay-control-macos-' + arch,
                    '-D', str(directory)], cwd=root, check=True)
    archive = directory / ('sunshine-cliprelay-macos-' + arch + '.tar.gz')
    with archive.open('rb') as stream:
        archive_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
    receipt = (directory / (archive.name + '.sha256')).read_text().strip().split()
    if receipt != [archive_hash, archive.name]:
        raise ValueError('Native engine archive checksum does not match')
    artifact = unpack(archive, directory)
    manifest_bytes = (artifact / 'manifest.json').read_bytes()
    pin = {'arch': arch, 'commit': commit, 'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest()}
    subprocess.run(['node', '-e',
                    "require('./windows/electron/mac/host-engine-artifact.cjs').verify(process.argv[1],JSON.parse(process.argv[2]));",
                    str(artifact), json.dumps(pin)], cwd=root, check=True)
    # A successful run is selected explicitly. Match every included source to
    # that run's immutable Git tree, not just to its self-described manifest.
    exists = subprocess.run(['git', 'cat-file', '-e', commit + '^{commit}'], cwd=root,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if exists.returncode:
        subprocess.run(['git', 'fetch', '--depth=1', 'origin', commit], cwd=root, check=True)
    manifest = json.loads(manifest_bytes)
    for name, digest in manifest['sourceHashes'].items():
        data = output('git', 'show', commit + ':' + name)
        if hashlib.sha256(data).hexdigest() != digest or data != (artifact / 'source' / name).read_bytes():
            raise ValueError('Native engine source receipt does not match the selected Git tree')
    result = {'run': int(run), 'archiveSha256': archive_hash, 'pin': pin, 'directory': str(artifact)}
    (directory / 'selection.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True)
    parser.add_argument('--arch', choices=['arm64', 'x86_64'], required=True)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    result = fetch(args.run, args.arch, args.directory)
    if os.environ.get('GITHUB_ENV'):
        with open(os.environ['GITHUB_ENV'], 'a') as stream:
            stream.write('CLIPRELAY_HOST_ENGINE_ARTIFACT=' + result['directory'] + '\n')
            stream.write('CLIPRELAY_HOST_ENGINE_PIN=' + json.dumps(result['pin']) + '\n')
    print(json.dumps(result))
