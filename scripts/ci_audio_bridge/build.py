"""Build the disposable bridge with a source/binary receipt; no installation."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess

assert os.environ.get('GITHUB_ACTIONS') == 'true'
assert os.environ.get('GITHUB_REPOSITORY') == 'ffffhx/cliprelay'
ROOT = Path(__file__).resolve().parents[2]
commit = os.environ['GITHUB_SHA']
assert re.fullmatch(r'[a-f0-9]{40}', commit)
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip() == commit
target = Path(os.environ['RUNNER_TEMP']).resolve(strict=True) / 'cliprelay-audio-bridge'
subprocess.run(['go', 'build', '-trimpath', '-o', str(target), './cmd/ci-audio-bridge'], cwd=ROOT/'network', check=True)
sources = ['network/go.mod', 'network/go.sum', 'network/transport/bridge.go',
           'network/internal/ciaudiobridge/bridge.go', 'network/internal/ciaudiobridge/bridge_test.go',
           'network/cmd/ci-audio-bridge/main.go', 'network/cmd/ci-audio-bridge/main_test.go', 'scripts/ci_audio_bridge/build.py',
           'scripts/ci_audio_bridge/action.yml', 'scripts/ci_audio_bridge/index.mjs',
           'scripts/ci_audio_bridge/fetch.py', 'scripts/ci_audio_bridge/mac_audio.cjs', 'scripts/ci_audio_bridge/package.json',
           'scripts/ci_audio_bridge/package-lock.json', 'scripts/ci_audio_bridge/cloudflared.json']
receipt = {'protocol': 1, 'commit': commit, 'platform': platform.system(), 'architecture': platform.machine(),
           'binarySha256': hashlib.sha256(target.read_bytes()).hexdigest(),
           'sources': {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in sources}}
receipt_path = target.with_suffix('.json')
receipt_path.write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as env:
    env.write('CLIPRELAY_BRIDGE_BINARY='+str(target)+'\nCLIPRELAY_BRIDGE_RECEIPT='+str(receipt_path)+'\n')
print(json.dumps({'built': True, 'platform': receipt['platform'], 'architecture': receipt['architecture'], 'binarySha256': receipt['binarySha256']}))
