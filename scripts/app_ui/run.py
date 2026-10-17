"""Observe unchanged full-app UI through normal owned menu actions and CDP."""
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

assert sys.platform=='darwin' and os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('GITHUB_REPOSITORY')=='ffffhx/cliprelay'
root=Path(__file__).resolve().parents[2];runner=Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
app=Path(os.environ['CLIPRELAY_COMPLETE_APP']).resolve(strict=True)
assert app.parent.parent==runner and app.parent.name.startswith('cliprelay-complete-app-')
selection=json.loads(Path(os.environ['CLIPRELAY_COMPLETE_APP_RECEIPT']).read_bytes())
assert selection['directory']==str(app) and selection['testCommit']==os.environ['GITHUB_SHA']
def sha(file):return hashlib.sha256(Path(file).read_bytes()).hexdigest()
assert sha(app/'Contents/MacOS/ClipRelay')==selection['executableSha256']
directory=Path(tempfile.mkdtemp(prefix='cliprelay-app-ui-',dir=runner))
helper=directory/'owned-app'
subprocess.run(['clang++','-std=c++17','-fobjc-arc','-Wall','-Wextra','-Werror','-mmacosx-version-min=14.2',
                str(Path(__file__).with_name('owned_app.mm')),'-framework','Foundation','-framework','AppKit',
                '-framework','ApplicationServices','-lproc','-o',str(helper)],check=True)
browser=root/'scripts/app_ui/node_modules/agent-browser/bin/agent-browser-darwin-x64'
assert browser.is_file() and browser.resolve()==browser
browser.chmod(0o700)
env={name:os.environ[name] for name in ['PATH','HOME','TMPDIR','RUNNER_TEMP','GITHUB_ACTIONS','GITHUB_REPOSITORY'] if name in os.environ}
assert subprocess.check_output([str(browser),'--version'],env=env,text=True,timeout=5).strip()=='agent-browser 0.34.0'
name='cliprelay-app-ui-'+os.environ['GITHUB_RUN_ID'];namespace=name+'-'+os.environ['GITHUB_RUN_ATTEMPT']
config=Path.home()/'Library/Application Support/ClipRelay'
assert not config.exists() and not config.is_symlink(), 'DEFAULT_PROFILE_ALREADY_EXISTS'
with socket.socket() as reservation:
    reservation.bind(('127.0.0.1',0));port=reservation.getsockname()[1]
events=queue.Queue();all_events=[];child=None;browser_connected=False;stage='launch';failure=None
result={'protocol':1,'testCommit':os.environ['GITHUB_SHA'],'run':int(os.environ['GITHUB_RUN_ID']),'architecture':'x64','passed':False,
        'discoveryOnly':True,'productionAudioVerified':False,'permissionGrantedByFixture':False,'keychainVerified':False,
        'application':selection,'cases':[],'snapshots':{},'helperSha256':sha(helper),'agentBrowserSha256':sha(browser),
        'agentBrowserVersion':'0.34.0','sources':{str(file.relative_to(root)).replace('\\','/'):sha(file) for file in
        [Path(__file__),Path(__file__).with_name('owned_app.mm'),Path(__file__).with_name('fetch.py'),Path(__file__).with_name('package.json'),
         Path(__file__).with_name('package-lock.json'),Path(__file__).with_name('application.json'),root/'.github/workflows/macos-app-ui.yml']}}
def read_stdout():
    try:
        for line in child.stdout:
            assert len(line)<32768 and len(all_events)<100
            value=json.loads(line);all_events.append(value);events.put(value)
    except Exception:events.put({'event':'error','code':'HELPER_OUTPUT_INVALID'})
def event(kind,timeout=10):
    value=events.get(timeout=timeout)
    assert value.get('event')==kind, 'HELPER_EVENT_FAILED'
    return value
def command(name):
    assert child.poll() is None
    child.stdin.write(name+'\n');child.stdin.flush();return event('ui',8)
def browser_command(*args):
    call=subprocess.run([str(browser),'--namespace',namespace,'--session',name,'--json',*args],env=env,
                        capture_output=True,text=True,timeout=30)
    assert len(call.stdout)<65536 and len(call.stderr)<65536, 'BROWSER_OUTPUT_LIMIT'
    assert call.returncode==0, 'BROWSER_COMMAND_FAILED'
    value=json.loads(call.stdout);assert value.get('success') is True, 'BROWSER_COMMAND_FAILED'
    return value
