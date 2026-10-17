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
from permission_prompt import permission_prompt,settings_window

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
name='ui';namespace='crui-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']
permission_probe=os.environ.get('CLIPRELAY_PERMISSION_PROBE','none')
assert permission_probe in ['none','screen','input','screen-settings','screen-grant','input-settings','input-grant']
grant_permission=permission_probe.endswith('-grant')
open_permission_settings=permission_probe.endswith('-settings') or grant_permission
if open_permission_settings:permission_probe=permission_probe.split('-')[0]
config=Path.home()/'Library/Application Support/ClipRelay'
assert not config.exists() and not config.is_symlink(), 'DEFAULT_PROFILE_ALREADY_EXISTS'
with socket.socket() as reservation:
    reservation.bind(('127.0.0.1',0));port=reservation.getsockname()[1]
events=queue.Queue();all_events=[];child=None;browser_connected=False;stage='launch';failure=None
result={'protocol':1,'testCommit':os.environ['GITHUB_SHA'],'run':int(os.environ['GITHUB_RUN_ID']),'architecture':'x64','passed':False,
        'discoveryOnly':not grant_permission,'productionAudioVerified':False,'permissionGrantedByFixture':False,'keychainVerified':False,
        'permissionGrantRequested':grant_permission,
        'permissionProbe':permission_probe,'permissionRequestedByFixture':permission_probe!='none',
        'systemSettingsRequested':open_permission_settings,
        'settingsOpenedDirectly':open_permission_settings,
        'application':selection,'cases':[],'snapshots':{},'helperSha256':sha(helper),'agentBrowserSha256':sha(browser),
        'agentBrowserVersion':'0.34.0','sources':{str(file.relative_to(root)).replace('\\','/'):sha(file) for file in
        [Path(__file__),Path(__file__).with_name('owned_app.mm'),Path(__file__).with_name('fetch.py'),Path(__file__).with_name('package.json'),
         Path(__file__).with_name('package-lock.json'),Path(__file__).with_name('application.json'),
         Path(__file__).with_name('permission_prompt.py'),Path(__file__).with_name('test_permission_prompt.py'),root/'.github/workflows/macos-app-ui.yml']}}
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
def command(name,kind='ui'):
    assert child.poll() is None
    child.stdin.write(name+'\n');child.stdin.flush();return event(kind,8)

def menu_action(name):
    value=command(name)
    result['open'+name.capitalize()]=value
    assert value['owned'] and value['trusted'] and value['matches']==1 and value['attempted'], 'MENU_TARGET_INVALID'
    # AXPress may time out while AppKit tracks an open menu. Preserve that
    # uncertainty; only the exact production renderer below proves the action.
    assert value['pressed'] or (value.get('completionUnknown') and value['actionStatus']==-25204), 'MENU_ACTION_FAILED'
    return value
def browser_command(*args):
    call=subprocess.run([str(browser),'--namespace',namespace,'--session',name,'--json',*args],env=env,
                        capture_output=True,text=True,timeout=30)
    assert len(call.stdout)<65536 and len(call.stderr)<65536, 'BROWSER_OUTPUT_LIMIT'
    if call.returncode!=0:
        result.setdefault('browserFailures',[]).append({'command':args[0],'exit':call.returncode,'stdout':call.stdout[:8192],'stderr':call.stderr[:8192]})
    assert call.returncode==0, 'BROWSER_COMMAND_FAILED'
    value=json.loads(call.stdout);assert value.get('success') is True, 'BROWSER_COMMAND_FAILED'
    return value

def browser_doctor():
    call=subprocess.run([str(browser),'--namespace',namespace,'--session',name,'--json','doctor','--offline','--quick'],
                        env=env,capture_output=True,text=True,timeout=20)
    assert len(call.stdout)<65536 and len(call.stderr)<65536, 'BROWSER_OUTPUT_LIMIT'
    result['browserDoctor']={'exit':call.returncode,'stdout':call.stdout,'stderr':call.stderr}
