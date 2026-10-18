"""Build disposable, pinned-source Mac privacy receivers; never ship these tools."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ['scripts/privacy_fixture/decode.c', 'scripts/privacy_fixture/colors.mm',
           'scripts/privacy_fixture/CMakeLists.txt', 'scripts/build_privacy_pixel_fixtures.py',
           'engine/desktop-client/upstream.json']


def build():
    assert platform.system() == 'Darwin' and os.environ.get('GITHUB_ACTIONS') == 'true'
    commit = os.environ['GITHUB_SHA']
    assert re.fullmatch(r'[a-f0-9]{40}', commit)
    runner = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    assert runner.is_dir() and runner != Path('/')
    target = Path(tempfile.mkdtemp(prefix='cliprelay-privacy-pixels-', dir=runner))
    assert target.resolve().is_relative_to(runner)
    upstream = json.loads((ROOT/'engine/desktop-client/upstream.json').read_bytes())
    assert upstream['commonRepository'] == 'https://github.com/moonlight-stream/moonlight-common-c'
    assert re.fullmatch(r'[a-f0-9]{40}', upstream['commonCommit'])
    env = dict(os.environ, HOMEBREW_NO_AUTO_UPDATE='1')

    def run(*args):
        subprocess.run(args, env=env, cwd=ROOT, check=True)

    def output(*args):
        return subprocess.check_output(args, env=env, cwd=ROOT, text=True).strip()

    installed = subprocess.run(['brew', 'list', '--versions', 'ffmpeg'], env=env, capture_output=True)
    if installed.returncode:
        run('brew', 'install', 'ffmpeg')
    common = target/'common'
    run('git', 'clone', '--no-checkout', upstream['commonRepository'], str(common))
    run('git', '-C', str(common), 'checkout', '--detach', upstream['commonCommit'])
    assert output('git', '-C', str(common), 'rev-parse', 'HEAD') == upstream['commonCommit']
    run('git', '-C', str(common), 'submodule', 'update', '--init', '--recursive')
    assert all(line.startswith(' ') for line in subprocess.check_output(
        ['git', '-C', str(common), 'submodule', 'status', '--recursive'], text=True).splitlines())
    build_dir = target/'build'
    run('cmake', '-S', str(ROOT/'scripts/privacy_fixture'), '-B', str(build_dir),
        '-DMOONLIGHT_COMMON='+str(common), '-DCMAKE_BUILD_TYPE=Release')
    run('cmake', '--build', str(build_dir), '--parallel', '3')
    colors = target/'cliprelay-privacy-colors'
    run('clang++', '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=14.0',
        str(ROOT/'scripts/privacy_fixture/colors.mm'), '-framework', 'AppKit',
        '-framework', 'ScreenCaptureKit', '-framework', 'CoreVideo', '-o', str(colors))
    decoder = build_dir/'cliprelay-privacy-decode'
    receipt = {'protocol': 1, 'testCommit': commit,
               'architecture': {'x86_64': 'x64', 'arm64': 'arm64'}[platform.machine()],
               'commonCommit': upstream['commonCommit'],
               'libavcodecVersion': output('pkg-config', '--modversion', 'libavcodec'),
               'sources': {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in SOURCES},
               'files': {name: {'path': str(file), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
                         for name, file in [('decoder', decoder), ('colors', colors)]}}
    manifest = target/'fixture.json'
    manifest.write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
    with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as output_file:
        for name, value in [('CLIPRELAY_PRIVACY_DECODE_FIXTURE', decoder),
                            ('CLIPRELAY_PRIVACY_COLOR_FIXTURE', colors),
                            ('CLIPRELAY_PRIVACY_FIXTURE_RECEIPT', manifest)]:
            assert '\n' not in str(value) and '\r' not in str(value)
            output_file.write(name+'='+str(value)+'\n')
    print(json.dumps({'built': True, 'architecture': receipt['architecture'],
                      'commonCommit': receipt['commonCommit'], 'manifest': str(manifest)}))


if __name__ == '__main__':
    build()
