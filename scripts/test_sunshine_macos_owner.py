"""Exercise the signed Mac engine's actual owner admission and process shutdown."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time

spec=importlib.util.spec_from_file_location('owner_snapshot',Path(__file__).with_name('test_sunshine_macos_permissions.py'))
helper=importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
snapshot=helper.snapshot
CASES=['missing-owner','malformed-owner','different-parent','init-parent','null-input','file-input',
       'tcp-input','datagram-input','malformed-command','pipe-check','unix-stream-check','pipe-eof',
       'unexpected-input','parent-exit-pipe-held','parent-crash-pipe-held','full-host-missing-owner']


def line(stream,timeout=5):
    deadline=time.monotonic()+timeout
    value=bytearray()
    while len(value)<4096:
        remaining=deadline-time.monotonic()
        if remaining<=0 or not select.select([stream],[],[],remaining)[0]:
            raise RuntimeError('Owner diagnostic reply timeout')
        byte=stream.read(1)
        if not byte:
            raise RuntimeError('Owner diagnostic closed before its reply')
        if byte==b'\n':
            return json.loads(value)
        value.extend(byte)
    raise RuntimeError('Owner diagnostic reply exceeds its limit')


def check(engine:Path,report:Path):
    if platform.system()!='Darwin':
        raise RuntimeError('Native owner verification requires macOS')
    engine=engine.resolve(strict=True)
    protected=[Path.home()/'.config/sunshine',Path.home()/'Library/Application Support/ClipRelay/host']
    before=[snapshot(path) for path in protected]
    env=dict(os.environ)
    env.pop('CLIPRELAY_HOST_STATE_DIR',None)
    env.pop('CLIPRELAY_HOST_OWNER_PID',None)
    owned={**env,'CLIPRELAY_HOST_OWNER_PID':str(os.getpid())}
    cases=[]
    ready={'protocol':1,'ready':True}
    stopped={'protocol':1,'stopped':True}
    with tempfile.TemporaryDirectory(prefix='cliprelay-engine-owner-') as temporary:
        base=Path(temporary).resolve()
        file=base/'file';file.write_text('fixture')
        original=snapshot(base)

        def rejected(name,selected,stdin=subprocess.DEVNULL,args=None,error='invalid_owner'):
            result=subprocess.run([str(engine),*(args or ['--cliprelay-owner','check'])],env=selected,
                                  stdin=stdin,cwd=base,capture_output=True,timeout=5)
            if result.returncode!=2 or len(result.stdout)>4096 or len(result.stderr)>16384:
                raise RuntimeError('Owner rejection failed: '+name)
            if json.loads(result.stdout)!={'protocol':1,'error':error}:
                raise RuntimeError('Owner rejection reply failed: '+name)
            cases.append(name)

        rejected(CASES[0],env,error='owner_required')
        rejected(CASES[1],{**owned,'CLIPRELAY_HOST_OWNER_PID':'02345'})
        rejected(CASES[2],{**owned,'CLIPRELAY_HOST_OWNER_PID':str(os.getpid()+1)})
        rejected(CASES[3],{**owned,'CLIPRELAY_HOST_OWNER_PID':'1'})
        rejected(CASES[4],owned)
        with file.open('rb') as stream:
            rejected(CASES[5],owned,stdin=stream)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));listener.listen(1)
            with socket.create_connection(listener.getsockname()) as client:
                connection,_=listener.accept()
                with connection:
                    rejected(CASES[6],owned,stdin=client)
        first,second=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM)
        try:
            rejected(CASES[7],owned,stdin=first)
        finally:
            first.close();second.close()
        rejected(CASES[8],owned,args=['--cliprelay-owner','check','extra'],error='invalid_command')

        def controlled(name,action,finish=None,unix=False):
            pair=socket.socketpair() if unix else None
            child=subprocess.Popen([str(engine),'--cliprelay-owner',action],env=owned,cwd=base,
                                   stdin=pair[0] if pair else subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0)
            try:
                if line(child.stdout)!=ready:
                    raise RuntimeError('Owner admission failed: '+name)
                if finish:
                    if child.poll() is not None:
                        raise RuntimeError('Owner wait ended before its owner')
                    finish(child)
                    if line(child.stdout)!=stopped:
                        raise RuntimeError('Owner shutdown reply failed: '+name)
                child.wait(timeout=5)
                if child.returncode!=0 or child.stdout.read(4097) or len(child.stderr.read(16385))>16384:
                    raise RuntimeError('Owner command did not exit cleanly: '+name)
                cases.append(name)
            finally:
                if child.poll() is None:
                    child.kill();child.wait(timeout=5)
                if child.stdin:child.stdin.close()
                child.stdout.close();child.stderr.close()
                if pair:
                    pair[0].close();pair[1].close()

        controlled(CASES[9],'check')
        controlled(CASES[10],'check',unix=True)
        controlled(CASES[11],'wait',lambda child:child.stdin.close())
        controlled(CASES[12],'wait',lambda child:child.stdin.write(b'x'))

        parent_code='''import json,os,subprocess,sys
env=dict(os.environ,CLIPRELAY_HOST_OWNER_PID=str(os.getpid()))
child=subprocess.Popen([sys.argv[1],'--cliprelay-owner','wait'],stdin=int(sys.argv[2]),stdout=sys.stdout.buffer,stderr=subprocess.DEVNULL,env=env)
print(json.dumps({'child':child.pid}),flush=True)
sys.stdin.readline()
if sys.argv[3]=='crash':os._exit(73)
sys.exit(0)
'''
        for name,mode in [(CASES[13],'exit'),(CASES[14],'crash')]:
            read_fd,write_fd=os.pipe()
            parent=subprocess.Popen([sys.executable,'-c',parent_code,str(engine),str(read_fd),mode],
                                    stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                    pass_fds=(read_fd,),env=env,cwd=base,bufsize=0)
            os.close(read_fd)
            child_pid=None
            try:
                replies=[line(parent.stdout),line(parent.stdout)]
                if ready not in replies:
                    raise RuntimeError('Grandchild owner admission failed')
                child_pid=next(value['child'] for value in replies if set(value)=={'child'})
                if type(child_pid) is not int or child_pid<=1:
                    raise RuntimeError('Invalid fixture child PID')
                parent.stdin.write(b'exit\n');parent.stdin.close()
                parent.wait(timeout=5)
                if parent.returncode!=(73 if mode=='crash' else 0) or line(parent.stdout)!=stopped:
                    raise RuntimeError('Parent loss was hidden by a pipe held open elsewhere')
                deadline=time.monotonic()+5
                while time.monotonic()<deadline:
                    state=subprocess.run(['ps','-p',str(child_pid),'-o','stat='],capture_output=True,timeout=2)
                    if state.returncode!=0:break
                    time.sleep(0.05)
                else:raise RuntimeError('Owned grandchild was not reaped')
                cases.append(name)
            finally:
                os.close(write_fd)
                if parent.poll() is None:
                    parent.kill();parent.wait(timeout=5)
                if child_pid:
                    running=subprocess.run(['ps','-p',str(child_pid),'-o','command='],capture_output=True,text=True,timeout=2)
                    if running.returncode==0 and running.stdout.strip()==str(engine)+' --cliprelay-owner wait':
                        try:os.kill(child_pid,signal.SIGKILL)
                        except ProcessLookupError:pass
                if parent.stdin and not parent.stdin.closed:parent.stdin.close()
                parent.stdout.close();parent.stderr.close()

        if snapshot(base)!=original:
            raise RuntimeError('Owner diagnostics wrote configuration or logs')
        private=base/'private';private.mkdir(mode=0o700);private.chmod(0o700)
        result=subprocess.run([str(engine)],env={**env,'CLIPRELAY_HOST_STATE_DIR':str(private)},
                              stdin=subprocess.DEVNULL,cwd=base,capture_output=True,timeout=5)
        if result.returncode!=2 or len(result.stdout)>65536 or len(result.stderr)>16384:
            raise RuntimeError('Actual host startup did not reject missing owner before platform initialization')
        cases.append(CASES[15])
        if [snapshot(path) for path in protected]!=before:
            raise RuntimeError('Owner tests changed default application state')
    result={'protocol':1,'passed':True,'cases':cases,'defaultStateUnchanged':True,'homeChanged':False,
            'nativeRequestsExecuted':False,'hostStarted':False,'ownedChildrenReaped':True,
            'scope':'Actual signed-engine owner admission, pipe EOF, unexpected input, parent exit/crash with held pipe, and rejected full startup. Only disposable test TCP/Unix sockets; no host listeners or capture.'}
    report.write_text(json.dumps(result,indent=2)+'\n')
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine',type=Path,required=True)
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    print(json.dumps(check(args.engine,args.report)))