def target(kind):
    deadline=time.monotonic()+10
    expected=(app/'Contents/Resources/app/mac/ui.html').as_uri()+'?kind='+kind
    while time.monotonic()<deadline:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list',timeout=2) as response:
            raw=response.read(65537);assert len(raw)<65537
            pages=json.loads(raw)
        matches=[page for page in pages if page.get('type')=='page' and page.get('url')==expected]
        if len(matches)==1:
            assert re.fullmatch('[A-Fa-f0-9-]{16,64}',matches[0]['id']), 'TARGET_ID_INVALID'
            return {'id':matches[0]['id'],'url':expected}
        time.sleep(.1)
    raise RuntimeError('APP_WINDOW_MISSING')
def snapshot(kind):
    selected=target(kind);browser_command('tab',selected['id'])
    value=browser_command('snapshot')
    assert value['data']['origin']==selected['url'], 'RENDERER_ORIGIN_MISMATCH'
    result['snapshots'][kind]=value
    return json.dumps(value,ensure_ascii=False)

def permission_diagnostics():
    predicate='subsystem == "com.apple.TCC" AND (eventMessage CONTAINS[c] "com.cliprelay.desktop" OR eventMessage CONTAINS[c] "Sunshine" OR eventMessage CONTAINS[c] "PostEvent")'
    try:
        with tempfile.TemporaryFile() as output:
            call=subprocess.run(['/usr/bin/log','show','--last','60s','--style','json','--info','--predicate',predicate],
                                stdout=output,stderr=subprocess.DEVNULL,timeout=10)
            length=output.tell();output.seek(0)
            diagnostic={'exit':call.returncode,'bytes':length,'records':[]}
            if call.returncode==0 and length<=1024*1024:
                values=json.load(output);assert isinstance(values,list)
                diagnostic['records']=[{key:str(row.get(key,''))[:2000] for key in
                    ['timestamp','process','processID','subsystem','category','eventMessage']} for row in values[-80:]]
            result['permissionDiagnostics']=diagnostic
    except Exception as error:result['permissionDiagnostics']={'error':type(error).__name__}

def probe_permission():
    label='屏幕录制' if permission_probe=='screen' else '键鼠控制'
    snapshot('host-permissions')
    current=result['snapshots']['host-permissions']['data'];lines=current['snapshot'].splitlines();inside=False;refs=[]
    for line in lines:
        if 'heading ' in line and 'level=2' in line:inside='"'+label+'"' in line
        if inside and 'button "前往授权"' in line and '[disabled' not in line:
            found=re.search(r'ref=(e[0-9]+)',line)
            if found:refs.append(found.group(1))
    assert len(refs)==1 and current['refs'][refs[0]]=={'name':'前往授权','role':'button'}, 'PERMISSION_BUTTON_INVALID'
    before=command('system-windows','consent-windows');assert before['owned'] and before['trusted']
    result['permissionRequest']={'permission':permission_probe,'before':before,'observations':[]}
    browser_command('click','@'+refs[0])
    deadline=time.monotonic()+10;observed=False
    while time.monotonic()<deadline:
        value=command('system-windows','consent-windows');assert value['owned'] and value['trusted']
        result['permissionRequest']['observations'].append(value)
        if (settings_window if open_permission_settings else permission_prompt)(value['brokers'],permission_probe):
            observed=True;break
        time.sleep(.5)
    result['permissionRequest']['systemPromptObserved']=observed and not open_permission_settings
    result['permissionRequest']['systemSettingsObserved']=observed and open_permission_settings
    snapshot('host-permissions')
    if not observed:permission_diagnostics()
    assert observed,'SYSTEM_SETTINGS_NOT_OBSERVED' if open_permission_settings else 'SYSTEM_PERMISSION_PROMPT_NOT_OBSERVED'
    result['cases'].append('production-renderer-opens-'+permission_probe+'-system-settings' if open_permission_settings else 'production-renderer-requests-'+permission_probe+'-permission')
    if open_permission_settings:
        result['permissionSettingsRow']=command(permission_probe+'-setting-row','permission-setting')
        if grant_permission:
            action=command('grant-'+permission_probe,'permission-setting');result['permissionGrantAction']=action
            assert action['owned'] and action['trusted'] and action['candidates']==1 and action['checkedBefore']==0 and action['enabled'], 'PERMISSION_TOGGLE_INVALID'
            assert action['attempted'] and (action['pressed'] or action['actionStatus']==-25204), 'PERMISSION_TOGGLE_ACTION_FAILED'
            result['permissionGrantObservations']=[];result['permissionToggleObservations']=[];deadline=time.monotonic()+20;granted=False
            while time.monotonic()<deadline:
                value=command('system-windows','consent-windows');assert value['owned'] and value['trusted']
                result['permissionGrantObservations'].append(value)
                result['permissionToggleObservations'].append(command(permission_probe+'-setting-row','permission-setting'))
                snapshot('host-permissions')
                browser_command('find','role','button','click','--name','重新检查')
                browser_command('wait','--text','已读取当前系统状态')
                snapshot('host-permissions');inside=False
                for line in result['snapshots']['host-permissions']['data']['snapshot'].splitlines():
                    if 'heading ' in line and 'level=2' in line:inside='"'+label+'"' in line
                    if inside and 'StaticText "已允许"' in line:granted=True
                if granted:break
                time.sleep(.5)
            result['permissionGrantedByFixture']=granted
            if not granted:permission_diagnostics()
            assert granted,'PERMISSION_GRANT_NOT_READ_BACK'
            result['cases'].append(permission_probe+'-permission-granted-through-system-settings-and-read-back')
