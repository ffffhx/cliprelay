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
    common = source / 'moonlight-common-c/moonlight-common-c'
    def git(*args):
        return subprocess.check_output(['git', '-C', str(source), *args], text=True).strip()
    if git('rev-parse', 'HEAD') != pinned['commit']:
        raise RuntimeError('Desktop source does not match the pinned commit')
    if git('diff', 'HEAD', '--', 'app'):
        raise RuntimeError('Refusing to patch modified desktop source')
    def common_git(*args):
        return subprocess.check_output(['git', '-C', str(common), *args], text=True).strip()
    if common_git('rev-parse', 'HEAD') != pinned['commonCommit'] or common_git('diff', 'HEAD', '--', '.'):
        raise RuntimeError('Common streaming source must match the unmodified pinned commit')
    if (common / 'src/cliprelay-portmap.h').exists():
        raise RuntimeError('Refusing to replace existing port mapping header')
    for name in ['sessionimport.cpp', 'sessionimport.h']:
        if (source / 'app' / 'backend' / name).exists():
            raise RuntimeError('Refusing to replace existing session importer')
    for name in ['inputstate.h', 'inputepoch.cpp']:
        if (source / 'app/streaming/input' / name).exists():
            raise RuntimeError('Refusing to replace existing input epoch extension')
    with tempfile.TemporaryDirectory(prefix='cliprelay-client-') as temporary:
        patch = Path(temporary) / 'desktop-client.patch'
        patch.write_bytes((extension / 'desktop-client.patch').read_bytes().replace(b'\r\n', b'\n'))
        git('apply', '--check', str(patch))
        common_patch = Path(temporary) / 'desktop-common.patch'
        common_patch.write_bytes((extension / 'desktop-common.patch').read_bytes().replace(b'\r\n', b'\n'))
        common_git('apply', '--check', str(common_patch))
        if not check:
            git('apply', str(patch))
            common_git('apply', str(common_patch))
            shutil.copyfile(extension / 'portmap.h', common / 'src/cliprelay-portmap.h')
            for name in ['sessionimport.cpp', 'sessionimport.h']:
                shutil.copyfile(extension / name, source / 'app' / 'backend' / name)
            for name in ['inputstate.h', 'inputepoch.cpp']:
                shutil.copyfile(extension / name, source / 'app/streaming/input' / name)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    prepare(args.source, args.check)
    print('Pinned desktop patch verified' if args.check else 'Pinned desktop patch applied')
