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
CASES = ['tls-pairing-ipc-and-eof-cleanup', 'managed-pairing-generation-and-rejection', 'inherited-unix-stream-owner',
         'extra-byte-without-newline-stops-service', 'parent-exit-with-inherited-writer-held',
         'parent-crash-with-inherited-writer-held', 'invalid-frame', 'oversized-frame',
         'initialization-timeout', 'required-listener-conflict-rolls-back-runtime', 'wrong-parent', 'regular-input']
FILE_CASES = ['tls-files-desktop-resume-and-no-overwrite', 'tls-files-owner-and-live-revocation',
              'files-eof-joins-worker', 'files-parent-loss-with-writer-held', 'files-owner-admission']
CLIPBOARD_CASES = ['tls-clipboard-text-image-and-idempotence', 'tls-clipboard-owner-and-live-revocation',
                   'clipboard-worker-crash-recovery', 'clipboard-eof-joins-worker',
                   'clipboard-parent-loss-with-writer-held', 'clipboard-owner-admission', 'tls-clipboard-desktop-client']
TERMINAL_CASES = [shell+': '+case for shell in ['zsh', 'bash'] for case in [
    'inventory and duplicate open', 'Unicode and lost input ACK deduplication', 'whole 14 KB paste digest',
    'native resize', 'live revocation reaps native shell']]
TERMINAL_CASES += ['worker EOF reaps foreground shell through guardian', 'worker SIGKILL reaps foreground shell through guardian']
TERMINAL_REPORT = 'terminal-process-report.json'
TERMINAL_HTTP_CASES = ['tls-terminal-shells-sessions-and-lost-replies',
                       'tls-terminal-native-mouse-lease-and-resize', 'tls-terminal-desktop-client',
                       'tls-terminal-owner-isolation-and-live-revocation',
                       'tls-terminal-output-gap-and-worker-restart', 'terminal-eof-reaps-owned-sessions']


def verify_terminal_report(report, arch, executable_hash):
    if (set(report) != {'passed', 'scope', 'architecture', 'binarySha256', 'cases'}
            or report['passed'] is not True or report['cases'] != TERMINAL_CASES
            or report['scope'] != 'packaged owned terminal process, not HTTP/client integration'
            or report['architecture'] != arch or report['binarySha256'] != executable_hash):
        raise ValueError('Terminal receipt does not match selected executable and complete acceptance cases')


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
        actual = {member.name for member in members if member.isfile()}
        if (not required <= actual or actual-required not in (set(), {'host-companion/'+TERMINAL_REPORT})
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
                   'network/hostcompanion', 'network/hostfiles', 'network/hostclipboard', 'network/cmd/cliprelay-host-network').decode().splitlines()
    # Intermediate older builds contained the new package in Git before the
    # companion linked it. Match the source list to that selected build script.
    terminal = b"'hostterminal'" in output('git', 'show', commit+':scripts/build_host_companion.py')
    if terminal:
        paths += output('git', 'ls-tree', '-r', '--name-only', commit, 'network/hostterminal').decode().splitlines()
    expected = {name for name in paths if name.endswith(('.go', '.m', '.h'))}
    expected |= {'LICENSE', 'network/go.mod', 'network/go.sum', 'scripts/build_host_companion.py',
                 'scripts/network_notices.py', 'scripts/test_host_companion.py'}
    if terminal:
        expected.add('scripts/test_host_terminal_process.py')
    if output('git', 'ls-tree', '--name-only', commit, 'scripts/test_host_terminal.py').strip():
        expected |= {'scripts/test_host_terminal.py', 'scripts/test_host_terminal_client.cjs'}
        expected |= {'windows/electron/mac/'+name for name in ['terminal-controller.cjs', 'terminal-protocol.cjs', 'terminal-mouse.cjs']}
    if output('git', 'ls-tree', '--name-only', commit, 'scripts/test_host_clipboard.py').strip():
        expected.add('scripts/test_host_clipboard.py')
    if output('git', 'ls-tree', '--name-only', commit, 'scripts/test_host_clipboard_client.cjs').strip():
        expected.add('scripts/test_host_clipboard_client.cjs')
    if output('git', 'ls-tree', '--name-only', commit, 'scripts/test_host_files.py').strip():
        expected |= {'scripts/test_host_files.py', 'scripts/test_host_files_client.cjs'}
        expected |= {'windows/electron/mac/'+name for name in ['file-controller.cjs', 'file-protocol.cjs', 'file-storage.cjs', 'paired-store.cjs', 'paired-transport.cjs', 'paired-crypto.cjs',
                                                             'routed-store.cjs', 'paired-controller.cjs', 'pairing.cjs', 'paired-relay.cjs', 'pairing-feedback.cjs']}
    if output('git', 'ls-tree', '--name-only', commit, 'windows/electron/mac/clipboard-protocol.cjs').strip():
        expected |= {'windows/electron/mac/clipboard-access.cjs', 'windows/electron/mac/clipboard-protocol.cjs'}
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
    file_transfer = json.loads((artifact/'manifest.json').read_bytes()).get('fileTransfer') == 1
    clipboard_exchange = json.loads((artifact/'manifest.json').read_bytes()).get('clipboardExchange') == 1
    terminal_control = json.loads((artifact/'manifest.json').read_bytes()).get('terminalControl') == 1
    expected_cases = (TERMINAL_HTTP_CASES if terminal_control else []) + (CLIPBOARD_CASES if clipboard_exchange else []) + (FILE_CASES if file_transfer else []) + CASES
    executable_hash = hashlib.sha256((artifact/'runtime/cliprelay-host-network').read_bytes()).hexdigest()
    terminal = b"'hostterminal'" in subprocess.check_output(['git', 'show', commit+':scripts/build_host_companion.py'], cwd=ROOT)
    terminal_receipt = artifact/TERMINAL_REPORT
    if terminal != terminal_receipt.exists():
        raise ValueError('Terminal process receipt is missing or unexpected for the selected build')
    if terminal:
        raw = terminal_receipt.read_bytes()
        if len(raw) > 16384:
            raise ValueError('Terminal receipt exceeds size limit')
        verify_terminal_report(json.loads(raw), arch, executable_hash)
    if (report['cases'] != expected_cases or report['passed'] != len(expected_cases) or report['nativeWorkers'] is not False
            or (file_transfer and report.get('fileTransfer') != 1)
            or (clipboard_exchange and report.get('clipboardExchange') != 1)
            or (terminal_control and report.get('terminalControl') != 1)
            or report['architecture'] != arch or report['executableSha256'] != executable_hash):
        raise ValueError('Companion process receipt does not match the selected architecture and executable')
    result = {'run': int(run), 'architecture': arch, 'pin': pin, 'sourceFilesVerified': source_files,
              'directory': str(artifact), 'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
    if terminal:
        result['terminalProcessCasesVerified'] = len(TERMINAL_CASES)
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
