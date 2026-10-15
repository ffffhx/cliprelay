"""Test existing non-default virtual speakers only; preserve endpoint state."""
import datetime,json,pathlib,queue,subprocess,sys,threading
sys.stdout.reconfigure(encoding='utf-8')

root=pathlib.Path(__file__).resolve().parents[2]
out=root/'.tools/uu-parity'
exe=out/'audio-loopback.exe'
flags=subprocess.CREATE_NO_WINDOW
def run(*args):return subprocess.check_output([str(exe),*args],text=True,encoding='utf-8',timeout=8,creationflags=flags)
before=json.loads(run('--list'))
physical=sys.argv[1:]==['--quiet-default']
per_process=sys.argv[1:]==['--process']
if sys.argv[1:] and not physical and not per_process:raise SystemExit('usage: audio_loopback.py [--quiet-default | --process]')
mode='--probe-quiet-default' if physical else '--probe-process-steam' if per_process else '--probe-steam'
process=subprocess.Popen([str(exe),mode],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=flags)
state=None;result={}
try:
    ready=queue.Queue(maxsize=1)
    reader=threading.Thread(target=lambda:ready.put(process.stdout.readline()),daemon=True);reader.start()
    line=ready.get(timeout=5);reader.join(timeout=1)
    if not line:raise RuntimeError('fixture exited before ready: '+process.stderr.read(2048))
    state=json.loads(line)
    if not state.get('ready'):raise RuntimeError('fixture not ready')
    journal=out/'audio-loopback-recovery.json'
    journal.write_text(json.dumps(state)+'\n',encoding='utf-8')
    stdout,stderr=process.communicate('run\n',timeout=10)
    if process.returncode:raise RuntimeError(stderr)
    result=json.loads(stdout)
    if per_process:
        amplitudes=[result[k] for k in ('before','muted','after')]
        result['levelStable']=all(abs(v-.005)<.00005 for v in amplitudes) and min(result['samples'])>=24000
finally:
    if process.poll() is None:process.kill();process.wait(timeout=4)
    if state is not None:
        run('--restore-mute','1' if state['mute'] else '0',state['id'])
        (out/'audio-loopback-recovery.json').unlink(missing_ok=True)
    after=json.loads(run('--list'))
    states=lambda devices:[{k:v for k,v in d.items() if k!='activeSessions'} for d in devices]
    result.update(beforeDevices=before,afterDevices=after,statesRestored=states(before)==states(after),capture='own process tree' if per_process else 'selected endpoint',scope='Quiet default endpoint; hardware mute and no competing playback required' if physical else 'Existing non-default Steam virtual speakers; no default route or physical endpoint changes',created=datetime.datetime.now(datetime.timezone.utc).isoformat())
    (out/('audio-loopback-physical-report.json' if physical else 'audio-loopback-process-report.json' if per_process else 'audio-loopback-report.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))
if not result.get('restored') or not result['statesRestored']:sys.exit(1)
if per_process and not result.get('levelStable'):sys.exit(1)