try:
    child=subprocess.Popen([str(helper),str(app),str(port)],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                           text=True,bufsize=1)
    threading.Thread(target=read_stdout,daemon=True).start()
    ready=event('ready',20);assert ready['owned'] is True and ready['launchedThroughNSWorkspace'] is True
    assert ready['parentPid']!=child.pid and ready['bundleIdentifier']=='com.cliprelay.desktop'
    result['launch']=ready;result['cases'].append('unchanged-complete-app-launched-through-NSWorkspace')
    stage='inspect-menu';menu_deadline=time.monotonic()+15
    while True:
        menu=command('inspect');result['initialMenu']=menu
        if menu.get('menuRootAvailable') and any(row['role']=='AXMenuBarItem' and 'ClipRelay' in [row['title'],row['description']] for row in menu['nodes']):break
        assert time.monotonic()<menu_deadline,'STATUS_MENU_NOT_READY'
        time.sleep(.25)
    # The app exposes its complete status-menu items to Accessibility before
    # popup tracking starts. Activate the exact item directly: opening the
    # popup first can leave Electron's AX handler waiting in its modal loop.
    stage='open-host';menu_action('host')
    result['hostRendererUrl']=target('host')['url']
    stage='browser-diagnostics';browser_doctor()
    stage='connect-owned-renderer';browser_command('connect',str(port));browser_connected=True
    stage='host-window';text=snapshot('host');assert '启动远程访问' in text and '检查系统权限' in text
    result['cases'].append('native-menu-opens-production-host-renderer')
    stage='read-permissions';browser_command('find','role','button','click','--name','检查系统权限')
    snapshot('host-permissions')
    browser_command('wait','--text','已读取当前系统状态')
    text=snapshot('host-permissions');assert '屏幕录制' in text and '键鼠控制' in text
    result['cases'].append('production-renderer-opens-read-only-system-permission-check')
    if permission_probe!='none':
        stage='request-permission';probe_permission()
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
            if child.poll() is None:
                child.stdin.write('quit\n');child.stdin.flush()
                if browser_connected:
                    time.sleep(2)
                    if child.poll() is None:
                        try:
                            observed=subprocess.run([str(browser),'--namespace',namespace,'--session',name,'--json','snapshot'],
                                                    env=env,capture_output=True,text=True,timeout=3)
                            if len(observed.stdout)<65536:result['quitSnapshot']=json.loads(observed.stdout)
                        except Exception as error:result['quitSnapshotError']=type(error).__name__
                child.stdin.close()
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
    # System windows are already stored in full under the corresponding phase;
    # avoid serializing the large inventories twice in the bounded artifact.
    result['consentEventCount']=sum(v.get('event')=='consent-windows' for v in all_events)
    result['helperEvents']=[v for v in all_events if v.get('event')!='consent-windows']
    result['passed']=failure is None and not cleanup
    if result['passed']:result['cases'].append('normal-application-quit-and-owned-profile-cleanup')
    report=root/'macos-app-ui.json';report.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'passed':result['passed'],'stage':stage,'cases':result['cases'],'cleanupErrors':cleanup}))
if not result['passed']:sys.exit(1)
