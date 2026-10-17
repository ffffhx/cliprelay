"""Build only the owned tone needed by the separate-machine Qt experiment."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile

assert platform.system() == 'Darwin' and os.environ.get('GITHUB_ACTIONS') == 'true'
root = Path(__file__).resolve().parents[1]
runner = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
target = Path(tempfile.mkdtemp(prefix='cliprelay-audio-fixture-', dir=runner))
tone = target/'cliprelay-audio-tone'
subprocess.run(['clang++', '-std=c++17', '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=14.2',
                str(root/'scripts/audio_fixture/tone.mm'), '-framework', 'Foundation', '-framework', 'AudioToolbox',
                '-framework', 'CoreAudio', '-framework', 'AppKit', '-framework', 'ApplicationServices', '-lproc', '-o', str(tone)], check=True)
receipt = {'protocol': 1, 'testCommit': os.environ['GITHUB_SHA'], 'architecture': platform.machine(),
           'sources': {name: hashlib.sha256((root/name).read_bytes()).hexdigest() for name in
                       ['scripts/audio_fixture/tone.mm', 'scripts/build_macos_isolated_audio.py']},
           'files': {'tone': {'path': str(tone), 'sha256': hashlib.sha256(tone.read_bytes()).hexdigest()}}}
manifest = target/'fixture.json'
manifest.write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as env:
    env.write('CLIPRELAY_AUDIO_TONE_FIXTURE='+str(tone)+'\nCLIPRELAY_AUDIO_FIXTURE_RECEIPT='+str(manifest)+'\n')
subprocess.run(['python3', str(root/'scripts/build_macos_audio_observer.py')], check=True)
print(json.dumps({'built': True, 'architecture': receipt['architecture']}))
