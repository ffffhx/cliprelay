"""Stage verified engine/companion components for disposable audio development."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
assert os.environ.get('GITHUB_ACTIONS') == 'true' and os.uname().sysname == 'Darwin'
target = root/'.tools/audio-stream-mac'
assert not target.exists()
shutil.copytree(root/'windows/electron/mac', target, symlinks=True)
engine = json.loads((root/'.tools/audio-engine/selection.json').read_bytes())
companion = root/'.tools/audio-companion'
pin = {'commit': os.environ['GITHUB_SHA'],
       'manifestSha256': hashlib.sha256((companion/'manifest.json').read_bytes()).hexdigest()}
for kind, source, selection in [('host-engine', Path(engine['directory']), engine['pin']),
                                ('host-companion', companion, pin)]:
    subprocess.run(['node', '-e',
                    "require('./windows/electron/mac/'+process.argv[1]+'-artifact.cjs').stage(process.argv[2],process.argv[3],JSON.parse(process.argv[4]));",
                    kind, str(source), str(target/kind), json.dumps(selection)], cwd=root, check=True)
    (target/(kind+'-pin.json')).write_text(json.dumps(selection)+'\n', encoding='utf-8')
receipt = {'scope': 'Development components; no complete application acceptance',
           'testCommit': os.environ['GITHUB_SHA'], 'engine': engine, 'companion': pin}
viewer_selection=root/'.tools/audio-viewer-download/selection.json'
if viewer_selection.exists():
    viewer=json.loads(viewer_selection.read_bytes())
    source=Path(viewer['directory']).resolve(strict=True)
    assert source==root/'.tools/audio-viewer-download/ClipRelay-Stream-macOS'
    assert hashlib.sha256((source/'manifest.json').read_bytes()).hexdigest()==viewer['manifestSha256']
    subprocess.run(['node','-e',"require('./windows/electron/mac/stream-viewer.cjs').executable(process.argv[1],'darwin');",str(source)],cwd=root,check=True)
    shutil.copytree(source,target/'stream-viewer',symlinks=True)
    (target/'stream-viewer-pin.json').write_text(json.dumps(viewer)+'\n',encoding='utf-8')
    receipt['viewer']=viewer
(root/'.tools/audio-stream-components.json').write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
