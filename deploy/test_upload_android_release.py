import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from upload_android_release import publication_needed, read_manifest, upload, verify_package


class AndroidUploadTests(unittest.TestCase):
    def setUp(self):
        self.info = dict(versionCode=59, versionName="0.10.29", sha256="a" * 64)

    def test_missing_or_stale_cloud_needs_publication(self):
        self.assertTrue(publication_needed(self.info, None))
        self.assertTrue(publication_needed(self.info, dict(self.info, versionCode=57)))

    def test_same_or_newer_cloud_is_preserved(self):
        self.assertFalse(publication_needed(self.info, self.info.copy()))
        self.assertFalse(publication_needed(self.info, dict(self.info, versionCode=60)))

    def test_same_version_cannot_be_replaced(self):
        for field, value in (("sha256", "b" * 64), ("versionName", "0.10.30")):
            with self.assertRaises(ValueError):
                publication_needed(self.info, dict(self.info, **{field: value}))

    def test_corrupted_apk_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "app.apk"
            path.write_bytes(b"signed APK fixture")
            info = dict(self.info, sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            verify_package(path, info)
            path.write_bytes(b"corrupted")
            with self.assertRaises(ValueError):
                verify_package(path, info)

    def test_invalid_manifest_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "update.json"
            path.write_text(json.dumps(self.info), encoding="utf-8")
            self.assertEqual(self.info, read_manifest(Path(directory)))
            for field, value in (("versionName", "../other"), ("versionCode", True), ("sha256", "invalid")):
                path.write_text(json.dumps(dict(self.info, **{field: value})), encoding="utf-8")
                with self.assertRaises(ValueError):
                    read_manifest(Path(directory))

    @patch("upload_android_release.time.sleep")
    @patch("upload_android_release.subprocess.Popen")
    def test_failed_connection_is_retried(self, popen, _sleep):
        popen.side_effect = [Mock(returncode=1, poll=Mock(return_value=1)),
                             Mock(returncode=0, poll=Mock(return_value=0))]
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "release.tar"
            archive.write_bytes(b"archive")
            upload(archive, Path("key"), Path("hosts"))
        self.assertEqual(2, popen.call_count)

    @patch("upload_android_release.time.sleep")
    @patch("upload_android_release.time.monotonic")
    @patch("upload_android_release.subprocess.Popen")
    def test_stalled_transfer_is_killed_and_retries_are_bounded(self, popen, monotonic, _sleep):
        ticks = iter(range(0, 2000, 70))
        monotonic.side_effect = lambda: next(ticks)
        processes = [Mock(returncode=None), Mock(returncode=None)]
        for process in processes:
            process.poll.side_effect = lambda p=process: p.returncode
            process.kill.side_effect = lambda p=process: setattr(p, "returncode", -9)
        popen.side_effect = processes
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "release.tar"
            archive.write_bytes(b"archive")
            with self.assertRaises(RuntimeError):
                upload(archive, Path("key"), Path("hosts"))
        self.assertEqual(2, popen.call_count)
        for process in processes:
            process.kill.assert_called_once()


if __name__ == "__main__":
    unittest.main()
