"""Bounded archive admission without native execution or network access."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('fetch_host_companion', Path(__file__).resolve().parents[1]/'fetch_host_companion.py')
fetcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetcher)


class CompanionArchiveTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='cliprelay-companion-archive-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.archive = self.root/'fixture.tar'
        self.output = self.root/'download'
        self.output.mkdir()

    def make(self, extra=None, omit=None):
        names = ['host-companion/'+name for name in sorted(fetcher.FILES | {'manifest.json', 'process-report.json'})]
        if omit:
            names.remove('host-companion/'+omit)
        with tarfile.open(self.archive, 'w') as archive:
            for name in names:
                info = tarfile.TarInfo(name)
                info.size = 7
                archive.addfile(info, io.BytesIO(b'fixture'))
            if extra:
                info = extra if isinstance(extra, tarfile.TarInfo) else tarfile.TarInfo(extra)
                archive.addfile(info)

    def test_exact_format_extracts_only_under_new_companion_root(self):
        self.make()
        artifact = fetcher.unpack(self.archive, self.output)
        self.assertEqual(artifact, self.output/'host-companion')
        self.assertEqual((artifact/'runtime/cliprelay-host-network').read_bytes(), b'fixture')

    def test_missing_unexpected_escape_and_alias_entries_fail_before_writes(self):
        for name in ['host-companion/unexpected', '../escape', '/host-companion/escape',
                     'host-companion/../escape', 'host-companion/a\\b', 'host-companion/a:b',
                     'host-companion/manifest.json', 'host-companion/Manifest.json', 'host-companion/a//b']:
            with self.subTest(name=name):
                self.make(name)
                with self.assertRaises(ValueError):
                    fetcher.unpack(self.archive, self.output)
                self.assertEqual(list(self.output.iterdir()), [])
        self.make(omit='LICENSE')
        with self.assertRaises(ValueError):
            fetcher.unpack(self.archive, self.output)

    def test_link_and_special_file_entries_are_rejected(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE]:
            info = tarfile.TarInfo('host-companion/unsafe')
            info.type, info.linkname = kind, '../outside'
            self.make(info)
            with self.assertRaises(ValueError):
                fetcher.unpack(self.archive, self.output)
            self.assertEqual(list(self.output.iterdir()), [])

    def test_declared_oversized_member_is_rejected_without_reading_payload(self):
        info = tarfile.TarInfo('host-companion/huge')
        info.size = 64*1024*1024+1
        self.archive.write_bytes(info.tobuf()+bytes(1024))
        with self.assertRaises(ValueError):
            fetcher.unpack(self.archive, self.output)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_existing_destination_is_preserved(self):
        target = self.output/'host-companion'
        target.mkdir()
        (target/'sentinel').write_text('preserve')
        self.make()
        with self.assertRaises(ValueError):
            fetcher.unpack(self.archive, self.output)
        self.assertEqual((target/'sentinel').read_text(), 'preserve')


if __name__ == '__main__':
    unittest.main()
