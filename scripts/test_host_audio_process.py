"""Exercise only the owned packaged Mac mute worker in disposable CI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import signal
import subprocess
import tempfile
import time

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary',required=True,type=Path)
parser.add_argument('--output',required=True,type=Path)
args=parser.parse_args()
assert platform.system()=='Darwin' and os.environ.get('GITHUB_ACTIONS')=='true'
assert os.environ.get('GITHUB_REPOSITORY')=='ffffhx/cliprelay'
root=Path(__file__).resolve().parents[1]
binary=args.binary.resolve(strict=True)
assert binary==root/'.tools/host-companion/runtime/cliprelay-host-network'
runner=Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
sources=['scripts/test_host_audio_process.py','network/cmd/cliprelay-host-network/main.go']+[
    p.relative_to(root).as_posix() for p in sorted((root/'network/hostaudio').glob('*')) if p.suffix in ['.go','.m','.h']]
report={'protocol':1,'passed':False,'commit':os.environ['GITHUB_SHA'],'architecture':platform.machine(),
        'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),
        'sources':{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in sources},'cases':[],
        'scope':'Private Core Audio tap property readback and owned worker lease/EOF/signal lifetime; no remote playback or physical speaker claim.'}
children=[]
def start(base):
    child=subprocess.Popen([str(binary),'--managed-audio','--state-dir',str(base),'--owner-pid',str(os.getpid())],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0)
    children.append(child)
    return child
def call(child,op,lease=None):
    request={'op':op}
    if lease is not None:request['lease']=lease
    child.stdin.write(b'audio-mute:'+json.dumps(request).encode()+b'\n')
    data=bytearray();deadline=time.monotonic()+5
    while not data.endswith(b'\n'):
        assert time.monotonic()<deadline and len(data)<4096,'AUDIO_WORKER_TIMEOUT'
        if not select.select([child.stdout],[],[],.1)[0]:continue
        block=child.stdout.read(1);assert block,'AUDIO_WORKER_EXIT';data.extend(block)
    value=json.loads(data);assert value['ok'] is True
    assert isinstance(value['outputs'],int) and 0<value['outputs']<=32
    assert value['recovering'] is False
    if op in ['start','renew']:assert value['active'] is True and value['lease']==lease and 0<value['expiresMs']<=15000
    return value
try:
    with tempfile.TemporaryDirectory(prefix='cliprelay-mute-worker-',dir=runner) as folder:
        base=Path(folder)
        child=start(base);initial=call(child,'status');assert not initial['active'] and initial['supported']
        lease=os.urandom(16).hex();call(child,'start',lease);call(child,'renew',lease)
        restored=call(child,'stop',lease);assert not restored['active'] and restored['outputs']==initial['outputs']
        child.stdin.close();assert child.wait(timeout=5)==0
        report['cases'].append('private-native-tap-start-renew-stop-and-output-inventory')
        for mode in ['eof','signal','expiry']:
            child=start(base);call(child,'start',os.urandom(16).hex());started=time.monotonic()
            if mode=='eof':child.stdin.close()
            if mode=='signal':child.send_signal(signal.SIGTERM)
            assert child.wait(timeout=19 if mode=='expiry' else 5)==0
            elapsed=time.monotonic()-started
            if mode=='expiry':assert 12<elapsed<18
            report['cases'].append('active-mute-worker-'+mode+'-normal-cleanup')
        report['passed']=True
except Exception as error:
    report['failure']=str(error)[:160]
    raise
finally:
    for child in children:
        if child.poll() is None:
            try:child.stdin.close();child.wait(timeout=5)
            except Exception:child.kill();child.wait(timeout=5)
    report['exits']=[child.returncode for child in children]
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'passed':report['passed'],'cases':len(report['cases'])}))
