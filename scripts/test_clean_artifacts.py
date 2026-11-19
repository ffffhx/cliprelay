"""Exercise Windows cleanup against tiny disposable repositories, never real artifacts."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest


@unittest.skipUnless(os.name == 'nt', 'Windows PowerShell cleanup')
class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cliprelay-retention-test-')
        self.root = Path(self.temp.name)
        (self.root / 'scripts').mkdir()
        self.script = self.root / 'scripts/clean_artifacts.ps1'
        shutil.copyfile(Path(__file__).with_name('clean_artifacts.ps1'), self.script)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        self.ps = str(Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe')

    def tearDown(self):
        self.temp.cleanup()

    def artifact(self, name, days=3, file='payload.bin'):
        path = self.root / '.tools' / name
        path.mkdir(parents=True)
        (path / file).write_text('fixture', encoding='utf-8')
        stamp = time.time() - days * 86400
        os.utime(path / file, (stamp, stamp))
        os.utime(path, (stamp, stamp))
        return path

    def run_clean(self, *args, success=True):
        result = subprocess.run([self.ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                                 '-File', str(self.script), *args], cwd=self.root,
                                capture_output=True, text=True, errors='replace')
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def plan(self, paths):
        path = self.root / 'reviewed.json'
        path.write_text(json.dumps(paths), encoding='utf-8')
        return str(path)

    def test_preview_then_keep_two_packages(self):
        runs = [self.artifact(f'artifacts/packages/windows/run-{d}', d) for d in (2, 3, 4)]
        self.run_clean()
        self.assertTrue(all(p.exists() for p in runs))
        self.assertFalse((self.root / '.tools/cleanup-reports').exists())
        self.run_clean('-Apply')
        self.assertTrue(runs[0].exists() and runs[1].exists())
        self.assertFalse(runs[2].exists())
        self.run_clean('-Apply')  # Empty deletion list remains a successful no-op.

    def test_expiry_recent_pin_configuration_and_checkout(self):
        expired = self.artifact('artifacts/acceptance/expired', 10)
        recent = self.artifact('artifacts/acceptance/recent', 0)
        pinned = self.artifact('artifacts/acceptance/pinned', 20, '.keep')
        config = self.artifact('artifacts/acceptance/config', 20, 'config.json')
        checkout = self.artifact('artifacts/acceptance/checkout', 20, '.git')
        outside = self.artifact('unmanaged-toolchain', 100)
        self.run_clean('-Apply')
        self.assertFalse(expired.exists())
        self.assertTrue(all(p.exists() for p in (recent, pinned, config, checkout, outside)))

    def test_plan_escape_and_tracked_files_are_rejected(self):
        target = self.artifact('old-run')
        plan = self.plan(['.tools/old-run', '.tools/../../escape'])
        self.assertIn('Outside the artifact boundary', self.run_clean('-ReviewedPlan', plan, '-Apply', success=False))
        self.assertTrue(target.exists())
        subprocess.run(['git', 'add', '.tools/old-run'], cwd=self.root, check=True)
        plan = self.plan(['.tools/old-run'])
        self.assertIn('Tracked files', self.run_clean('-ReviewedPlan', plan, '-Apply', success=False))
        self.assertTrue(target.exists())

    def test_reviewed_legacy_deletion_and_overlap_rejection(self):
        target = self.artifact('old-run')
        plan = self.plan(['.tools/old-run', '.tools/old-run/payload.bin'])
        self.assertIn('Overlapping plan', self.run_clean('-ReviewedPlan', plan, '-Apply', success=False))
        self.assertTrue(target.exists())
        plan = self.plan(['.tools/old-run'])
        self.run_clean('-ReviewedPlan', plan, '-Apply')
        self.assertFalse(target.exists())

    def test_junction_is_not_followed(self):
        outside = self.artifact('do-not-delete')
        target = self.artifact('artifacts/acceptance/with-link', 20)
        link = target / 'linked'
        subprocess.run([self.ps, '-NoProfile', '-Command',
                        "New-Item -ItemType Junction -Path '" + str(link) + "' -Target '" + str(outside) + "' | Out-Null"], check=True)
        try:
            self.run_clean('-Apply')
            self.assertTrue((outside / 'payload.bin').exists())
            self.assertTrue(target.exists())
            plan = self.plan(['.tools/artifacts/acceptance/with-link/linked/payload.bin'])
            self.run_clean('-ReviewedPlan', plan, '-Apply', success=False)
        finally:
            os.rmdir(link)  # Remove only the junction itself, never its destination.

    def test_process_reference_is_preserved(self):
        target = self.artifact('old-running')
        process = subprocess.Popen([self.ps, '-NoProfile', '-Command',
                                    "Start-Sleep -Seconds 30 # '" + str(target) + "'"],
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            plan = self.plan(['.tools/old-running'])
            output = self.run_clean('-ReviewedPlan', plan, '-Apply')
            self.assertIn('Referenced by process', output)
            self.assertTrue(target.exists())
        finally:
            process.terminate()
            process.wait(timeout=10)


if __name__ == '__main__':
    unittest.main()
