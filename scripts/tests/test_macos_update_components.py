import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('update_components', Path(__file__).parents[1] / 'resolve_macos_update_components.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ComponentsTest(unittest.TestCase):
    def test_manual_selection_does_not_start_other_workflows(self):
        with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'VIEWER': '123'}), patch.object(module, 'gh') as api:
            self.assertEqual(module.resolve_one(('viewer', module.COMPONENTS['viewer'])), ('viewer', '123'))
            api.assert_not_called()

    def test_missing_build_cannot_publish_a_different_main_commit(self):
        calls = [[], [{'databaseId': 42, 'headSha': 'other', 'createdAt': '2999-01-01T00:00:00Z', 'status': 'completed', 'conclusion': 'success'}]]
        with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'push', 'GITHUB_SHA': 'expected', 'VIEWER': ''}), patch.object(module, 'gh', side_effect=calls), patch.object(module.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'main advanced'):
                module.resolve_one(('viewer', module.COMPONENTS['viewer']))
            self.assertEqual(run.call_args.args[0], ['gh', 'workflow', 'run', 'desktop-client.yml', '--ref', 'main'])

    def test_reuse_requires_live_artifacts_and_unchanged_component_sources(self):
        def api(*args):
            if args[0] == 'run':
                return [{'databaseId': 42, 'headSha': 'old'}]
            return {'artifacts': [{'name': 'ClipRelay-Stream-macOS', 'expired': False}]}
        with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'push', 'GITHUB_SHA': 'expected', 'GITHUB_REPOSITORY': 'ffffhx/cliprelay', 'VIEWER': ''}), patch.object(module, 'gh', side_effect=api), patch.object(module.subprocess, 'run') as run:
            run.return_value.returncode = 0
            self.assertEqual(module.resolve_one(('viewer', module.COMPONENTS['viewer'])), ('viewer', '42'))
            self.assertEqual(run.call_args.args[0][:3], ['git', 'diff', '--quiet'])


if __name__ == '__main__':
    unittest.main()
