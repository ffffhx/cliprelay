"""Build a universal Mac host companion with source and dependency notices."""
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


def build(output):
    if output.exists():
        raise RuntimeError('Use a fresh artifact directory')
    go = shutil.which('go')
    if not go:
        raise RuntimeError('Go 1.26.7 is required')
    runtime = output / 'runtime'
    runtime.mkdir(parents=True)
    env = dict(os.environ, GOOS='darwin', CGO_ENABLED='1', MACOSX_DEPLOYMENT_TARGET='12.0', CC='clang')
    pieces = []
    for architecture in ['amd64', 'arm64']:
        env['GOARCH'] = architecture
        binary = runtime / ('cliprelay-host-network-' + architecture)
        subprocess.run([go, 'build', '-mod=readonly', '-trimpath', '-ldflags=-s -w', '-o', str(binary), './cmd/cliprelay-host-network'], cwd=ROOT/'network', env=env, check=True)
        pieces.append(binary)
    binary = runtime / 'cliprelay-host-network'
    subprocess.run(['/usr/bin/lipo', '-create', *map(str, pieces), '-output', str(binary)], check=True)
    if set(subprocess.check_output(['/usr/bin/lipo', '-archs', str(binary)], text=True).split()) != {'x86_64', 'arm64'}:
        raise RuntimeError('Host companion must contain both Mac architectures')
    binary.chmod(0o755)
    for piece in pieces:
        piece.unlink()
    write_notices(ROOT, go, env, 'macos', output=output/'NETWORK-LICENSES.txt', packages=['./cmd/cliprelay-host-network'])
    shutil.copyfile(ROOT/'LICENSE', output/'LICENSE')
    with tarfile.open(output/'cliprelay-host-source.tar.gz', 'w:gz') as archive:
        archive.add(ROOT/'LICENSE', arcname='LICENSE')
        for name in ['go.mod', 'go.sum']:
            archive.add(ROOT/'network'/name, arcname='network/'+name)
        for directory in ['inputfocus', 'hostcompanion', 'hostfiles', 'hostclipboard', 'hostterminal', 'hostwake', 'cmd/cliprelay-host-network']:
            for source in sorted((ROOT/'network'/directory).rglob('*')):
                if source.suffix in ('.go', '.m', '.h'):
                    archive.add(source, arcname=source.relative_to(ROOT).as_posix())
        for name in ['build_host_companion.py', 'network_notices.py', 'test_host_companion.py', 'test_host_files.py', 'test_host_files_client.cjs', 'test_host_clipboard.py', 'test_host_clipboard_client.cjs', 'test_host_terminal_process.py', 'test_host_terminal.py', 'test_host_terminal_client.cjs', 'test_host_terminal_android.py', 'TerminalMacInterop.java', 'test_host_wake.py', 'test_host_wake_client.cjs', 'WakeMacInterop.java']:
            archive.add(ROOT/'scripts'/name, arcname='scripts/'+name)
        for name in ['WakeState', 'WakeSelection']:
            source = ROOT/'android-app/remote-engine/src/main/java/com/limelight/nvstream/wol'/(name+'.java')
            archive.add(source, arcname=source.relative_to(ROOT).as_posix())
        for name in ['TerminalProtocol', 'TerminalSessionState', 'TerminalMouseState']:
            source = ROOT/'android-app/remote-engine/src/main/java/com/limelight/terminal'/(name+'.java')
            archive.add(source, arcname=source.relative_to(ROOT).as_posix())
        for name in ['file-controller.cjs', 'file-protocol.cjs', 'file-storage.cjs', 'paired-store.cjs', 'paired-transport.cjs', 'paired-crypto.cjs',
                     'routed-store.cjs', 'paired-controller.cjs', 'pairing.cjs', 'paired-relay.cjs', 'pairing-feedback.cjs', 'clipboard-access.cjs', 'clipboard-protocol.cjs', 'terminal-controller.cjs', 'terminal-protocol.cjs', 'terminal-mouse.cjs', 'wake-protocol.cjs']:
            archive.add(ROOT/'windows/electron/mac'/name, arcname='windows/electron/mac/'+name)
    manifest = {'role': 'host-companion', 'platform': 'macos', 'protocol': 1, 'nativeWorkers': False, 'pairingControl': 1, 'fileTransfer': 1, 'clipboardExchange': 1, 'terminalControl': 1, 'wakeControl': 1,
                'files': {file.relative_to(output).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest()
                          for file in sorted(output.rglob('*')) if file.is_file()}}
    (output/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'artifact': str(output), 'files': len(manifest['files']), 'architectures': ['x86_64', 'arm64']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    build(parser.parse_args().output.resolve())
