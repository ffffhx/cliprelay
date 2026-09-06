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
            with self.assertRaises(KeyError):
                publisher.publish(release(name='../escape.apk'), root)
            self.assertEqual(list(root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
