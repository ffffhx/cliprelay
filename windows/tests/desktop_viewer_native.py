"""Run the packaged Qt viewer against an isolated input-disabled loopback host.

No production installation, physical input, audio recording or frame recording.
The visible stream window lasts a few seconds. Only counters and diagnostics
are retained; temporary client/server private keys are removed on every exit.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import struct
import subprocess
import time
import urllib.request
from engine_control_test import POWERSHELL, choose_port, powershell, prepare_client, quote


def run(engine: Path, viewer: Path, output: Path):
    engine=engine.resolve(strict=True);viewer=viewer.resolve(strict=True)
    fixture=output.resolve()/secrets.token_hex(12);fixture.mkdir(parents=True,exist_ok=False)
    owner=prepare_client(fixture)
    port=choose_port();password=secrets.token_hex(32);salt=secrets.token_hex(8)
    config=fixture/'sunshine.conf';executable=engine/'sunshine.exe';process=None
    (fixture/'credentials.json').write_text(json.dumps({'username':'cliprelay-test','salt':salt,'password':hashlib.sha256((password+salt).encode()).digest()[::-1].hex().upper()}))
    (fixture/'apps.json').write_text(json.dumps({'env':{},'apps':[{'name':'Desktop','image-path':'desktop.png'}]}))
    options={'sunshine_name':'ClipRelay isolated desktop viewer','port':port,'bind_address':'127.0.0.1','address_family':'ipv4','origin_web_ui_allowed':'pc','system_tray':'disabled','upnp':'disabled','controller':'disabled','mouse':'disabled','keyboard':'disabled','stream_audio':'disabled','min_log_level':2,'dd_configuration_option':'disabled','file_apps':(fixture/'apps.json').as_posix(),'file_state':(fixture/'clients.json').as_posix(),'credentials_file':(fixture/'credentials.json').as_posix(),'pkey':(fixture/'cakey.pem').as_posix(),'cert':(fixture/'cacert.pem').as_posix(),'log_path':(fixture/'engine.log').as_posix()}
    config.write_text(''.join(f'{key} = {value}\n' for key,value in options.items()),encoding='utf-8')
    helper=f'''$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = {quote(str(executable))}
$start.Arguments = {quote(subprocess.list2cmdline([str(config)]))}
$start.WorkingDirectory = {quote(str(engine))}
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
[void][System.Diagnostics.Process]::Start($start)
'''
    encoded=base64.b64encode(helper.encode('utf-16le')).decode('ascii')
    report={'fixture':str(fixture),'engineSha256':hashlib.sha256(executable.read_bytes()).hexdigest(),'viewerSha256':hashlib.sha256(viewer.read_bytes()).hexdigest(),'inputDisabled':True,'audioDisabled':True,'passed':False}
    try:
        powershell(f'''$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = 0
$command = {quote(POWERSHELL+' -NoProfile -STA -WindowStyle Hidden -EncodedCommand '+encoded)}
$result = ([wmiclass]'Win32_Process').Create($command, {quote(str(engine))}, $startup)
if ($result.ReturnValue -ne 0) {{ throw 'Fixture launch failed' }}''')
        deadline=time.monotonic()+40
        while time.monotonic()<deadline:
            if (fixture/'cacert.pem').exists():
                try:
                    with socket.create_connection(('127.0.0.1',port+1),timeout=.2):break
                except OSError:pass
            time.sleep(.1)
        else:raise RuntimeError('Isolated engine failed to start')
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT);context.check_hostname=False;context.load_verify_locations(str(fixture/'cacert.pem'))
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=context))
        def state():
            request=urllib.request.Request(f'https://127.0.0.1:{port+1}/api/cliprelay/displays',headers={'Authorization':'Basic '+base64.b64encode(('cliprelay-test:'+password).encode()).decode()})
            with opener.open(request,timeout=4) as response:return json.loads(response.read(65536))
        assert state()['phase']=='idle'
        value={'version':1,'address':'127.0.0.1','port':port,'clientId':secrets.token_hex(16),'certificate':(fixture/'client.pem').read_text(),'privateKey':(fixture/'client-key.pem').read_text(),'hostCertificate':(fixture/'cacert.pem').read_text(),'width':1280,'height':720,'fps':30,'bitrate':6000,'fullscreen':False}
        data=json.dumps(value).encode();env=os.environ.copy();env['TEMP']=str(fixture);env['TMP']=str(fixture)
        for key in ['ELECTRON_RUN_AS_NODE','CHROME_CRASHPAD_PIPE_NAME','QT_QPA_PLATFORM','QT_PLUGIN_PATH','QML2_IMPORT_PATH']:env.pop(key,None)
        log=(fixture/'viewer.log').open('wb')
        try:
            process=subprocess.Popen([str(viewer),'--cliprelay-session'],cwd=viewer.parent,stdin=subprocess.PIPE,stdout=log,stderr=subprocess.STDOUT,env=env,creationflags=subprocess.CREATE_NO_WINDOW)
            process.stdin.write(struct.pack('>I',len(data))+data);process.stdin.flush()
            del value,data
            deadline=time.monotonic()+45
            while time.monotonic()<deadline:
                if process.poll() is not None:raise RuntimeError('Viewer exited before streaming; inspect viewer.log')
                current=state()
                if current['phase']=='active' and current['capture'] and len(current['streams'])==1:break
                time.sleep(.2)
            else:raise RuntimeError('Viewer never established a video stream; inspect viewer.log')
            report['activeStreamObserved']=True
            time.sleep(5)
            closing=time.monotonic();process.stdin.close();process.stdin=None
            code=process.wait(timeout=12)
            report['parentCloseToExitMs']=round((time.monotonic()-closing)*1000);report['exitCode']=code
            if code!=0:raise RuntimeError('Viewer did not exit normally on parent-pipe closure')
            deadline=time.monotonic()+8
            while time.monotonic()<deadline:
                current=state()
                if not current['streams']:break
                time.sleep(.1)
            else:raise RuntimeError('Host still has a stream after viewer exit')
            report['hostStreamReleased']=True
        finally:log.close()
        text=(fixture/'viewer.log').read_text(encoding='utf-8',errors='replace')
        rates=re.findall(r'Rendering frame rate: ([0-9.]+) FPS',text)
        decoded=re.findall(r'Decoding frame rate: ([0-9.]+) FPS',text)
        if not rates or not decoded or max(map(float,rates))<5:raise RuntimeError('No positive render statistics; inspect viewer.log')
        report['renderedFps']=max(map(float,rates));report['decodedFps']=max(map(float,decoded))
        if 'BEGIN PRIVATE KEY' in text or 'BEGIN RSA PRIVATE KEY' in text:raise RuntimeError('Credentials appeared in diagnostics')
        report['passed']=True
    except Exception as error:
        report['error']=str(error)
        raise
    finally:
        if process and process.poll() is None:
            if process.stdin:process.stdin.close()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        powershell(f'''$engine = {quote(str(executable))}
$config = {quote(str(config))}
$matches = @(Get-CimInstance Win32_Process -Filter "Name = 'sunshine.exe'" | Where-Object {{ $_.ExecutablePath -eq $engine -and $_.CommandLine -and $_.CommandLine.IndexOf($config, [StringComparison]::OrdinalIgnoreCase) -ge 0 }})
foreach ($process in $matches) {{ Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }}''')
        for name in ['client-key.pem','cakey.pem','credentials.json']:(fixture/name).unlink(missing_ok=True)
        (fixture/'report.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('engine',type=Path);parser.add_argument('viewer',type=Path);parser.add_argument('--output',type=Path,default=Path('.tools/desktop-viewer-tests'))
    args=parser.parse_args();run(args.engine,args.viewer,args.output)
