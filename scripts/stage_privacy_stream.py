"""Stage unchanged native components for disposable privacy development checks.

This is not a complete Electron application or a release/package receipt.
"""
import hashlib,json,os,shutil,subprocess,tarfile
from pathlib import Path

root=Path(__file__).resolve().parents[1]
assert os.environ.get('GITHUB_ACTIONS')=='true' and os.uname().sysname=='Darwin'
target=root/'.tools/privacy-stream-mac'
assert not target.exists()
shutil.copytree(root/'windows/electron/mac',target,symlinks=True)
engine=json.loads((root/'.tools/privacy-engine/selection.json').read_bytes())
companion=root/'.tools/privacy-companion'
pin={'commit':os.environ['GITHUB_SHA'],'manifestSha256':hashlib.sha256((companion/'manifest.json').read_bytes()).hexdigest()}
for kind,source,selection in [('host-engine',Path(engine['directory']),engine['pin']),('host-companion',companion,pin)]:
    subprocess.run(['node','-e',
        "require('./windows/electron/mac/'+process.argv[1]+'-artifact.cjs').stage(process.argv[2],process.argv[3],JSON.parse(process.argv[4]));",
        kind,str(source),str(target/kind),json.dumps(selection)],cwd=root,check=True)
    (target/(kind+'-pin.json')).write_text(json.dumps(selection)+'\n')
viewer_root=root/'.tools/privacy-viewer'
with tarfile.open(viewer_root/'ClipRelay-Stream-macOS.tar.gz') as archive:
    members=archive.getmembers()
    assert len(members)<5000 and sum(member.size for member in members)<400*1024*1024
    assert all(member.name.startswith('ClipRelay-Stream-macOS/') or member.name=='ClipRelay-Stream-macOS' for member in members)
    archive.extractall(viewer_root,filter='data')
viewer=viewer_root/'ClipRelay-Stream-macOS'
manifest=json.loads((viewer/'manifest.json').read_bytes())
assert manifest['platform']=='macos' and manifest['protocol']==1
for name,digest in manifest['files'].items():
    file=(viewer/name).resolve();assert file.is_relative_to(viewer.resolve())
    assert hashlib.sha256(file.read_bytes()).hexdigest()==digest
shutil.copytree(viewer,target/'stream-viewer',symlinks=True)
receipt={'scope':'Development components; no complete application acceptance','testCommit':os.environ['GITHUB_SHA'],
         'engine':engine,'companion':pin,'viewerCommit':os.environ['PRIVACY_VIEWER_COMMIT'],
         'viewerManifestSha256':hashlib.sha256((viewer/'manifest.json').read_bytes()).hexdigest()}
(root/'.tools/privacy-stream-components.json').write_text(json.dumps(receipt,indent=2)+'\n')
