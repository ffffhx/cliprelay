"""Bounded downloads for disposable CI. Only public state is printed or retained."""
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

assert os.environ.get('GITHUB_ACTIONS') == 'true'
assert os.environ.get('GITHUB_REPOSITORY') == 'ffffhx/cliprelay'
RUN = os.environ['GITHUB_RUN_ID']
COMMIT = os.environ['GITHUB_SHA']
assert re.fullmatch(r'[0-9]+', RUN) and re.fullmatch(r'[a-f0-9]{40}', COMMIT)


def gh(path):
    result = subprocess.run(['gh', 'api', path], capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError('GITHUB_REQUEST_FAILED')
    return result.stdout


def public_state(name):
    assert re.fullmatch(r'ClipRelay-Audio-Bridge-(identity|route)-(host|viewer)-(linux|x64|arm64)-[1-9][0-9]*', name)
    artifacts = json.loads(gh(f'repos/ffffhx/cliprelay/actions/runs/{RUN}/artifacts?per_page=100'))['artifacts']
    matches = [a for a in artifacts if a['name'] == name]
    if not matches:
        print(json.dumps({'available': False}))
        return
    assert len(matches) == 1
    item = matches[0]
    assert not item['expired'] and item['workflow_run']['head_sha'] == COMMIT and item['size_in_bytes'] < 32768
    data = gh(f'repos/ffffhx/cliprelay/actions/artifacts/{item["id"]}/zip')
    digest = hashlib.sha256(data).hexdigest()
    assert len(data) == item['size_in_bytes'] and item['digest'] == 'sha256:' + digest
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert archive.namelist() == ['public.json'] and archive.infolist()[0].file_size < 8192
        state = json.loads(archive.read('public.json'))
    assert state['run'] == int(RUN) and state['commit'] == COMMIT
    assert state['attempt'] == int(os.environ['GITHUB_RUN_ATTEMPT'])
    print(json.dumps({'available': True, 'artifactId': item['id'], 'outerSha256': digest, 'state': state}))


def connector():
    pin = json.loads(Path(__file__).with_name('cloudflared.json').read_bytes())
    target = ('darwin' if platform.system() == 'Darwin' else 'linux') + '-' + {'x86_64': 'x64', 'arm64': 'arm64', 'aarch64': 'arm64'}[platform.machine()]
    asset = pin['assets'][target]
    metadata = json.loads(gh(f'repos/{pin["repository"]}/releases/assets/{asset["id"]}'))
    assert metadata['name'] == asset['name'] and metadata['size'] == asset['size']
    assert metadata['digest'] == 'sha256:' + asset['sha256']
    expected = f'https://github.com/{pin["repository"]}/releases/download/{pin["version"]}/{asset["name"]}'
    assert metadata['browser_download_url'] == expected
    with urllib.request.urlopen(expected, timeout=60) as response:
        data = response.read(asset['size'] + 1)
    assert len(data) == asset['size'] and hashlib.sha256(data).hexdigest() == asset['sha256']
    if asset['name'].endswith('.tgz'):
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            members = archive.getmembers()
            assert len(members) == 1 and members[0].name in ['cloudflared', './cloudflared']
            assert members[0].isfile() and members[0].size < 80 * 1024 * 1024
            binary = archive.extractfile(members[0]).read()
    else:
        binary = data
    directory = Path(os.environ['CLIPRELAY_BRIDGE_STATE']).resolve(strict=True)
    runner = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    assert directory.parent == runner and directory.name.startswith('cliprelay-audio-bridge-action-')
    destination = directory / 'cloudflared'
    with destination.open('xb') as output:
        output.write(binary)
    destination.chmod(0o700)
    print(json.dumps({'path': str(destination), 'version': pin['version'], 'archiveSha256': asset['sha256'],
                      'binarySha256': hashlib.sha256(binary).hexdigest()}))


try:
    if len(sys.argv) == 3 and sys.argv[1] == 'public':
        public_state(sys.argv[2])
    elif sys.argv[1:] == ['connector']:
        connector()
    else:
        raise RuntimeError('DOWNLOAD_MODE_INVALID')
except Exception:
    # Never include signed download URLs or authentication errors in receipts.
    print(json.dumps({'error': 'CI_BRIDGE_DOWNLOAD_FAILED'}))
    sys.exit(2)
