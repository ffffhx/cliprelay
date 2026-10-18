"""Verify the Mac pairing client against an isolated, input-disabled Sunshine engine."""
import argparse, base64, hashlib, json, secrets, socket, subprocess, time
from pathlib import Path
from engine_control_test import POWERSHELL, powershell, quote, choose_port

def run(engine: Path, output: Path):
    engine=engine.resolve(strict=True); executable=engine/'sunshine.exe'
    if not executable.is_file(): raise RuntimeError('Missing isolated engine')
    fixture=output.resolve()/secrets.token_hex(12);fixture.mkdir(parents=True,exist_ok=False)
    config=fixture/'sunshine.conf';port=choose_port();password=secrets.token_hex(32);salt=secrets.token_hex(8)
    (fixture/'credentials.json').write_text(json.dumps({'username':'cliprelay-test','salt':salt,'password':hashlib.sha256((password+salt).encode()).digest()[::-1].hex().upper()}),encoding='utf-8')
    (fixture/'apps.json').write_text('{"env":{},"apps":[]}',encoding='utf-8')
    options={'sunshine_name':'ClipRelay Mac pairing fixture','port':port,'bind_address':'127.0.0.1','address_family':'ipv4','origin_web_ui_allowed':'pc','system_tray':'disabled','upnp':'disabled','controller':'disabled','mouse':'disabled','keyboard':'disabled','stream_audio':'disabled','min_log_level':2,'dd_configuration_option':'disabled','file_apps':(fixture/'apps.json').as_posix(),'file_state':(fixture/'clients.json').as_posix(),'credentials_file':(fixture/'credentials.json').as_posix(),'pkey':(fixture/'cakey.pem').as_posix(),'cert':(fixture/'cacert.pem').as_posix(),'log_path':(fixture/'engine.log').as_posix()}
    config.write_text(''.join(f'{key} = {value}\n' for key,value in options.items()),encoding='utf-8')
    helper=f'''$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = {quote(str(executable))}
$start.Arguments = {quote(chr(34)+str(config)+chr(34))}
$start.WorkingDirectory = {quote(str(engine))}
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
[void][System.Diagnostics.Process]::Start($start)
'''
    encoded=base64.b64encode(helper.encode('utf-16le')).decode('ascii')
    report={'fixture':str(fixture),'engine':str(executable),'engineSha256':hashlib.sha256(executable.read_bytes()).hexdigest().upper(),'passed':False}
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
            time.sleep(.15)
        else:raise RuntimeError('Fixture engine did not listen')
        data={'address':'127.0.0.1','port':port,'password':password,'cert':str(fixture/'cacert.pem'),'key':str(fixture/'cakey.pem'),'state':str(fixture/'clients.json')}
        result=subprocess.run(['node',str(Path(__file__).with_name('mac-sunshine-pairing.cjs'))],input=json.dumps(data),text=True,encoding='utf-8',capture_output=True,timeout=155,creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:raise RuntimeError('Mac handshake failed: '+result.stderr[:500])
        report.update(json.loads(result.stdout))
    except Exception as error:
        report['error']=str(error);raise
    finally:
        powershell(f'''$engine = {quote(str(executable))}
$config = {quote(str(config))}
$matches = @(Get-CimInstance Win32_Process -Filter "Name = 'sunshine.exe'" | Where-Object {{ $_.ExecutablePath -eq $engine -and $_.CommandLine -and $_.CommandLine.IndexOf($config, [StringComparison]::OrdinalIgnoreCase) -ge 0 }})
foreach ($process in $matches) {{ Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }}''')
        for name in ('cakey.pem','credentials.json'):(fixture/name).unlink(missing_ok=True)
        (fixture/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps(report))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('engine',type=Path);parser.add_argument('--output',type=Path,default=Path('.tools/mac-pairing-tests'));args=parser.parse_args();run(args.engine,args.output)
