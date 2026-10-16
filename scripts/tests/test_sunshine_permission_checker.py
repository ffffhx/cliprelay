"""Validate the native-command gate with private fixture state and mocked processes."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('permission_checker', Path(__file__).resolve().parents[1] / 'test_sunshine_macos_permissions.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class PermissionCheckerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cliprelay-permission-checker-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.engine, self.report = self.root / 'engine', self.root / 'report.json'
        self.engine.write_text('not executable')
        self.calls = []
        self.status = {'protocol': 1, 'screenRecording': False, 'inputControl': True, 'requested': 'none'}
        self.addCleanup(patch.stopall)
        patch.object(checker.platform, 'system', return_value='Darwin').start()
        patch.object(checker.Path, 'home', return_value=self.root / 'fixture-home').start()

    def reply(self, args, **kwargs):
        self.calls.append(args[1:])
        self.assertEqual(kwargs['stdin'], subprocess.DEVNULL)
        self.assertEqual(kwargs['timeout'], 10)
        good = args[1:] == ['--cliprelay-permissions', 'status']
        value = self.status if good else {'protocol': 1, 'error': 'invalid_command'}
        return subprocess.CompletedProcess(args, 0 if good else 2, json.dumps(value).encode(), b'')

    def test_exact_read_only_commands_write_an_evidence_receipt(self):
        with patch.object(checker.subprocess, 'run', side_effect=self.reply):
            result = checker.check(self.engine, self.report)
        self.assertTrue(result['passed'])
        self.assertFalse(result['nativeRequestsExecuted'])
        self.assertEqual(len(self.calls), 4)
        self.assertFalse(any('request-screen' in args or 'request-input' in args for args in self.calls))
        self.assertEqual(json.loads(self.report.read_text()), result)

    def test_a_request_reply_cannot_be_accepted_as_a_query(self):
        self.status['requested'] = 'screenRecording'
        with patch.object(checker.subprocess, 'run', side_effect=self.reply):
            with self.assertRaises(RuntimeError):
                checker.check(self.engine, self.report)
        self.assertFalse(self.report.exists())

    def test_protocol_and_permission_types_are_strict(self):
        for field, value in [('protocol', True), ('screenRecording', 'false'), ('inputControl', 1)]:
            previous = self.status[field]
            self.status[field] = value
            with self.subTest(field=field), patch.object(checker.subprocess, 'run', side_effect=self.reply):
                with self.assertRaises(RuntimeError):
                    checker.check(self.engine, self.report)
            self.status[field] = previous

    def test_logging_pollution_and_oversized_replies_are_rejected(self):
        for output in [b'log message\n' + json.dumps(self.status).encode(), b' ' * 4097]:
            with patch.object(checker.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, output, b'')):
                with self.assertRaises((ValueError, RuntimeError)):
                    checker.check(self.engine, self.report)

    def test_accidental_host_initialization_changes_only_private_fixture_state_and_is_detected(self):
        def write_then_reply(*args, **kwargs):
            state = self.root / 'fixture-home/.config/sunshine'
            state.mkdir(parents=True, exist_ok=True)
            (state / 'sunshine.conf').write_text('fixture')
            return self.reply(*args, **kwargs)
        with patch.object(checker.subprocess, 'run', side_effect=write_then_reply):
            with self.assertRaisesRegex(RuntimeError, 'changed application state'):
                checker.check(self.engine, self.report)
        self.assertFalse(self.report.exists())

    def test_wrong_platform_never_executes_the_selected_binary(self):
        with patch.object(checker.platform, 'system', return_value='Windows'), patch.object(checker.subprocess, 'run') as run:
            with self.assertRaises(RuntimeError):
                checker.check(self.engine, self.report)
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