def target(kind):
    deadline=time.monotonic()+10
    expected=(app/'Contents/Resources/app/mac/ui.html').as_uri()+'?kind='+kind
    while time.monotonic()<deadline:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list',timeout=2) as response:
            raw=response.read(65537);assert len(raw)<65537
            pages=json.loads(raw)
        if any(page.get('type')=='page' and page.get('url')==expected for page in pages):return expected
        time.sleep(.1)
    raise RuntimeError('APP_WINDOW_MISSING')
def snapshot(kind):
    target(kind);browser_command('tab','--url','*kind='+kind)
    value=browser_command('snapshot')
    result['snapshots'][kind]=value
    return json.dumps(value,ensure_ascii=False)
try:
    child=subprocess.Popen([str(helper),str(app),str(port)],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                           text=True,bufsize=1)
    threading.Thread(target=read_stdout,daemon=True).start()
    ready=event('ready',20);assert ready['owned'] is True and ready['launchedThroughNSWorkspace'] is True
    assert ready['parentPid']!=child.pid and ready['bundleIdentifier']=='com.cliprelay.desktop'
    result['launch']=ready;result['cases'].append('unchanged-complete-app-launched-through-NSWorkspace')
    stage='inspect-menu';result['initialMenu']=command('inspect')
    stage='open-menu';opened=command('menu');result['openMenu']=opened;assert opened['pressed'] is True
    stage='open-host';opened=command('host');result['openHost']=opened;assert opened['pressed'] is True
    target('host')
    stage='connect-owned-renderer';browser_command('connect',str(port));browser_connected=True
    stage='host-window';text=snapshot('host');assert '启动远程访问' in text and '检查系统权限' in text
    result['cases'].append('native-menu-opens-production-host-renderer')
    stage='read-permissions';browser_command('find','role','button','click','--name','检查系统权限')
    snapshot('host-permissions')
    browser_command('wait','--text','已读取当前系统状态')
    text=snapshot('host-permissions');assert '屏幕录制' in text and '键鼠控制' in text
    result['cases'].append('production-renderer-opens-read-only-system-permission-check')
    settings=json.loads((config/'config.json').read_bytes());assert settings['hostAutoStart'] is False and settings['legacyEnabled'] is False
    result['defaultHostAndLegacyRemainOff']=True
    assert sha(app/'Contents/MacOS/ClipRelay')==selection['executableSha256']
    assert sha(app/'Contents/Info.plist')==selection['infoSha256']
    assert sha(app/'Contents/Resources/app/main.js')==selection['entrySha256']
    for source,digest in selection['sources'].items():assert sha(app/'Contents/Resources/app/mac'/Path(source).name)==digest
    result['applicationUnchanged']=True
except Exception as error:
    failure=error
    result['failure']={'stage':stage,'code':str(error) if re.fullmatch('[A-Z_]{1,80}',str(error)) else type(error).__name__}
    if browser_connected:
        try:result['snapshots']['failure']=browser_command('snapshot')
        except Exception:pass
finally:
    cleanup=[]
    if child:
        try:
            if child.poll() is None:child.stdin.close()
            child.wait(timeout=15)
            closed=next((v for v in reversed(all_events) if v.get('event')=='closed'),None)
            assert child.returncode==0 and closed=={'event':'closed','terminated':True,'forced':False}
            result['appClosed']=closed;result['helperExit']=child.returncode
        except Exception:cleanup.append('owned-app-close')
    if browser_connected:
        try:browser_command('close');result['browserSessionClosed']=True
        except Exception:cleanup.append('browser-session')
    with socket.socket() as probe:
        probe.settimeout(1);result['debugPortClosed']=probe.connect_ex(('127.0.0.1',port))!=0
    if not result['debugPortClosed']:cleanup.append('debug-port')
    if config.exists() and not cleanup:
        assert config.resolve()==config and config.parent==(Path.home()/'Library/Application Support').resolve()
        shutil.rmtree(config);result['ownedProfileRemoved']=not config.exists()
    if cleanup:result['cleanupErrors']=cleanup
    result['helperEvents']=all_events
    result['passed']=failure is None and not cleanup
    if result['passed']:result['cases'].append('normal-application-quit-and-owned-profile-cleanup')
    report=root/'macos-app-ui.json';report.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'passed':result['passed'],'stage':stage,'cases':result['cases'],'cleanupErrors':cleanup}))
if not result['passed']:sys.exit(1)
