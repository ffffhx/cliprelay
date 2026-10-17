"""Select an immutable successfully built viewer for isolated native audio testing."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import zipfile

assert sys.platform=='darwin' and os.environ.get('GITHUB_ACTIONS')=='true'
run=sys.argv[1];assert re.fullmatch(r'[0-9]+',run)
root=Path(__file__).resolve().parents[1]
target=root/'.tools/audio-viewer-download';assert not target.exists()
def gh(*args):return subprocess.check_output(['gh',*args],cwd=root)
metadata=json.loads(gh('run','view',run,'--json','name,status,conclusion,headSha'))
assert metadata['name']=='Desktop Client Build' and metadata['status']=='completed' and metadata['conclusion']=='success'
assert re.fullmatch(r'[a-f0-9]{40}',metadata['headSha'])
artifacts=json.loads(gh('api',f'repos/ffffhx/cliprelay/actions/runs/{run}/artifacts'))['artifacts']
matches=[a for a in artifacts if a['name']=='ClipRelay-Stream-macOS'];assert len(matches)==1
artifact=matches[0];assert not artifact['expired'] and artifact['workflow_run']['head_sha']==metadata['headSha']
assert artifact['size_in_bytes']<350*1024*1024
data=gh('api',f'repos/ffffhx/cliprelay/actions/artifacts/{artifact["id"]}/zip')
digest=hashlib.sha256(data).hexdigest();assert artifact['digest']=='sha256:'+digest and len(data)==artifact['size_in_bytes']
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    assert archive.namelist()==['ClipRelay-Stream-macOS.tar.gz']
    assert archive.infolist()[0].file_size<350*1024*1024
    payload=archive.read('ClipRelay-Stream-macOS.tar.gz')
target.mkdir(parents=True)
with tarfile.open(fileobj=io.BytesIO(payload),mode='r:gz') as archive:
    members=archive.getmembers();assert len(members)<15000
    assert sum(m.size for m in members)<1500*1024*1024
    for member in members:
        p=PurePosixPath(member.name)
        assert not p.is_absolute() and '..' not in p.parts and p.parts[0]=='ClipRelay-Stream-macOS'
        assert member.isfile() or member.isdir() or member.issym()
    archive.extractall(target,filter='data')
viewer=target/'ClipRelay-Stream-macOS';manifest=json.loads((viewer/'manifest.json').read_bytes())
assert manifest['platform']=='macos' and manifest['protocol']==1
files={str(p.relative_to(viewer)).replace('\\','/'):p for p in viewer.rglob('*') if p.is_file() and not p.is_symlink()}
assert set(files)==set(manifest['files'])|{'manifest.json'}
for name,digest in manifest['files'].items():
    assert files[name].resolve(strict=True).is_relative_to(viewer)
    assert hashlib.sha256(files[name].read_bytes()).hexdigest()==digest,name
for file in viewer.rglob('*'):
    if file.is_symlink():assert file.resolve(strict=True).is_relative_to(viewer)
selection={'run':int(run),'commit':metadata['headSha'],'directory':str(viewer),'artifactId':artifact['id'],
           'outerSha256':hashlib.sha256(data).hexdigest(),'archiveSha256':hashlib.sha256(payload).hexdigest(),
           'manifestSha256':hashlib.sha256((viewer/'manifest.json').read_bytes()).hexdigest(),
           'binarySha256':manifest['files']['runtime/ClipRelayStream.app/Contents/MacOS/Moonlight']}
(target/'selection.json').write_text(json.dumps(selection,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'verified':True,'viewerCommit':metadata['headSha'],'files':len(manifest['files'])}))
