"""Bounded archive admission without native execution or network access."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
import copy
import hashlib
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fetch_host_companion', Path(__file__).resolve().parents[1]/'fetch_host_companion.py')
fetcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetcher)


class CompanionArchiveTest(unittest.TestCase):
    def test_terminal_receipts_follow_selected_source_revision(self):
        for path, count in [(b'', 6), (b'scripts/test_host_terminal_android.py\n', 7)]:
            with self.subTest(count=count), patch.object(fetcher.subprocess, 'check_output', return_value=path) as git:
                cases = fetcher.terminal_http_cases('a'*40)
                self.assertEqual(len(cases), count)
                self.assertEqual('tls-terminal-android-protocol' in cases, count == 7)
                git.assert_called_once_with(['git', 'ls-tree', '--name-only', 'a'*40, 'scripts/test_host_terminal_android.py'], cwd=fetcher.ROOT)

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

    def test_only_named_optional_terminal_receipt_is_accepted(self):
        self.make('host-companion/terminal-process-report.json')
        artifact = fetcher.unpack(self.archive, self.output)
        self.assertTrue((artifact/'terminal-process-report.json').is_file())

    def test_named_optional_privacy_receipt_is_accepted(self):
        self.make('host-companion/privacy-process-report.json')
        artifact = fetcher.unpack(self.archive, self.output)
        self.assertTrue((artifact/'privacy-process-report.json').is_file())

    def test_named_optional_audio_receipt_is_accepted(self):
        self.make('host-companion/audio-process-report.json')
        artifact = fetcher.unpack(self.archive, self.output)
        self.assertTrue((artifact/'audio-process-report.json').is_file())

    def test_audio_receipt_requires_selected_native_sources_and_normal_cleanup(self):
        sources = ['network/hostaudio/controller.go', 'network/hostaudio/native_darwin.m',
                   'network/cmd/cliprelay-host-network/main.go', 'scripts/test_host_audio_process.py']
        def content(name):
            return name.encode() + (b" 'observations'" if name.endswith('.py') else b'')
        def git(args, **kwargs):
            self.assertEqual(kwargs['cwd'], fetcher.ROOT)
            if args[1] == 'ls-tree': return ('\n'.join(sources[:2])+'\n').encode()
            self.assertEqual(args[1], 'show')
            self.assertTrue(args[2].startswith('a'*40+':'))
            return content(args[2].split(':',1)[1])
        report = dict(protocol=1, passed=True, commit='a'*40, architecture='arm64', binarySha256='b'*64,
                      sources={name:hashlib.sha256(content(name)).hexdigest() for name in sources},
                      cases=list(fetcher.AUDIO_CASES), exits=[0]*4,
                      observations=[dict(case=name, remainingMs=14990, elapsedSeconds=elapsed, exit=0)
                                    for name,elapsed in [('eof',.05),('signal',.05),('expiry',15.0)]])
        with patch.object(fetcher.subprocess, 'check_output', side_effect=git):
            fetcher.verify_audio_report(report, 'arm64', 'b'*64, 'a'*40)
            for field,value in [('protocol',True),('passed',1),('commit','c'*40),('architecture','x86_64'),
                                ('binarySha256','c'*64),('sources',{}),('cases',report['cases'][:-1]),
                                ('exits',[0,0,0,3]),('exits',[False]*4),('failure',''),
                                ('observations',[]),('observations',[None]),('observations',None)]:
                changed=copy.deepcopy(report);changed[field]=value
                with self.subTest(field=field,value=value), self.assertRaises(ValueError):
                    fetcher.verify_audio_report(changed,'arm64','b'*64,'a'*40)
            for index,field,value in [(0,'elapsedSeconds',2),(1,'exit',3),(2,'elapsedSeconds',4),
                                     (2,'elapsedSeconds',16.1),(2,'elapsedSeconds',float('nan')),
                                     (2,'remainingMs',True),(2,'remainingMs',15001),(2,'elapsedSeconds','15')]:
                changed=copy.deepcopy(report);changed['observations'][index][field]=value
                with self.subTest(index=index,field=field,value=value), self.assertRaises(ValueError):
                    fetcher.verify_audio_report(changed,'arm64','b'*64,'a'*40)

    def test_initial_audio_revision_can_omit_later_observations(self):
        sources=['network/hostaudio/controller.go','network/cmd/cliprelay-host-network/main.go',
                 'scripts/test_host_audio_process.py']
        def git(args,**kwargs):
            return (sources[0]+'\n').encode() if args[1]=='ls-tree' else args[2].split(':',1)[1].encode()
        report=dict(protocol=1,passed=True,commit='a'*40,architecture='arm64',binarySha256='b'*64,
                    sources={name:hashlib.sha256(name.encode()).hexdigest() for name in sources},
                    cases=list(fetcher.AUDIO_CASES),exits=[0]*4)
        with patch.object(fetcher.subprocess,'check_output',side_effect=git):
            fetcher.verify_audio_report(report,'arm64','b'*64,'a'*40)

    def test_privacy_evidence_requires_production_binary_sources_and_bounded_parent_recovery(self):
        sources = ['network/hostprivacy/controller.go', 'network/cmd/cliprelay-host-network/main.go',
                   'network/cmd/cliprelay-host-network/input_unix.go', 'network/go.mod', 'network/go.sum',
                   'scripts/privacy_fixture/audit.mm', 'scripts/test_macos_privacy_worker.py']
        def git(args, **kwargs):
            self.assertEqual(kwargs['cwd'],fetcher.ROOT)
            if args[1] == 'ls-tree': return (sources[0]+'\n').encode()
            self.assertEqual(args[1], 'show')
            self.assertTrue(args[2].startswith('a'*40+':'))
            return args[2].split(':',1)[1].encode()
        report = dict(protocol=1,passed=True,productionCLI=True,architecture='arm64',sourceCommit='a'*40,
                      workerSha256='b'*64,cases=list(fetcher.PRIVACY_CASES),
                      sourceHashes={name:hashlib.sha256(name.encode()).hexdigest() for name in sources},
                      observations=[dict(case='expiry',elapsedSeconds=15.1),dict(case='EOF',elapsedSeconds=.05,exit=0),
                                    dict(case='parent-exit',elapsedSeconds=.3,writerHeld=True),
                                    dict(case='parent-crash',elapsedSeconds=.3,writerHeld=True)])
        with patch.object(fetcher.subprocess,'check_output',side_effect=git):
            fetcher.verify_privacy_report(report,'arm64','b'*64,'a'*40)
            for field,value in [('passed',1),('productionCLI',False),('architecture','x86_64'),
                                ('sourceCommit','c'*40),('workerSha256','c'*64),('sourceHashes',{}),
                                ('cases',report['cases'][:-1]),('observations',report['observations'][:-1])]:
                changed=copy.deepcopy(report);changed[field]=value
                with self.subTest(field=field), self.assertRaises(ValueError):
                    fetcher.verify_privacy_report(changed,'arm64','b'*64,'a'*40)
            for index,field,value in [(0,'elapsedSeconds',17),(1,'exit',2),(2,'writerHeld',False),(3,'elapsedSeconds',3)]:
                changed=copy.deepcopy(report);changed['observations'][index][field]=value
                with self.subTest(observation=index,field=field), self.assertRaises(ValueError):
                    fetcher.verify_privacy_report(changed,'arm64','b'*64,'a'*40)

    def test_terminal_receipt_requires_complete_cases_and_exact_native_binary(self):
        report = dict(passed=True, scope='packaged owned terminal process, not HTTP/client integration',
                      architecture='arm64', binarySha256='a'*64, cases=list(fetcher.TERMINAL_CASES))
        fetcher.verify_terminal_report(report, 'arm64', 'a'*64)
        for field, value in [('passed', 1), ('passed', False), ('scope', 'HTTP verified'), ('architecture', 'x86_64'),
                             ('binarySha256', 'b'*64), ('cases', report['cases'][:-1]), ('extra', True)]:
            with self.subTest(field=field):
                changed = copy.deepcopy(report)
                changed[field] = value
                with self.assertRaises(ValueError):
                    fetcher.verify_terminal_report(changed, 'arm64', 'a'*64)

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
