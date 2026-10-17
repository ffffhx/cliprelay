"""Compile the CI-only process output observer, separately from shipping binaries."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile

assert platform.system()=='Darwin' and os.environ.get('GITHUB_ACTIONS')=='true'
root=Path(__file__).resolve().parents[1]
runner=Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
target=Path(tempfile.mkdtemp(prefix='cliprelay-audio-observer-',dir=runner))
assert target.resolve().is_relative_to(runner)
source=root/'scripts/audio_fixture/observe.mm'
binary=target/'cliprelay-audio-observe'
subprocess.run(['clang++','-std=c++17','-fobjc-arc','-Wall','-Wextra','-Werror','-mmacosx-version-min=14.2',
                str(source),'-framework','Foundation','-framework','CoreAudio','-lproc','-o',str(binary)],check=True)
receipt={'protocol':1,'testCommit':os.environ['GITHUB_SHA'],'architecture':platform.machine(),
         'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
         'builderSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
         'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'path':str(binary)}
manifest=target/'observer.json';manifest.write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
with open(os.environ['GITHUB_ENV'],'a',encoding='utf-8') as output:
    output.write('CLIPRELAY_AUDIO_OBSERVER='+str(binary)+'\nCLIPRELAY_AUDIO_OBSERVER_RECEIPT='+str(manifest)+'\n')
print(json.dumps({'built':True,'architecture':receipt['architecture']}))
