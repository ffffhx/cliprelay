"""Build the owned desktop network helper, notices and pinned source manifest."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

from network_notices import write_notices

ROOT = Path(__file__).resolve().parents[1]


def build(target, output):
    go = shutil.which('go')
    if not go:
        raise RuntimeError('Go 1.26.7 is required')
    if output.exists():
        raise RuntimeError('Use a fresh artifact directory')
    output.mkdir(parents=True)
    runtime = output / 'runtime'
    runtime.mkdir()
    env = os.environ.copy()
    env.update(GOOS='windows' if target == 'windows' else 'darwin', CGO_ENABLED='0')
    architectures = ['amd64'] if target == 'windows' else ['amd64', 'arm64']
    files = []
    for architecture in architectures:
        env['GOARCH'] = architecture
        binary = runtime / ('cliprelay-client-network.exe' if target == 'windows' else 'cliprelay-client-network-' + architecture)
        subprocess.run([go, 'build', '-mod=readonly', '-trimpath', '-ldflags=-s -w', '-o', str(binary), './cmd/cliprelay-client-network'],
                       cwd=ROOT / 'network', env=env, check=True)
        files.append(binary)
    if target == 'macos':
        binary = runtime / 'cliprelay-client-network'
        subprocess.run(['/usr/bin/lipo', '-create', *map(str, files), '-output', str(binary)], check=True)
        actual = subprocess.check_output(['/usr/bin/lipo', '-archs', str(binary)], text=True).split()
        if set(actual) != {'x86_64', 'arm64'}:
            raise RuntimeError('Network helper must include both Mac architectures')
        binary.chmod(0o755)
        for item in files:
            item.unlink()
    write_notices(ROOT, go, env, target, output=output / 'NETWORK-LICENSES.txt', packages=['./cmd/cliprelay-client-network'])
    with tarfile.open(output / 'cliprelay-network-source.tar.gz', 'w:gz') as archive:
        for name in ['go.mod', 'go.sum']:
            archive.add(ROOT / 'network' / name, arcname='network/' + name)
        for directory in ['desktopclient', 'mobile', 'transport', 'cmd/cliprelay-client-network']:
            for item in sorted((ROOT / 'network' / directory).rglob('*.go')):
                archive.add(item, arcname=item.relative_to(ROOT).as_posix())
        for name in ['build_desktop_network.py', 'network_notices.py']:
            archive.add(ROOT / 'scripts' / name, arcname='scripts/' + name)
    manifest = {'role': 'desktop-network', 'platform': target, 'protocol': 1,
                'files': {item.relative_to(output).as_posix(): hashlib.sha256(item.read_bytes()).hexdigest()
                          for item in sorted(output.rglob('*')) if item.is_file()}}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'artifact': str(output), 'files': len(manifest['files']), 'architectures': architectures}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target', choices=['windows', 'macos'])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    build(args.target, args.output.resolve())
