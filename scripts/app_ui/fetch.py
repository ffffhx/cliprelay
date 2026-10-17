"""Extract an independently verified complete application, without changing it."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import stat
import subprocess
import sys
import tempfile
import zipfile

assert sys.platform == 'darwin' and os.environ.get('GITHUB_ACTIONS') == 'true'
assert os.environ.get('GITHUB_REPOSITORY') == 'ffffhx/cliprelay'
root = Path(__file__).resolve().parents[2]
pin = json.loads(Path(__file__).with_name('application.json').read_bytes())
def gh(endpoint):
    result = subprocess.run(['gh','api',endpoint],capture_output=True,timeout=180)
    assert result.returncode == 0, 'APPLICATION_FETCH_FAILED'
    return result.stdout
def sha(data):return hashlib.sha256(data).hexdigest()
meta = json.loads(gh(f'repos/{pin["repository"]}/actions/runs/{pin["run"]}'))
assert meta['head_sha'] == pin['commit'] and meta['conclusion'] == 'success' and meta['status'] == 'completed'
item = json.loads(gh(f'repos/{pin["repository"]}/actions/artifacts/{pin["artifactId"]}'))
assert item['name'] == pin['artifactName'] and not item['expired'] and item['workflow_run']['head_sha'] == pin['commit']
assert item['size_in_bytes'] == pin['artifactBytes'] and item['digest'] == 'sha256:'+pin['artifactSha256']
outer = gh(f'repos/{pin["repository"]}/actions/artifacts/{pin["artifactId"]}/zip')
assert len(outer) == pin['artifactBytes'] and sha(outer) == pin['artifactSha256']
with zipfile.ZipFile(io.BytesIO(outer)) as archive:
    matches = [name for name in archive.namelist() if PurePosixPath(name).name == pin['archiveName']]
    assert len(matches) == 1
    payload = archive.read(matches[0])
assert sha(payload) == pin['archiveSha256']
runner = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
directory = Path(tempfile.mkdtemp(prefix='cliprelay-complete-app-',dir=runner))
package = directory/'application.zip'; package.write_bytes(payload)
with zipfile.ZipFile(io.BytesIO(payload)) as archive:
    names = archive.namelist(); assert len(names) == len(set(names)) and len(names)<30000
    total = 0
    for info in archive.infolist():
        name=PurePosixPath(info.filename)
        assert not name.is_absolute() and '..' not in name.parts and '\\' not in info.filename
        assert name.parts[0] in ['ClipRelay.app','__MACOSX']
        total += info.file_size; assert total < 2*1024**3
        if stat.S_ISLNK(info.external_attr >> 16):
            target = archive.read(info).decode('utf-8')
            assert not target.startswith('/') and '\\' not in target
            resolved = os.path.normpath(str(name.parent/target))
            assert resolved.startswith('ClipRelay.app/')
subprocess.run(['/usr/bin/ditto','-x','-k',str(package),str(directory)],check=True)
app = directory/'ClipRelay.app'; assert app.resolve(strict=True) == app
for file in app.rglob('*'):
    if file.is_symlink():assert file.resolve(strict=True).is_relative_to(app)
info = plistlib.loads((app/'Contents/Info.plist').read_bytes())
assert info['CFBundleIdentifier'] == 'com.cliprelay.desktop' and info['CFBundleExecutable'] == 'ClipRelay'
modules = app/'Contents/Resources/app/mac'
assert (app/'Contents/Resources/app/main.js').read_text() == "require('./mac/main.cjs');\n"
assert sha((modules/'stream-viewer/manifest.json').read_bytes()) == pin['viewerManifestSha256']
assert sha((modules/'stream-viewer/runtime/ClipRelayStream.app/Contents/MacOS/Moonlight').read_bytes()) == pin['viewerBinarySha256']
tree = json.loads(gh(f'repos/{pin["repository"]}/git/trees/{pin["commit"]}?recursive=1'))
assert tree['truncated'] is False
blobs = {entry['path']:entry['sha'] for entry in tree['tree'] if entry['type']=='blob'}
sources={}
for file in modules.iterdir():
    if not file.is_file() or file.suffix not in ['.cjs','.js','.css','.html','.m']:continue
    data=file.read_bytes(); name='windows/electron/mac/'+file.name
    assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest() == blobs[name]
    # Current UI exploration must not silently exercise different product code.
    assert data == (root/name).read_bytes(), 'PACKAGED_PRODUCT_SOURCE_DIFFERS'
    sources[name]=sha(data)
assert len(sources)>30
receipt={'protocol':1,'testCommit':os.environ['GITHUB_SHA'],'application':pin,'directory':str(app),
         'bundleIdentifier':info['CFBundleIdentifier'],'sources':sources,
         'executableSha256':sha((app/'Contents/MacOS/ClipRelay').read_bytes()),
         'infoSha256':sha((app/'Contents/Info.plist').read_bytes()),'entrySha256':sha((app/'Contents/Resources/app/main.js').read_bytes())}
manifest=directory/'selection.json';manifest.write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
with open(os.environ['GITHUB_ENV'],'a',encoding='utf-8') as env:
    env.write('CLIPRELAY_COMPLETE_APP='+str(app)+'\nCLIPRELAY_COMPLETE_APP_RECEIPT='+str(manifest)+'\n')
print(json.dumps({'verified':True,'applicationCommit':pin['commit'],'firstPartySources':len(sources)}))
