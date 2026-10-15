"""Apply ClipRelay's session-only entry point to the pinned Moonlight Qt tree."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

def prepare(source: Path, check=False):
    extension = Path(__file__).resolve().parents[1] / 'engine' / 'desktop-client'
    pinned = json.loads((extension / 'upstream.json').read_text(encoding='utf-8-sig'))
    source = source.resolve(strict=True)
    def git(*args):
        return subprocess.check_output(['git', '-C', str(source), *args], text=True).strip()
    if git('rev-parse', 'HEAD') != pinned['commit']:
        raise RuntimeError('Desktop source does not match the pinned commit')
    if git('diff', 'HEAD', '--', 'app'):
        raise RuntimeError('Refusing to patch modified desktop source')
    for name in ['sessionimport.cpp', 'sessionimport.h']:
        if (source / 'app' / 'backend' / name).exists():
            raise RuntimeError('Refusing to replace existing session importer')
    with tempfile.TemporaryDirectory(prefix='cliprelay-client-') as temporary:
        patch = Path(temporary) / 'desktop-client.patch'
        patch.write_bytes((extension / 'desktop-client.patch').read_bytes().replace(b'\r\n', b'\n'))
        git('apply', '--check', str(patch))
        if not check:
            git('apply', str(patch))
            for name in ['sessionimport.cpp', 'sessionimport.h']:
                shutil.copyfile(extension / name, source / 'app' / 'backend' / name)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    prepare(args.source, args.check)
    print('Pinned desktop patch verified' if args.check else 'Pinned desktop patch applied')
