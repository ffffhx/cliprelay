"""Select a successful dual-architecture Mac companion build for application packaging."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
FILES = {'LICENSE', 'NETWORK-LICENSES.txt', 'cliprelay-host-source.tar.gz', 'runtime/cliprelay-host-network'}
CASES = ['tls-pairing-ipc-and-eof-cleanup', 'inherited-unix-stream-owner',
         'extra-byte-without-newline-stops-service', 'parent-exit-with-inherited-writer-held',
         'parent-crash-with-inherited-writer-held', 'invalid-frame', 'oversized-frame',
         'initialization-timeout', 'required-listener-conflict-rolls-back-runtime', 'wrong-parent', 'regular-input']


def entries(archive, *, limit=96*1024*1024):
    result, names, total = [], set(), 0
    for member in archive:
        name = member.name.rstrip('/')
        folded = unicodedata.normalize('NFC', name).casefold()
        if (len(result) >= 512 or not name or len(name) > 1024 or folded in names
                or any(part in ('', '.', '..') for part in name.split('/'))
                or any(ord(char) < 32 or char in '\\:' for char in name)
                or str(PurePosixPath(name)) != name or PurePosixPath(name).is_absolute()
                or not (member.isdir() or member.isfile())):
            raise ValueError('Invalid companion archive entry')
        total += member.size
        if member.size < 0 or member.size > 64*1024*1024 or total > limit:
            raise ValueError('Companion archive exceeds size limit')
        result.append(member)
        names.add(folded)
    return result


def unpack(archive_path, directory):
    if (directory / 'host-companion').exists():
        raise ValueError('Companion destination already exists')
    with tarfile.open(archive_path) as archive:
        members = entries(archive)
        required = {'host-companion/'+name for name in FILES | {'manifest.json', 'process-report.json'}}
        if ({member.name for member in members if member.isfile()} != required
                or any(member.name.rstrip('/') not in ('host-companion', 'host-companion/runtime')
                       for member in members if member.isdir())):
            raise ValueError('Unexpected companion archive layout')
        archive.extractall(directory, members=members, filter='data')
    return directory / 'host-companion'


def verify_sources(source_path, commit):
    def output(*args):
        return subprocess.check_output(args, cwd=ROOT)
    exists = subprocess.run(['git', 'cat-file', '-e', commit+'^{commit}'], cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if exists.returncode:
        subprocess.run(['git', 'fetch', '--depth=1', 'origin', commit], cwd=ROOT, check=True)
    paths = output('git', 'ls-tree', '-r', '--name-only', commit, 'network/inputfocus',
                   'network/hostcompanion', 'network/cmd/cliprelay-host-network').decode().splitlines()
    expected = {name for name in paths if name.endswith('.go')}
    expected |= {'LICENSE', 'network/go.mod', 'network/go.sum', 'scripts/build_host_companion.py',
                 'scripts/network_notices.py', 'scripts/test_host_companion.py'}
    with tarfile.open(source_path) as archive:
        members = entries(archive, limit=8*1024*1024)
        if any(not member.isfile() for member in members) or {member.name for member in members} != expected:
            raise ValueError('Companion source list does not match selected Git tree')
        for member in members:
            if archive.extractfile(member).read() != output('git', 'show', commit+':'+member.name):
                raise ValueError('Companion source does not match selected Git tree')
    return len(expected)


def fetch(run, arch, directory):
    if not re.fullmatch(r'[0-9]+', run) or arch not in ('arm64', 'x86_64'):
        raise ValueError('Invalid companion build selection')
    metadata = json.loads(subprocess.check_output(['gh', 'run', 'view', run, '--json', 'conclusion,name,headSha'], cwd=ROOT))
    commit = metadata['headSha']
    if (metadata['conclusion'] != 'success' or metadata['name'] != 'macOS Host Companion Build'
            or not re.fullmatch(r'[a-f0-9]{40}', commit)):
        raise ValueError('Companion build has not completed successfully')
    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=False)
    subprocess.run(['gh', 'run', 'download', run, '-n', 'ClipRelay-Host-Companion-'+arch, '-D', str(directory)], cwd=ROOT, check=True)
    archive = directory / 'host-companion-macos.tar.gz'
    artifact = unpack(archive, directory)
    pin = {'commit': commit, 'manifestSha256': hashlib.sha256((artifact/'manifest.json').read_bytes()).hexdigest()}
    subprocess.run(['node', '-e', "require('./windows/electron/mac/host-companion-artifact.cjs').verify(process.argv[1],JSON.parse(process.argv[2]));",
                    str(artifact), json.dumps(pin)], cwd=ROOT, check=True)
    source_files = verify_sources(artifact/'cliprelay-host-source.tar.gz', commit)
    report = json.loads((artifact/'process-report.json').read_bytes())
    executable_hash = hashlib.sha256((artifact/'runtime/cliprelay-host-network').read_bytes()).hexdigest()
    if (report['cases'] != CASES or report['passed'] != len(CASES) or report['nativeWorkers'] is not False
            or report['architecture'] != arch or report['executableSha256'] != executable_hash):
        raise ValueError('Companion process receipt does not match the selected architecture and executable')
    result = {'run': int(run), 'architecture': arch, 'pin': pin, 'sourceFilesVerified': source_files,
              'directory': str(artifact), 'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
    (directory/'selection.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True)
    parser.add_argument('--arch', choices=['arm64', 'x86_64'], required=True)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    result = fetch(args.run, args.arch, args.directory)
    if os.environ.get('GITHUB_ENV'):
        with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as stream:
            stream.write('CLIPRELAY_HOST_COMPANION_ARTIFACT='+result['directory']+'\n')
            stream.write('CLIPRELAY_HOST_COMPANION_PIN='+json.dumps(result['pin'])+'\n')
    print(json.dumps(result))
