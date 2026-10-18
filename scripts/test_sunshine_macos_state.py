"""Verify actual signed-engine state admission and config writes without hosting."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import stat
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location('permission_state_snapshot', Path(__file__).with_name('test_sunshine_macos_permissions.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
snapshot = helper.snapshot

CASES = ['missing-state-startup', 'relative-state-startup', 'root-state-startup', 'missing-directory-startup',
         'permissive-directory-startup', 'readonly-directory-check', 'file-check', 'symlink-check',
         'parent-symlink-check', 'malformed-command', 'private-check', 'private-config-startup']


def check(engine: Path, report_path: Path) -> dict:
    if platform.system() != 'Darwin':
        raise RuntimeError('Native state verification requires macOS')
    engine = engine.resolve(strict=True)
    protected = [Path.home() / '.config/sunshine', Path.home() / 'Library/Application Support/ClipRelay/host']
    before = [snapshot(path) for path in protected]
    environment = dict(os.environ)
    environment.pop('CLIPRELAY_HOST_STATE_DIR', None)
    cases = []
    with tempfile.TemporaryDirectory(prefix='cliprelay-engine-state-') as temporary:
        base = Path(temporary).resolve()
        private = base / 'ClipRelay state #1'
        private.mkdir(mode=0o700)
        private.chmod(0o700)
        permissive, readonly = base / 'permissive', base / 'readonly'
        permissive.mkdir(); permissive.chmod(0o755)
        readonly.mkdir(); readonly.chmod(0o500)
        file = base / 'file'; file.write_text('fixture')
        link = base / 'link'; link.symlink_to(private, target_is_directory=True)
        parent = base / 'parent-link'; parent.symlink_to(base, target_is_directory=True)
        original = snapshot(base)
        check_args = ['--cliprelay-state', 'check']
        # This deliberately unknown upstream command exits after real config/log
        # initialization, before display initialization, permissions or listeners.
        config_args = ['--cliprelay-config-fixture']
        commands = [
            (CASES[0], None, config_args, 'state_directory_required'),
            (CASES[1], 'relative-state', config_args, 'invalid_state_directory'),
            (CASES[2], '/', config_args, 'invalid_state_directory'),
            (CASES[3], str(base / 'missing'), config_args, 'invalid_state_directory'),
            (CASES[4], str(permissive), config_args, 'invalid_state_directory'),
            (CASES[5], str(readonly), check_args, 'invalid_state_directory'),
            (CASES[6], str(file), check_args, 'invalid_state_directory'),
            (CASES[7], str(link), check_args, 'invalid_state_directory'),
            (CASES[8], str(parent / private.name), check_args, 'invalid_state_directory'),
            (CASES[9], str(private), ['--cliprelay-state', 'initialize'], 'invalid_command'),
            (CASES[10], str(private), check_args, None),
        ]
        try:
            for name, selected, args, error in commands:
                env = dict(environment)
                if selected is not None:
                    env['CLIPRELAY_HOST_STATE_DIR'] = selected
                result = subprocess.run([str(engine), *args], env=env, cwd=base, stdin=subprocess.DEVNULL,
                                        capture_output=True, timeout=10, check=False)
                if result.returncode != (2 if error else 0) or len(result.stdout) > 4096 or len(result.stderr) > 16384:
                    raise RuntimeError('Native state admission failed: ' + name)
                expected = {'protocol': 1, 'error': error} if error else {'protocol': 1, 'ready': True}
                if json.loads(result.stdout) != expected or snapshot(base) != original:
                    raise RuntimeError('Native state check changed files or returned an invalid reply: ' + name)
                cases.append(name)
            result = subprocess.run([str(engine), *config_args], env={**environment, 'CLIPRELAY_HOST_STATE_DIR': str(private)},
                                    cwd=base, stdin=subprocess.DEVNULL, capture_output=True, timeout=15, check=False)
            if result.returncode != 7 or len(result.stdout) > 65536 or len(result.stderr) > 16384:
                raise RuntimeError('Private configuration fixture did not stop before host initialization')
            required = ['sunshine.conf', 'sunshine.log', 'apps.json']
            if any(not (private / name).is_file() for name in required):
                raise RuntimeError('Actual config/log initialization did not use the selected private state')
            for path in [private, *private.rglob('*')]:
                info = path.lstat()
                if (not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode))
                        or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077):
                    raise RuntimeError('Engine state escaped private ownership or permissions')
            after = snapshot(base)
            outside = lambda tree: {k:v for k,v in tree['entries'].items() if not k.startswith(private.name + '/')}
            if outside(after) != outside(original) or [snapshot(path) for path in protected] != before:
                raise RuntimeError('Engine configuration modified state outside the selected private directory')
            cases.append(CASES[11])
            created = sorted(path.relative_to(private).as_posix() for path in private.rglob('*'))
        finally:
            readonly.chmod(0o700)
    report = {'protocol': 1, 'passed': True, 'cases': cases, 'createdPrivateEntries': created,
              'defaultStateUnchanged': True, 'stateFilesPrivate': True, 'homeChanged': False,
              'nativeRequestsExecuted': False, 'hostStarted': False,
              'scope': 'Signed-engine directory admission and actual config/log initialization only. No capture, permissions or listeners.'}
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(check(args.engine, args.report)))
