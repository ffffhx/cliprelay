"""Archive admission tests; no network access, engine execution or user state."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('fetch_sunshine_macos', Path(__file__).resolve().parents[1] / 'fetch_sunshine_macos.py')
fetcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetcher)


class EngineArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cliprelay-host-archive-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archive = self.root / 'engine.tar'
        self.output = self.root / 'download'
        self.output.mkdir()

    def make(self, names):
        with tarfile.open(self.archive, 'w') as archive:
            for name in names:
                info = tarfile.TarInfo(name)
                data = b'fixture'
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))

    def test_regular_files_extract_inside_the_fresh_engine_directory(self):
        self.make(['engine-artifact/manifest.json', 'engine-artifact/source/header.h'])
        result = fetcher.unpack(self.archive, self.output)
        self.assertEqual(result, self.output / 'engine-artifact')
        self.assertEqual((result / 'source/header.h').read_bytes(), b'fixture')

    def test_path_escape_and_platform_aliases_are_rejected_before_any_write(self):
        for name in ('../escape', '/engine-artifact/escape', 'engine-artifact/../escape',
                     'engine-artifact/a\\b', 'engine-artifact/drive:file', 'engine-artifact/a//b'):
            with self.subTest(name=name):
                self.make(['engine-artifact/valid', name])
                with self.assertRaises(ValueError):
                    fetcher.unpack(self.archive, self.output)
                self.assertEqual(list(self.output.iterdir()), [])

    def test_duplicate_case_and_unicode_aliases_are_rejected(self):
        for names in (['a', 'a'], ['Name', 'name'], ['caf\u00e9', 'cafe\u0301']):
            with self.subTest(names=names):
                self.make(['engine-artifact/' + name for name in names])
                with self.assertRaises(ValueError):
                    fetcher.unpack(self.archive, self.output)
                self.assertEqual(list(self.output.iterdir()), [])

    def test_symbolic_links_hardlinks_and_special_files_are_rejected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind):
                with tarfile.open(self.archive, 'w') as archive:
                    info = tarfile.TarInfo('engine-artifact/link')
                    info.type, info.linkname = kind, '../outside'
                    archive.addfile(info)
                with self.assertRaises(ValueError):
                    fetcher.unpack(self.archive, self.output)

    def test_declared_oversized_file_is_rejected_before_reading_its_contents(self):
        info = tarfile.TarInfo('engine-artifact/huge')
        info.size = 128 * 1024 * 1024 + 1
        self.archive.write_bytes(info.tobuf() + bytes(1024))
        with self.assertRaises(ValueError):
            fetcher.unpack(self.archive, self.output)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_existing_engine_directory_is_preserved(self):
        existing = self.output / 'engine-artifact'
        existing.mkdir()
        (existing / 'sentinel').write_text('preserve')
        self.make(['engine-artifact/sentinel'])
        with self.assertRaises(ValueError):
            fetcher.unpack(self.archive, self.output)
        self.assertEqual((existing / 'sentinel').read_text(), 'preserve')


if __name__ == '__main__':
    unittest.main()
