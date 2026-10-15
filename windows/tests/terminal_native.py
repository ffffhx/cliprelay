"""Bounded real ConPTY protocol acceptance; uses only newly created test shells."""
import base64
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
EXE = Path(sys.argv[1]).resolve() if len(sys.argv)>1 else ROOT/'.tools/uu-parity/terminal-tests.exe'
CHILD_EXE = ROOT/'.tools/uu-parity/terminal-tests.exe'
OWNER = 'a'*64
OTHER = 'b'*64
ID = '1'*32
SECOND = '2'*32
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.OpenProcess.argtypes = [wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE,wintypes.DWORD]
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
process = subprocess.Popen([str(EXE), '--terminal-probe'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
messages = queue.Queue()
def read():
    while True:
        line = process.stdout.readline(65538)
        if not line:
            messages.put(RuntimeError('worker exited: '+process.stderr.read(2048).decode('utf-8',errors='replace'))); return
        if len(line)>65536:
            messages.put(RuntimeError('worker response too large')); return
        try: messages.put(json.loads(line))
        except Exception as error: messages.put(RuntimeError('Invalid worker output: '+repr(line[:1024])))
threading.Thread(target=read, daemon=True).start()
def call(op, **fields):
    request = {'op':op, **fields}
    if op!='sync': request.setdefault('owner',OWNER)
    process.stdin.write((json.dumps(request)+'\n').encode());process.stdin.flush()
    result = messages.get(timeout=12)
    if isinstance(result,Exception):raise result
    return result
def ok(op, **fields):
    result=call(op,**fields)
    assert result['ok'], result
    return result

offsets = {ID:0, SECOND:0}
transcripts = {ID:b'', SECOND:b''}
def poll(identifier, target, timeout=8):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        ok('sync',owners=[OWNER,OTHER])
        reply=ok('read',instance=instance,id=identifier,offset=offsets[identifier])
        assert not reply['gap']
        chunk=base64.b64decode(reply['data'],validate=True)
        assert reply['next']==offsets[identifier]+len(chunk)
        offsets[identifier]=reply['next'];transcripts[identifier]+=chunk
        if target in transcripts[identifier].decode('utf-8',errors='replace'):return
        time.sleep(.03)
    raise AssertionError('terminal did not emit expected test result')
def write(identifier, sequence, text):
    return ok('write',instance=instance,id=identifier,sequence=sequence,data=base64.b64encode(text.encode()).decode())

handle=None
report={'checks':[], 'hardware_input':False, 'transcripts_saved':False}
try:
    ok('sync',owners=[OWNER,OTHER]);status=ok('list');instance=status['instance']
    assert status['sessions']==[] and status['nextOpen']==1
    ok('open',instance=instance,id=ID,shell='cmd',columns=80,rows=24,sequence=1)
    write(ID,1,'set CLIPRELAY_TEST_COUNT=0\r')
    write(ID,2,'set /a CLIPRELAY_TEST_COUNT+=1\r')
    write(ID,2,'set /a CLIPRELAY_TEST_COUNT+=1\r')
    write(ID,3,'echo COUNT_IS_%CLIPRELAY_TEST_COUNT%\r')
    poll(ID,'COUNT_IS_1')
    report['checks'].append('interactive cmd, actual execution, duplicate write does not execute twice')
    resumed=ok('read',instance=instance,id=ID,offset=offsets[ID])
    assert resumed['offset']==offsets[ID]
    offsets[ID]=resumed['next'];transcripts[ID]+=base64.b64decode(resumed['data'])
    report['checks'].append('output resumes at the acknowledged byte offset')
    resized=ok('resize',instance=instance,id=ID,columns=100,rows=30)
    assert resized['session']['columns']==100 and resized['session']['rows']==30
    report['checks'].append('real ConPTY resize')
    ok('open',instance=instance,id=SECOND,shell='powershell',columns=80,rows=24,sequence=2)
    write(SECOND,1,"Write-Output ('POWER'+'SHELL_READY')\r")
    poll(SECOND,'POWERSHELL_READY')
    assert len(ok('list')['sessions'])==2
    assert call('read',owner=OTHER,instance=instance,id=ID,offset=0)['code']=='TERMINAL_NOT_FOUND'
    report['checks'].append('concurrent PowerShell and cmd sessions, certificate owner isolation')
    write(ID,4,'"'+str(CHILD_EXE)+'" --pid-wait\r')
    poll(ID,'TERMINAL_CHILD_PID:')
    plain=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',transcripts[ID].decode('utf-8',errors='replace'))
    match=re.search(r'TERMINAL_CHILD_PID:(\d+)',plain);assert match
    pid=int(match.group(1));handle=kernel.OpenProcess(0x00100000,False,pid)
    assert handle and kernel.WaitForSingleObject(handle,0)==258
    ok('close',instance=instance,id=ID)
    assert kernel.WaitForSingleObject(handle,2000)==0, 'descendant survived session close'
    report['checks'].append('close kills the owned shell descendant, not only the shell')
    ok('sync',owners=[OTHER]);assert not ok('list',owner=OTHER)['sessions']
    ok('sync',owners=[OWNER,OTHER]);states=ok('list')['sessions']
    assert next(s for s in states if s['id']==SECOND)['state']=='revoked'
    report['checks'].append('revocation closes the live PowerShell session')
    third='3'*32;offsets[third]=0;transcripts[third]=b''
    ok('open',instance=instance,id=third,shell='cmd',columns=80,rows=24,sequence=ok('list')['nextOpen'])
    write(third,1,'"'+str(CHILD_EXE)+'" --pid-wait\r');poll(third,'TERMINAL_CHILD_PID:')
    plain=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',transcripts[third].decode('utf-8',errors='replace'))
    match=re.search(r'TERMINAL_CHILD_PID:(\d+)',plain);assert match
    kernel.CloseHandle(handle);handle=kernel.OpenProcess(0x00100000,False,int(match.group(1)));assert handle
    assert kernel.WaitForSingleObject(handle,0)==258
    process.stdin.close();assert process.wait(timeout=6)==0
    assert kernel.WaitForSingleObject(handle,1000)==0, 'live child survived worker EOF'
    report['checks'].append('worker EOF ends a still-live terminal and its descendant')
    report['workerExited']=True
    target=ROOT/'.tools/uu-parity/terminal-native-report.json'
    target.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report))
finally:
    if handle:kernel.CloseHandle(handle)
    if process.poll() is None:
        process.stdin.close()
        try:process.wait(timeout=6)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=3)
