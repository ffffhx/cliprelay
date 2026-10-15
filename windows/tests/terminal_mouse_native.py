"""Isolated ConPTY mouse events; does not send input to the desktop or read clipboard."""
import base64,json,os,queue,re,subprocess,sys,threading,time
from pathlib import Path
root=Path(__file__).resolve().parents[2]
worker=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else root/'.tools/uu-parity/terminal-tests.exe'
fixture=root/'.tools/uu-parity/terminal-tests.exe'
process=subprocess.Popen([str(worker),'--terminal-probe'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
replies=queue.Queue()
def reader():
    for line in process.stdout:replies.put(json.loads(line))
    replies.put(RuntimeError('worker exited'))
threading.Thread(target=reader,daemon=True).start()
owner='a'*64;identifier='2'*32
def call(op,**fields):
    payload={'op':op,**fields}
    if op!='sync':payload['owner']=owner
    process.stdin.write((json.dumps(payload)+'\n').encode());process.stdin.flush();reply=replies.get(timeout=10)
    if isinstance(reply,Exception):raise reply
    assert reply['ok'],reply
    return reply
try:
    call('sync',owners=[owner]);listed=call('list');assert listed['mouseProtocol']==1;instance=listed['instance']
    call('open',instance=instance,id=identifier,shell='cmd',columns=120,rows=30,sequence=listed['nextOpen'])
    call('write',instance=instance,id=identifier,sequence=1,data=base64.b64encode(('"'+str(fixture)+'" --mouse-echo\r').encode()).decode())
    offset=0;output=b''
    def read():
        global offset,output
        call('sync',owners=[owner]);reply=call('read',instance=instance,id=identifier,offset=offset);offset=reply['next'];output+=base64.b64decode(reply['data']);return reply['session']['mouse']
    deadline=time.monotonic()+6
    while time.monotonic()<deadline:
        state=read()
        if state['mode']==1002 and state['format']==1006 and b'MOUSE_READY' in output:break
        time.sleep(.025)
    else:raise AssertionError('native VT mouse mode not observed: '+repr(state)+' '+repr(output[-1000:]))
    press=dict(instance=instance,id=identifier,sequence=1,action='press',epoch=state['epoch'],gesture=state['nextGesture'],column=5,row=7,button=0,modifiers=0)
    call('mouse',**press);call('mouse',**press)
    call('mouse',**{**press,'sequence':2,'action':'move','column':6,'row':8,'modifiers':16})
    started=time.monotonic();deadline=started+5
    while time.monotonic()<deadline:
        state=read()
        match=re.search(rb'MOUSE_CAPTURE:([A-Za-z0-9+/=]+)',output)
        if match:
            actual=base64.b64decode(match[1]);break
        time.sleep(.025)
    else:raise AssertionError('native release missing: '+repr(state)+' '+repr(output[-1500:]))
    expected=b'\x1b[<0;5;7M\x1b[<48;6;8M\x1b[<16;6;8m'
    assert actual==expected,(actual,expected)
    assert state['buttons']==0 and state['acceptedSequence']==2 and state['writtenSequence']==2,state
    call('close',instance=instance,id=identifier)
    report={'passed':True,'scope':'new ordinary-user ConPTY test process only','checks':['actual VT mouse mode observation','duplicate press receipt does not replay','live movement before lift','native writer releases after no renewal','Control modifier retained on release','cleanup does not forge input receipt'],'releaseObservedMs':round((time.monotonic()-started)*1000),'desktopInput':False,'clipboard':False}
    (root/'.tools/uu-parity/terminal-mouse-native-report.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8');print(json.dumps(report))
finally:
    process.stdin.close()
    try:process.wait(timeout=5)
    except subprocess.TimeoutExpired:process.kill();process.wait();raise
    assert process.returncode==0,process.stderr.read().decode(errors='replace')
