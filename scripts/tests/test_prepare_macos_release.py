import hashlib
import importlib.util
import json
import plistlib
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mac_release', Path(__file__).resolve().parents[1] / 'prepare_macos_release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.artifacts = self.root / 'artifacts'
        self.commit = 'a' * 40
        self.root_patch = patch.object(release, 'ROOT', self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        (self.root / 'windows/electron/mac').mkdir(parents=True)
        (self.root / 'windows/electron/mac/main.cjs').write_bytes(b'fixture source')
        self.put(self.root / 'windows/version.json', {'versionName': '0.4.3'})
        for architecture in ('arm64', 'x64'):
            self.package(architecture)

    def put(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')

    def package(self, architecture, corrupt_component=False):
        directory = self.artifacts / f'ClipRelay-macOS-{architecture}'
        directory.mkdir(parents=True, exist_ok=True)
        archive = directory / f'ClipRelay-macOS-{architecture}-0.4.3.zip'
        with zipfile.ZipFile(archive, 'w') as package:
            package.writestr('ClipRelay.app/Contents/Info.plist', plistlib.dumps(dict(
                CFBundleIdentifier='com.cliprelay.desktop', CFBundleShortVersionString='0.4.3', LSMinimumSystemVersion='12.0')))
            prefix = 'ClipRelay.app/Contents/Resources/app/mac/'
            package.writestr(prefix + 'main.cjs', b'fixture source')
            for component in ('network-helper', 'stream-viewer'):
                package.writestr(prefix + component + '/manifest.json', json.dumps({'files': {'runtime': hashlib.sha256(b'payload').hexdigest()}}))
                package.writestr(prefix + component + '/runtime', b'tampered' if corrupt_component else b'payload')
        self.put(directory / f'app-bundle-{architecture}.json', dict(passed=True, architecture=architecture,
            version='0.4.3', sourceCommit=self.commit, signature='ad-hoc', notarized=False, minimumOS='12.0',
            viewer=True, network=True, host=False, companion=False, archive=archive.name,
            sha256=hashlib.sha256(archive.read_bytes()).hexdigest(), size=archive.stat().st_size))
        for kind in ('viewer-bundle', 'network-bundle', 'native-login-startup'):
            self.put(directory / f'{kind}-{architecture}.json', {'passed': True})
        self.put(directory / f'native-clipboard-bundle-{architecture}.json',
                 dict(arch=architecture, head=self.commit, syntheticOnly=True, cases=list(range(15))))

    def prepare(self):
        release.prepare(self.artifacts, self.root / 'release', self.commit, '12345')

    def test_complete_release_has_two_downloads_and_no_notarization_claim(self):
        self.prepare()
        result = release.read_json(self.root / 'release/macos-update.json')
        self.assertEqual(set(result['assets']), {'arm64', 'x64'})
        self.assertFalse(result['notarized'])

    def test_missing_architecture_blocks_publication(self):
        (self.artifacts / 'ClipRelay-macOS-arm64/app-bundle-arm64.json').unlink()
        with self.assertRaises(FileNotFoundError):
            self.prepare()
        self.assertFalse((self.root / 'release').exists())

    def test_tampered_archive_blocks_publication(self):
        archive = self.artifacts / 'ClipRelay-macOS-x64/ClipRelay-macOS-x64-0.4.3.zip'
        with archive.open('ab') as stream:
            stream.write(b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum/size'):
            self.prepare()

    def test_repacked_tampered_component_still_blocks_publication(self):
        self.package('arm64', corrupt_component=True)
        with self.assertRaisesRegex(ValueError, 'component checksum'):
            self.prepare()

    def test_failed_native_acceptance_blocks_publication(self):
        self.put(self.artifacts / 'ClipRelay-macOS-arm64/native-login-startup-arm64.json', {'passed': False})
        with self.assertRaisesRegex(ValueError, 'native acceptance'):
            self.prepare()

    def test_different_source_commit_blocks_publication(self):
        self.commit = 'b' * 40
        with self.assertRaisesRegex(ValueError, 'selected source'):
            self.prepare()

    def test_deferred_stream_cannot_publish_without_explicit_selection(self):
        path = self.artifacts / 'ClipRelay-macOS-arm64/app-bundle-arm64.json'
        data = release.read_json(path)
        self.put(path, dict(data, host=True, companion=True, streamAcceptance='deferred'))
        with self.assertRaisesRegex(ValueError, 'explicit publication authorization'):
            self.prepare()


if __name__ == '__main__':
    unittest.main()
