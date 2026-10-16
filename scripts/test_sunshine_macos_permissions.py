"""Exercise read-only permission commands on the final signed native engine."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile


def snapshot(directory: Path) -> dict:
    if not directory.exists():
        return {'exists': False}
    result = {'exists': True, 'entries': {}}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            value = {'link': str(path.readlink())}
        elif path.is_file():
            value = {'size': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        elif path.is_dir():
            value = {'directory': True}
        else:
            raise RuntimeError('Unexpected native engine state entry')
        result['entries'][path.relative_to(directory).as_posix()] = value
    return result


def check(engine: Path, report_path: Path) -> dict:
    if platform.system() != 'Darwin':
        raise RuntimeError('Native permission-command verification requires macOS')
    engine = engine.resolve(strict=True)
    states = [Path.home() / '.config/sunshine', Path.home() / 'Library/Application Support/ClipRelay/host']
    before = [snapshot(state) for state in states]
    environment = dict(os.environ)
    environment.pop('CLIPRELAY_HOST_STATE_DIR', None)
    cases, status = [], None
    with tempfile.TemporaryDirectory(prefix='cliprelay-permission-command-') as temporary:
        for name, args, expected in [
            ('status', ['--cliprelay-permissions', 'status'], 0),
            ('invalid-action', ['--cliprelay-permissions', 'invalid'], 2),
            ('misplaced-option', ['--version', '--cliprelay-permissions', 'status'], 2),
            ('repeat-status', ['--cliprelay-permissions', 'status'], 0),
        ]:
            # No native permission request action is ever run by this fixture.
            result = subprocess.run([str(engine), *args], cwd=temporary, stdin=subprocess.DEVNULL,
                                    capture_output=True, timeout=10, check=False, env=environment)
            if result.returncode != expected or len(result.stdout) > 4096 or len(result.stderr) > 16384:
                raise RuntimeError('Native permission command failed: ' + name)
            value = json.loads(result.stdout)
            if expected == 0:
                if (set(value) != {'protocol', 'screenRecording', 'inputControl', 'requested'}
                        or type(value['protocol']) is not int or value['protocol'] != 1 or type(value['screenRecording']) is not bool
                        or type(value['inputControl']) is not bool or value['requested'] != 'none'):
                    raise RuntimeError('Invalid native permission status')
                status = value
            elif value != {'protocol': 1, 'error': 'invalid_command'}:
                raise RuntimeError('Invalid native permission error reply')
            cases.append(name)
        if list(Path(temporary).iterdir()) or [snapshot(state) for state in states] != before:
            raise RuntimeError('Permission query changed application state')
    report = {'protocol': 1, 'passed': True, 'cases': cases, 'lastStatus': status,
              'applicationStateUnchanged': True, 'nativeRequestsExecuted': False,
              'scope': 'Final signed engine status and invalid commands only; no capture, permission grant or input injection.'}
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(check(args.engine, args.report)))
