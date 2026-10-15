"""Exercise C# mute journal and callback binding on the non-default virtual device."""
import datetime,json,pathlib,subprocess,sys,uuid
sys.stdout.reconfigure(encoding='utf-8')
root=pathlib.Path(__file__).resolve().parents[2]
out=root/'.tools/uu-parity';worker=out/'audio-mute-tests.exe';recovery=out/'audio-loopback.exe'
flags=subprocess.CREATE_NO_WINDOW
def call(exe,*args):return subprocess.check_output([str(exe),*args],text=True,encoding='utf-8',timeout=8,creationflags=flags)
before=json.loads(call(worker,'--native-readonly'))
selected=[x for x in before if 'Steam Streaming Speakers' in x['Name'] and not x['Default']]
if len(selected)!=1:raise SystemExit('require exactly one existing non-default virtual speaker')
target=selected[0]
inventory=json.loads(call(recovery,'--list'))
if any(x['activeSessions'] for x in inventory if 'Steam Streaming Speakers' in x['name']):raise SystemExit('virtual speaker is in use')
journal=out/('audio-mute-native-'+uuid.uuid4().hex+'.json')
result=dict(created=datetime.datetime.now(datetime.timezone.utc).isoformat(),scope='Existing non-default Steam virtual speaker only')
try:
    result['output']=call(worker,'--native-virtual',target['Id'],str(journal)).strip()
    result['workerPassed']=result['output'].startswith('PASS ')
finally:
    call(recovery,'--restore-mute','1' if target['Muted'] else '0',target['Id'])
    after=json.loads(call(worker,'--native-readonly'))
    result['settingsUnchanged']=before==after
    result['journalRemoved']=not journal.exists()
    (out/'audio-mute-native-report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))
if not result.get('workerPassed') or not result['settingsUnchanged'] or not result['journalRemoved']:sys.exit(1)
