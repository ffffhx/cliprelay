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
import queue
from pathlib import Path
import re
import secrets
import shutil
import socket
import ssl
import struct
import subprocess
import threading
import time
import urllib.request
from engine_control_test import POWERSHELL, choose_port, powershell, prepare_client, quote


def run(engine: Path, viewer: Path, output: Path, overlay_fixture: Path = None, recovery=False, telemetry=False, control_fixture: Path = None):
    if recovery and not overlay_fixture:raise ValueError('Recovery acceptance requires the isolated overlay fixture')
    if control_fixture and (overlay_fixture or not telemetry):raise ValueError('Live bitrate fixture requires direct telemetry mode')
    engine=engine.resolve(strict=True);viewer=viewer.resolve(strict=True)
    fixture=output.resolve()/secrets.token_hex(12);fixture.mkdir(parents=True,exist_ok=False)
    owner=prepare_client(fixture)
    port=choose_port();password=secrets.token_hex(32);salt=secrets.token_hex(8)
    config=fixture/'sunshine.conf';executable=engine/'sunshine.exe';process=None;network=None;network_log=None;network_reader=None;control=None;control_log=None
    username='cliprelay' if control_fixture else 'cliprelay-test'
    (fixture/'credentials.json').write_text(json.dumps({'username':username,'salt':salt,'password':hashlib.sha256((password+salt).encode()).digest()[::-1].hex().upper()}))
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
    def start_network():
        nonlocal network,network_log,network_reader
        bridge=overlay_fixture.resolve(strict=True)
        network_log=(fixture/'network.log').open('ab')
        network=subprocess.Popen([str(bridge),'-test.run=^TestDesktopViewerNetworkFixture$','-test.timeout=120s'],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=network_log,
            env={**os.environ,'CLIPRELAY_TEST_ENGINE_PORT':str(port),'TEMP':str(fixture),'TMP':str(fixture)},creationflags=subprocess.CREATE_NO_WINDOW)
        messages=queue.Queue()
        def capture_network():
            for line in network.stdout:
                network_log.write(line);network_log.flush()
                if line.startswith(b'{'):
                    try:messages.put(json.loads(line))
                    except ValueError:pass
        network_reader=threading.Thread(target=capture_network,daemon=True);network_reader.start()
        metadata=messages.get(timeout=40)
        assert metadata['type']=='fixture-ready'
        initialization={'version':1,'controlUrl':metadata['controlUrl'],'hostname':'cr-012345678901234567890123','authKey':'','peerIP':metadata['peerIP']}
        network.stdin.write(json.dumps(initialization).encode()+b'\n');network.stdin.flush()
        deadline=time.monotonic()+45
        while time.monotonic()<deadline:
            try:status=messages.get(timeout=1)
            except queue.Empty:
                if network.poll() is not None:raise RuntimeError('Embedded network fixture exited; inspect network.log')
                continue
            if status.get('ready'):return status['port'],messages
        raise RuntimeError('Embedded network route did not become ready')
    def stop_network():
        if network and network.poll() is None:
            network.stdin.close();network.stdin=None
            assert network.wait(timeout=12)==0
        if network_reader:network_reader.join(timeout=2)
        if network and network.stdout:network.stdout.close()
        if network_log:network_log.close()
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
            request=urllib.request.Request(f'https://127.0.0.1:{port+1}/api/cliprelay/displays',headers={'Authorization':'Basic '+base64.b64encode((username+':'+password).encode()).decode()})
            with opener.open(request,timeout=4) as response:return json.loads(response.read(65536))
        assert state()['phase']=='idle'
        if control_fixture:
            control_log=(fixture/'control.log').open('wb')
            control=subprocess.Popen([str(control_fixture.resolve(strict=True)),'-test.run=^TestDesktopBitrateNativeFixture$','-test.timeout=100s'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=control_log,
                env={**os.environ,'CLIPRELAY_DESKTOP_BITRATE_FIXTURE':'1'},creationflags=subprocess.CREATE_NO_WINDOW)
            control.stdin.write(json.dumps({'directory':str(fixture),'password':password,'port':port}).encode()+b'\n');control.stdin.flush()
            ready=queue.Queue()
            def capture_control():
                for line in control.stdout:
                    control_log.write(line);control_log.flush()
                    if line.startswith(b'{'):ready.put(json.loads(line))
            control_reader=threading.Thread(target=capture_control,daemon=True);control_reader.start()
            assert ready.get(timeout=10)['type']=='control-ready'
        local_port=port
        if overlay_fixture:
            local_port,messages=start_network()
            report['overlay']={'fixtureSha256':hashlib.sha256(overlay_fixture.read_bytes()).hexdigest(),'localPort':local_port,'advertisedHostPort':port,'core':'production desktopclient.Run and mobile.Node; isolated coordination and reverse host bridge'}
        value={'version':1,'address':'127.0.0.1','port':local_port,'clientId':secrets.token_hex(16),'certificate':(fixture/'client.pem').read_text(),'privateKey':(fixture/'client-key.pem').read_text(),'hostCertificate':(fixture/'cacert.pem').read_text(),'width':1280,'height':720,'fps':30,'bitrate':6000,'fullscreen':False}
        if overlay_fixture:value.update(overlay=True,overlayPort=port)
        if control_fixture:value['bitrateTest']=True
        data=json.dumps(value).encode();env=os.environ.copy();env['TEMP']=str(fixture);env['TMP']=str(fixture)
        for key in ['ELECTRON_RUN_AS_NODE','CHROME_CRASHPAD_PIPE_NAME','QT_QPA_PLATFORM','QT_PLUGIN_PATH','QML2_IMPORT_PATH']:env.pop(key,None)
        log=(fixture/'viewer.log').open('wb')
        try:
            if recovery or telemetry:
                process=subprocess.Popen(['node',str(Path(__file__).with_name('desktop-viewer-recovery-native.cjs')),str(viewer.parent.parent),str(fixture)],
                    stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,env=env,creationflags=subprocess.CREATE_NO_WINDOW)
                events=queue.Queue();history=[]
                def capture_viewer():
                    for line in process.stdout:
                        event=json.loads(line);history.append(event);events.put(event)
                viewer_reader=threading.Thread(target=capture_viewer,daemon=True);viewer_reader.start()
                process.stdin.write(data+b'\n')
            else:
                process=subprocess.Popen([str(viewer),'--cliprelay-session'],cwd=viewer.parent,stdin=subprocess.PIPE,stdout=log,stderr=subprocess.STDOUT,env=env,creationflags=subprocess.CREATE_NO_WINDOW)
                process.stdin.write(struct.pack('>I',len(data))+data)
            process.stdin.flush()
            del value,data
            deadline=time.monotonic()+45
            while time.monotonic()<deadline:
                if process.poll() is not None:
                    report['exitCode']=process.returncode
                    raise RuntimeError('Viewer exited before streaming; inspect viewer.log')
                current=state()
                if current['phase']=='active' and current['capture'] and len(current['streams'])==1:break
                time.sleep(.2)
            else:raise RuntimeError('Viewer never established a video stream; inspect viewer.log')
            report['activeStreamObserved']=True
            time.sleep(5)
            if telemetry:
                progress=[item['progress'] for item in history if item.get('type')=='state' and item.get('progress')]
                assert len(progress)>=5,'Native progress reports missing'
                visible=[item for item in progress if item['rendered']>0]
                assert len(visible)>=3 and visible[-1]['rendered']>visible[0]['rendered'],'Presented frames must advance'
                assert all(0<item['rendered']<=item['received'] and item['width']==1280 and item['height']==720 for item in visible)
                assert visible[-1]['rendered']>=current['streams'][0]['firstFrame']>0,'Native boundary must match the active host stream'
                assert visible[-1]['renderedAgeMs']<2000,'Presentation feedback is stale'
                report['presentation']={'reports':len(progress),'first':visible[0],'last':visible[-1],
                    'hostFirstFrame':current['streams'][0]['firstFrame'],'mode':'native successful present submission; physical panel not measured'}
            if control_fixture:
                def bitrate_state():
                    return next((entry for entry in reversed(history) if entry.get('type')=='bitrate'),{})
                report['bitrate']=[]
                binding=(current['instance'],current['streams'][0]['id'],current['generation'])
                for budget in [12000,2000,6000]:
                    deadline=time.monotonic()+12
                    while time.monotonic()<deadline and not bitrate_state().get('canApply'):time.sleep(.1)
                    assert bitrate_state().get('canApply'),bitrate_state()
                    started=time.monotonic();process.stdin.write(json.dumps({'action':'bitrate','budgetKbps':budget}).encode()+b'\n');process.stdin.flush()
                    deadline=started+18
                    while time.monotonic()<deadline:
                        rate=bitrate_state()
                        if rate.get('result',{} ) and rate['result'].get('budgetKbps')==budget and rate['result'].get('kind')=='applied':break
                        if process.poll() is not None:raise RuntimeError('Bitrate owner exited')
                        time.sleep(.05)
                    else:raise RuntimeError('Bitrate was not confirmed: '+json.dumps(bitrate_state()))
                    current=state();assert (current['instance'],current['streams'][0]['id'],current['generation'])==binding
                    assert len([item for item in history if item.get('type')=='spawn'])==1,'Live rate adjustment restarted the viewer'
                    report['bitrate'].append({'budgetKbps':budget,'videoKbps':rate['videoKbps'],'confirmationMs':round((time.monotonic()-started)*1000),'sameStream':True})
            if recovery:
                stop_network()
                deadline=time.monotonic()+30
                while time.monotonic()<deadline:
                    try:event=events.get(timeout=1)
                    except queue.Empty:continue
                    if event.get('type')=='native' and event.get('event')=='ended' and event.get('reason')=='network':break
                    if event.get('type')=='failure':raise RuntimeError('Recovery owner failed')
                else:raise RuntimeError('Real outage was not classified as a recoverable network failure')
                process.stdin.write(b'{"action":"route","ready":false}\n');process.stdin.flush()
                local_port,messages=start_network()
                process.stdin.write(json.dumps({'action':'route','ready':True,'port':local_port,'id':'replacement'}).encode()+b'\n');process.stdin.flush()
                deadline=time.monotonic()+45
                while time.monotonic()<deadline:
                    if process.poll() is not None:raise RuntimeError('Recovery owner exited')
                    native=[item for item in history if item.get('type')=='native' and item.get('event')=='connected']
                    if len(native)>=2 and state()['phase']=='active':break
                    time.sleep(.2)
                else:raise RuntimeError('Replacement route did not recover real video')
                time.sleep(5)
                report['recovery']={'newPort':local_port,'lifecycle':history,'realNetworkFailure':True}
                ready_event=next(item for item in reversed(history) if item.get('type')=='route' and item.get('ready'))
                report['recovery']['routeReadyToConnectedMs']=native[-1]['atMs']-ready_event['atMs']
                process.stdin.write(b'{"action":"stop"}\n');process.stdin.flush()
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
        if recovery or telemetry:
            viewer_reader.join(timeout=2)
            process.stdout.close()
            logs=[file.read_text(encoding='utf-8',errors='replace') for file in sorted(fixture.glob('attempt-*.log'))]
            if recovery:
                report['recovery']['renderedAttempts']=[max(map(float,re.findall(r'Rendering frame rate: ([0-9.]+) FPS',text)),default=0) for text in logs]
                assert sum(rate>5 for rate in report['recovery']['renderedAttempts'])>=2, 'Both original and recovered video must render frames'
            text='\n'.join(logs)
        else:text=(fixture/'viewer.log').read_text(encoding='utf-8',errors='replace')
        rates=re.findall(r'Rendering frame rate: ([0-9.]+) FPS',text)
        decoded=re.findall(r'Decoding frame rate: ([0-9.]+) FPS',text)
        if not rates or not decoded or max(map(float,rates))<5:raise RuntimeError('No positive render statistics; inspect viewer.log')
        report['renderedFps']=max(map(float,rates));report['decodedFps']=max(map(float,decoded))
        if overlay_fixture:
            assert 'ClipRelay embedded network: 1024-byte remote packets' in text
            report['overlay']['remotePacketSize']=1024
            network.stdin.write(b'{"action":"status"}\n');network.stdin.flush()
            status=messages.get(timeout=5)
            assert status.get('ready')
            report['overlay']['path']=status['path']
            network.stdin.close();network.stdin=None
            report['overlay']['exitCode']=network.wait(timeout=10)
            assert network.returncode==0
        if 'BEGIN PRIVATE KEY' in text or 'BEGIN RSA PRIVATE KEY' in text:raise RuntimeError('Credentials appeared in diagnostics')
        report['passed']=True
    except Exception as error:
        report['error']=str(error)
        if (recovery or telemetry) and 'history' in locals():report['supervisorEvents']=history
        raise
    finally:
        if process and process.poll() is None:
            if process.stdin:process.stdin.close()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        if network:
            if network.poll() is None:
                if network.stdin:network.stdin.close()
                try:network.wait(timeout=10)
                except subprocess.TimeoutExpired:network.kill();network.wait(timeout=5)
            if network_reader:network_reader.join(timeout=2)
            if network.stdout:network.stdout.close()
        if network_log:network_log.close()
        if control:
            if control.poll() is None:
                control.stdin.close()
                try:control.wait(timeout=5)
                except subprocess.TimeoutExpired:control.kill();control.wait(timeout=5)
            if 'control_reader' in locals():control_reader.join(timeout=2)
            if control.stdout:control.stdout.close()
        if control_log:control_log.close()
        for directory in fixture.glob('TestDesktopViewerNetworkFixture*'):
            resolved=directory.resolve()
            if directory.is_symlink() or not resolved.is_relative_to(fixture) or not directory.is_dir():
                raise RuntimeError('Unexpected network fixture cleanup target')
            shutil.rmtree(resolved)
        powershell(f'''$engine = {quote(str(executable))}
$config = {quote(str(config))}
$matches = @(Get-CimInstance Win32_Process -Filter "Name = 'sunshine.exe'" | Where-Object {{ $_.ExecutablePath -eq $engine -and $_.CommandLine -and $_.CommandLine.IndexOf($config, [StringComparison]::OrdinalIgnoreCase) -ge 0 }})
foreach ($process in $matches) {{ Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }}''')
        for name in ['client-key.pem','cakey.pem','credentials.json']:(fixture/name).unlink(missing_ok=True)
        (fixture/'report.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('engine',type=Path);parser.add_argument('viewer',type=Path);parser.add_argument('--output',type=Path,default=Path('.tools/desktop-viewer-tests'))
    parser.add_argument('--overlay-fixture',type=Path)
    parser.add_argument('--recovery',action='store_true')
    parser.add_argument('--telemetry',action='store_true')
    parser.add_argument('--control-fixture',type=Path)
    args=parser.parse_args();run(args.engine,args.viewer,args.output,args.overlay_fixture,args.recovery,args.telemetry,args.control_fixture)
