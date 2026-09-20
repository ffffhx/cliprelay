import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('cliprelay-publish.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


def release(code=9, apk=b'signed-apk-fixture', digest=None, name=None):
    version = f'0.6.{code - 7}'
    manifest = dict(versionCode=code, versionName=version,
                    apkUrl='https://github.com/example.apk',
                    sha256=digest or hashlib.sha256(apk).hexdigest())
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as archive:
        for filename, data in [('update.json', json.dumps(manifest).encode()),
                               (name or f'ClipRelay-{version}.apk', apk)]:
            member = tarfile.TarInfo(filename)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    stream.seek(0)
    return stream


class PublishTests(unittest.TestCase):
    def test_publish_and_rewrite_download_url(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            publisher.publish(release(), root)
            info = json.loads((root / 'update.json').read_text())
            self.assertEqual(info['apkUrl'], publisher.BASE_URL + '/ClipRelay-0.6.2.apk')
            self.assertEqual((root / 'ClipRelay-0.6.2.apk').read_bytes(), b'signed-apk-fixture')

    def test_bad_hash_preserves_previous_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            publisher.publish(release(), root)
            before = (root / 'update.json').read_bytes()
            with self.assertRaises(ValueError):
                publisher.publish(release(10, digest='0' * 64), root)
            self.assertEqual((root / 'update.json').read_bytes(), before)
            self.assertFalse((root / 'ClipRelay-0.6.3.apk').exists())

    def test_rollback_and_version_replacement_are_prevented(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            publisher.publish(release(), root)
            before = (root / 'update.json').read_bytes()
            publisher.publish(release(8), root)
            with self.assertRaises(ValueError):
                publisher.publish(release(apk=b'different'), root)
            self.assertEqual((root / 'update.json').read_bytes(), before)

    def test_archive_path_is_not_extracted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises((KeyError, ValueError)):
                publisher.publish(release(name='../escape.apk'), root)
            self.assertEqual(list(root.iterdir()), [])


def windows_release(code=1, version='0.1.0', package=b'windows-package-fixture', **changes):
    manifest = dict(versionCode=code, versionName=version,
                    downloadUrl='https://example.com/not-trusted.zip',
                    sha256=hashlib.sha256(package).hexdigest(), sizeBytes=len(package),
                    releaseNotes='新增更新提醒。\n改进屏幕共享。')
    manifest.update(changes)
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as archive:
        for filename, data in [('windows-update.json', json.dumps(manifest).encode()),
                               (f'ClipRelay-Windows-{version}.zip', package)]:
            member = tarfile.TarInfo(filename)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    stream.seek(0)
    return stream


class WindowsPublishTests(unittest.TestCase):
    def test_independent_channels_and_rewritten_url(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            publisher.publish(release(), root)
            android = (root / 'update.json').read_bytes()
            publisher.publish(windows_release(), root)
            info = json.loads((root / 'windows/update.json').read_text(encoding='utf-8'))
            self.assertEqual(info['downloadUrl'], publisher.BASE_URL + '/windows/ClipRelay-Windows-0.1.0.zip')
            self.assertIn('更新提醒', info['releaseNotes'])
            self.assertEqual((root / 'update.json').read_bytes(), android)

    def test_invalid_windows_metadata_and_checksum(self):
        for change in [dict(sizeBytes=0), dict(sizeBytes=True), dict(releaseNotes=''),
                       dict(releaseNotes='x' * 20001), dict(sha256='0' * 64)]:
            with self.subTest(change=list(change)), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    publisher.publish(windows_release(**change), Path(directory))
                self.assertFalse((Path(directory) / 'windows/update.json').exists())

    def test_immutable_version_and_no_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            publisher.publish(windows_release(2, '0.2.0'), root)
            before = (root / 'windows/update.json').read_bytes()
            publisher.publish(windows_release(), root)
            with self.assertRaises(ValueError):
                publisher.publish(windows_release(2, '0.2.0', b'replacement'), root)
            with self.assertRaises(ValueError):
                publisher.publish(windows_release(3, '0.1.0'), root)
            self.assertEqual((root / 'windows/update.json').read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
