"""Fetch the pinned, unmodified xterm browser assets; never run package scripts."""
import base64, hashlib, io, json, tarfile, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / 'windows/electron/mac/vendor/terminal'
PACKAGES = [
    ('@xterm/xterm','6.0.0','TQwDdQGtwwDt+2cgKDLn0IRaSxYu1tSUjgKarSDkUM0ZNiSRXFpjxEsvc/Zgc5kq5omJ+V0a8/kIM2WD3sMOYg==',
     {'lib/xterm.js':'xterm.js','css/xterm.css':'xterm.css','LICENSE':'xterm-LICENSE.txt'}),
    ('@xterm/addon-fit','0.11.0','jYcgT6xtVYhnhgxh3QgYDnnNMYTcf8ElbxxFzX0IZo+vabQqSPAjC3c1wJrKB5E19VwQei89QCiZZP86DCPF7g==',
     {'lib/addon-fit.js':'addon-fit.js','LICENSE':'addon-fit-LICENSE.txt'}),
]
DESTINATION.mkdir(parents=True, exist_ok=True)
report={'upstream':'https://github.com/xtermjs/xterm.js','securityGuide':'https://xtermjs.org/docs/guides/security/','packages':[]}
for name,version,expected,files in PACKAGES:
    base=name.rsplit('/',1)[1]
    url=f'https://registry.npmjs.org/{name}/-/{base}-{version}.tgz'
    with urllib.request.urlopen(url,timeout=45) as response:
        data=response.read(10*1024*1024+1)
    assert len(data)<=10*1024*1024 and base64.b64encode(hashlib.sha512(data).digest()).decode()==expected
    digests={}
    with tarfile.open(fileobj=io.BytesIO(data)) as package:
        metadata=json.load(package.extractfile('package/package.json'))
        assert metadata['name']==name and metadata['version']==version
        for source,target in files.items():
            member=package.getmember('package/'+source);assert member.isfile() and member.size<4*1024*1024
            content=package.extractfile(member).read();(DESTINATION/target).write_bytes(content)
            digests[target]=hashlib.sha256(content).hexdigest()
    report['packages'].append({'name':name,'version':version,'url':url,'integrity':'sha512-'+expected,'files':digests})
(DESTINATION/'manifest.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'packages':len(PACKAGES),'files':sum(len(item['files']) for item in report['packages'])}))
