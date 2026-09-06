import unittest

from android_release_version import next_version


class ReleaseVersionTest(unittest.TestCase):
    def test_unchanged_version_advances(self):
        self.assertEqual(next_version("0.6.2", 9, {"versionName": "0.6.2", "versionCode": 9}), ("0.6.3", 10))

    def test_manual_version_is_preserved(self):
        self.assertEqual(next_version("0.7.0", 20, {"versionName": "0.6.2", "versionCode": 9}), ("0.7.0", 20))

    def test_stale_checkout_advances_past_release(self):
        self.assertEqual(next_version("0.6.2", 9, {"versionName": "0.6.4", "versionCode": 12}), ("0.6.5", 13))

    def test_manual_name_still_advances_code(self):
        self.assertEqual(next_version("0.7.0", 9, {"versionName": "0.6.2", "versionCode": 9}), ("0.7.0", 10))

    def test_initial_release(self):
        self.assertEqual(next_version("0.1.0", 1, None), ("0.1.0", 1))

    def test_invalid_manifest_fails(self):
        with self.assertRaises(ValueError):
            next_version("0.6.2", 9, {"versionName": "bad", "versionCode": 9})


if __name__ == "__main__":
    unittest.main()
