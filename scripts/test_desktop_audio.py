"""Check the production SDL renderer against the real dummy device and an API error."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
assert sys.platform == 'linux', 'ELF link wrapper and SDL dummy test are Linux-only'
root = Path(__file__).resolve().parents[1]
source = args.source.resolve(strict=True)
output = args.output.resolve()
assert not output.exists(), 'Test output must be fresh'
pin = json.loads((root/'engine/desktop-client/upstream.json').read_text(encoding='utf-8'))
assert subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip() == pin['commit']
name = 'app/streaming/audio/renderers/sdlaud.cpp'
original = subprocess.check_output(['git','-C',str(source),'show',pin['commit']+':'+name])
output.mkdir(parents=True)
baseline = output/'sdlaud-upstream.cpp'
baseline.write_bytes(original)
observations = {}
for label, renderer in [('upstream',baseline),('patched',source/name)]:
    build = output/label
    build.mkdir()
    subprocess.run(['qmake6',str(root/'engine/desktop-client/tests/audio_sdl.pro'),
                    'MOONLIGHT_SOURCE='+str(source),'AUDIO_RENDERER_SOURCE='+str(renderer)],
                   cwd=build,check=True,timeout=30)
    subprocess.run(['make','-j2'],cwd=build,check=True,timeout=90)
    process = subprocess.run([str(build/'cliprelay-audio-sdl')],capture_output=True,text=True,timeout=15)
    if label == 'upstream':
        assert process.returncode == 2 and process.stderr.splitlines()[-1] == 'queue-error-not-propagated', process.stderr
        observations[label] = {'exitCode':process.returncode,'failure':'queue-error-not-propagated'}
    else:
        assert process.returncode == 0, process.stderr
        observations[label] = json.loads(process.stdout)
        assert observations[label]['passed'] is True
        assert observations[label]['realQueueError'] is True and observations[label]['audioSubsystemReleased'] is True
    observations[label]['rendererSha256'] = hashlib.sha256(renderer.read_bytes()).hexdigest()
    observations[label]['binarySha256'] = hashlib.sha256((build/'cliprelay-audio-sdl').read_bytes()).hexdigest()
report = {'protocol':1,'passed':True,'testCommit':os.environ.get('GITHUB_SHA'),'upstreamCommit':pin['commit'],
          'sources':{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in [
              'scripts/test_desktop_audio.py','engine/desktop-client/tests/audio_sdl.cpp',
              'engine/desktop-client/tests/audio_sdl.pro','engine/desktop-client/desktop-client.patch']},
          'scope':'Real SDL dummy output with one real invalid-device queue error; production renderer compiled unchanged from each source. Session automatic recovery, physical output and hotplug are not tested.',
          'observations':observations}
(output/'receipt.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report))
