"""Exercise the production worker against an isolated, real installed herdr-core.

Never attaches to or terminates the user's default core or existing terminals.
The only process killed in the disconnect test is this suite's own worker.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
import hashlib

worker, artifact = map(Path, sys.argv[1:3])
hc = Path(os.environ['LOCALAPPDATA']) / 'Programs/herdr-core/hc.exe'
session = 'cliprelay-check-' + uuid.uuid4().hex[:12]
environment = dict(os.environ, HC_SESSION=session, XDG_STATE_HOME=str(artifact / 'core-state'))
for key in ('HC_SOCKET', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_CALLER'):
    environment.pop(key, None)

def command(*args):
    result = subprocess.run([str(hc), *args], env=environment,
                            capture_output=True, text=True, encoding='utf-8', timeout=25)
    if result.returncode:
        raise AssertionError((args, result.stderr, result.stdout))
    return result.stdout

def check(condition, label):
    if not condition:
        raise AssertionError(label)
    print('PASS', label, flush=True)

process = None
bootstrap = None
started = False
owner = 'a' * 64
watch_id = uuid.uuid4().hex
creation_ids = []
def request(op, **fields):
    value = dict(op=op, **fields)
    if op != 'sync':
        value['owner'] = owner
    process.stdin.write(json.dumps(value, ensure_ascii=False) + '\n')
    process.stdin.flush()
    line = process.stdout.readline()
    if not line:
        raise AssertionError('worker exited: ' + process.stderr.read())
    return json.loads(line)

try:
    agent_bin=artifact/'fixture-bin';agent_bin.mkdir(exist_ok=True)
    agent_home=artifact/'fixture-herdr-home';agent_home.mkdir(exist_ok=True)
    for name in ('cliprelay-unlisted-agent','cliprelay-configured-agent'):
        (agent_bin/(name+'.cmd')).write_text('@echo off\necho CUSTOM_AGENT_READY %*\n',encoding='utf8')
    (agent_home/'programs.json').write_text(json.dumps({'programs':{'fixture-custom':{'name':'Custom Agent','run':[str(agent_bin/'cliprelay-configured-agent.cmd'),'argument with spaces']}}}),encoding='utf8')
    (worker.parent/'test-agents.json').write_text(json.dumps({'home':str(agent_home),'bin':str(agent_bin)}),encoding='utf8')
    # Agent shells may be elevated. Start the isolated core from the same
    # limited desktop token used by production, never weaken its pipe ACL.
    setup = worker.parent / 'test-session.json'
    setup.write_text(json.dumps(dict(hc=str(hc), session=session,
                                    state=environment['XDG_STATE_HOME'])), encoding='utf-8')
    process = subprocess.Popen([str(worker), '--herdr-probe'], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding='utf-8', bufsize=1)
    reply = request('sync', owners=[owner])
    started = True
    check(reply['ok'], 'paired authorization reaches desktop worker')
    # Keep the fixture's launcher separate from the worker being crash-tested.
    # Windows may retain descendants in the launcher's job even after detach.
    bootstrap = process
    setup.unlink()
    process = subprocess.Popen([str(worker), '--herdr-probe'], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding='utf-8', bufsize=1)
    reply = request('sync', owners=[owner])
    command('run', '--bg', '--name', 'cliprelay-verification', 'cmd.exe', '/D', '/Q')
    instance = reply['instance']
    reply = request('list', coreSession=session)
    check(reply['ok'] and len(reply['result']['terminals']) == 1, 'lists existing real core terminal: '+json.dumps(reply))
    terminal = reply['result']['terminals'][0]['address']
    base = dict(instance=instance, id=watch_id)
    reply = request('watch', coreSession=session, terminal=terminal, **base)
    check(reply['ok'], 'attaches observer to real terminal')
    dimensions = (reply['result']['columns'], reply['result']['rows'])
    sequence = 0
    def send(text):
        global sequence
        sequence += 1
        return request('send', sequence=sequence, text=text, **base)
    marker = 'CLIPRELAY_HERDR_' + uuid.uuid4().hex
    input_started = time.monotonic()
    reply = send('echo ' + marker)
    input_ms = (time.monotonic()-input_started)*1000
    check(input_ms < 1500, f'human submission avoids automation settle/quiet wait ({input_ms:.0f} ms)')
    check(reply['ok'] and reply['result']['inputCode'] == '', 'phone text reaches original terminal')
    duplicate = request('send', sequence=sequence, text='echo '+marker, **base)
    check(duplicate == reply, 'lost receipt retry is idempotent')
    conflict = request('send', sequence=sequence, text='echo WRONG', **base)
    check(conflict['code'] == 'HERDR_CONFLICT', 'same sequence cannot change command')
    import base64
    output = bytearray()
    after = 0
    end = time.monotonic() + 10
    resizes = []
    while time.monotonic() < end:
        reply = request('read', after=after, **base)
        check(reply['ok'], 'stream read accepted')
        for chunk in reply['result']['chunks']:
            if chunk['kind'] == 'data':
                output.extend(base64.b64decode(chunk['data']))
            elif chunk['kind'] == 'resize':
                resizes.append((chunk['columns'], chunk['rows']))
        after = reply['result']['next']
        if marker.encode() in output:
            break
        time.sleep(.1)
    check(marker.encode() in output, 'incremental VT stream contains agent output')
    check(dimensions in resizes, 'observer receives original desktop dimensions')
    counter = artifact / ('input-once-' + uuid.uuid4().hex + '.txt')
    once = 'echo once>>"' + str(counter) + '"'
    check(send(once)['result']['inputCode'] == '', 'counter command accepted')
    check(request('send', sequence=sequence, text=once, **base)['ok'], 'counter retry accepted')
    deadline = time.monotonic() + 5
    while (not counter.exists() or not counter.read_text().endswith('\n')) and time.monotonic() < deadline:
        time.sleep(.05)
    check(counter.read_text().splitlines() == ['once'], 'retried command has exactly one side effect')
    counter.unlink()
    # No textual send is retried against a new worker instance or a new watch.
    sequence += 1
    reply = request('keys', sequence=sequence, keys=['enter'], **base)
    check(reply['ok'] and reply['result']['inputCode'] == '', 'named keys reach interactive input')
    # A native console reader checks key events, not just a successful RPC.
    key_probe=artifact/'key-probe.py';key_result=artifact/'key-result.json'
    key_probe.write_text('import msvcrt,json,sys\nfrom pathlib import Path\nprint("KEY_PROBE_READY",flush=True)\nkeys=[]\nwhile True:\n c=msvcrt.getwch();keys.append(ord(c))\n if c=="\\r":break\nPath(sys.argv[1]).write_text(json.dumps(keys))\n',encoding='utf8')
    command('run','--bg','--name','key-probe',sys.executable,str(key_probe),str(key_result))
    command('wait','key-probe','--output','KEY_PROBE_READY')
    key_terminal=json.loads(command('get','key-probe'))['address']
    key_base=dict(instance=instance,id=uuid.uuid4().hex)
    check(request('watch',coreSession=session,terminal=key_terminal,**key_base)['ok'],'observe isolated native key reader')
    key_started=time.monotonic()
    key_reply=request('keys',sequence=1,keys=['down','enter'],**key_base)
    key_ms=(time.monotonic()-key_started)*1000
    check(key_reply['ok'] and key_reply['result']['inputCode']=='','direction and Enter accepted in order')
    deadline=time.monotonic()+3
    while not key_result.exists() and time.monotonic()<deadline:time.sleep(.02)
    check(key_result.exists() and json.loads(key_result.read_text())[-2:]==[80,13],'Windows console receives Down followed by a real Enter')
    check(key_ms<1000,f'key confirmation avoids quiet-period delay ({key_ms:.0f} ms)')
    request('detach',**key_base);command('rm',key_terminal)
    key_probe.unlink();key_result.unlink()
    request('sync', owners=[])
    reply = request('read', after=after, **base)
    check(reply['code'] == 'HERDR_UNPAIRED', 'revocation withdraws mobile access')
    check(marker in command('read', terminal), 'revocation preserves computer terminal')
    request('sync', owners=[owner])
    watch_id = uuid.uuid4().hex
    base = dict(instance=instance, id=watch_id)
    check(request('watch', coreSession=session, terminal=terminal, **base)['ok'], 'reattaches after access restored')
    check(request('detach', **base)['ok'], 'explicit detach succeeds')
    check(marker in command('read', terminal), 'explicit detach preserves original terminal')
    base['id'] = uuid.uuid4().hex
    check(request('watch', coreSession=session, terminal=terminal, **base)['ok'], 'reattaches after detach')
    process.kill(); process.wait(timeout=10); process=None
    check(marker in command('read', terminal), 'worker crash leaves original agent alive')
    process = subprocess.Popen([str(worker), '--herdr-probe'], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding='utf-8', bufsize=1)
    request('sync', owners=[owner])
    check(request('send', sequence=1, text='echo SHOULD_NOT_RUN', **base)['code'] == 'HERDR_STALE',
          'restarted worker rejects input from previous instance')
    def rpc(method, params):
        messages = [dict(jsonrpc='2.0', id=0, method='hello', params={'generation': 1}),
                    dict(jsonrpc='2.0', id=1, method=method, params=params)]
        child = subprocess.Popen([str(hc), 'connect'], env=environment, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf8')
        try:
            for message in messages:
                child.stdin.write(json.dumps(message)+'\n');child.stdin.flush()
                while True:
                    line=child.stdout.readline()
                    if not line: raise AssertionError('Core RPC closed: '+child.stderr.read())
                    result=json.loads(line)
                    if result.get('id')==message['id']:break
        finally:
            child.stdin.close();child.wait(timeout=5)
        check('result' in result, 'isolated core RPC '+method+(' '+json.dumps(result) if 'result' not in result else ''))
        return result['result']
    project_dir = artifact / "project with spaces 'quotes'"
    project_dir.mkdir(exist_ok=True)
    project_id = 'sp-mobile-verification'
    rpc('doc.set', dict(name='herdr-app', version=0, value={'spaces':[
        dict(id=project_id, name='Mobile project', folder=str(project_dir), tabs=[])]}))
    catalog = request('list', coreSession=session)['result']
    check(catalog['projects'][0]['name'] == 'Mobile project', 'project catalog uses desktop workspace names')
    for agent in ('codex', 'claude'):
        check(next(a for a in catalog['agents'] if a['id']==agent)['available'], agent+' discovered in desktop user environment')
        create_id = uuid.uuid4().hex
        creation_ids.append(create_id)
        create = dict(id=create_id, coreSession=session, project=project_id, agent=agent, name='Mobile '+agent)
        reply = request('create', **create)
        check(reply['ok'], 'create '+agent+' in existing project: '+json.dumps(reply))
        created = reply['result']['terminal']
        check(created['projectName']=='Mobile project' and created['agent']==agent and created['cwd']==str(project_dir), 'project, agent and cwd preserved')
        address = created['address']
        deadline=time.monotonic()+20
        started_agent=False
        while time.monotonic()<deadline:
            screen=command('read',address)
            if ('Ask Codex' in screen or 'OpenAI Codex' in screen) if agent=='codex' else ('Claude Code' in screen):
                started_agent=True;break
            time.sleep(.2)
        (artifact/(agent+'-startup.txt')).write_text(screen,encoding='utf8')
        check(started_agent, agent+' interactive CLI rendered in the original terminal')
        scroll_test = agent == 'codex' and os.environ.get('CLIPRELAY_HERDR_SCROLL_TEST') == '1'
        notify_test = agent == 'codex' and os.environ.get('CLIPRELAY_HERDR_NOTIFY_TEST') == '1'
        if scroll_test or notify_test:
            deadline=time.monotonic()+30
            while time.monotonic()<deadline:
                facts=rpc('terminal.get',{'terminal':address})
                if (facts.get('status') or {}).get('state')=='idle':
                    time.sleep(4)
                    break
                time.sleep(.5)
            if scroll_test:
                import re
                marker='CLIPRELAY_SCROLL_'+uuid.uuid4().hex[:12]
                prompt='For a terminal scroll test, output exactly 160 separate lines, from CONTINUOUS_001 to CONTINUOUS_160, then '+marker+'. Do not use tools, inspect files or change files.'
                rpc('terminal.send',{'terminal':address,'text':prompt,'force':True,'wait':False})
                deadline=time.monotonic()+300
                matched=False
                pressed=False
                while time.monotonic()<deadline:
                    request('sync',owners=[owner])
                    history=command('read',address,'--lines','2000')
                    matched=all(re.search(r'(?m)^\s*[?]?\s*CONTINUOUS_%03d\s*$'%n,history) is not None for n in range(1,161))
                    if matched:break
                    if not pressed and time.monotonic()>deadline-285:
                        screen=command('read',address)
                        if any(line.strip().startswith('? '+prompt[:25]) for line in screen.splitlines()[-12:]):
                            rpc('terminal.keys',{'terminal':address,'keys':['enter']});pressed=True
                    time.sleep(1)
                (artifact/'codex-continuous-history.txt').write_text(history,encoding='utf8')
                check(matched,'real terminal retains all 160 rows without a page key')
                check(len(history.splitlines())>facts['rows'],'continuous history exceeds the terminal viewport')
            if notify_test:
                (artifact/'mobile-check.done').unlink(missing_ok=True)
                (artifact/'mobile-session.json').write_text(json.dumps({'core':session,'terminal':address}),encoding='utf8')
                print('READY mobile verification '+session+' '+address,flush=True)
                deadline=time.monotonic()+900
                while not (artifact/'mobile-check.done').exists() and time.monotonic()<deadline:
                    request('sync',owners=[owner]);time.sleep(3)
                check((artifact/'mobile-check.done').exists(),'phone verification finished')
        check(request('create', **create)['result']['terminal']['address']==address, 'duplicate creation returns original terminal')
        check(request('create', **dict(create, name='Changed'))['code']=='HERDR_CONFLICT', 'create ID cannot change payload')
        process.kill();process.wait(timeout=10)
        process = subprocess.Popen([str(worker), '--herdr-probe'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, encoding='utf8', bufsize=1)
        request('sync', owners=[owner])
        check(request('create', **create)['result']['terminal']['address']==address, 'creation recovery survives worker restart')
        facts = rpc('terminal.list', {'all':True})['terminals']
        check(sum(t.get('labels',{}).get('cliprelay.title')=='Mobile '+agent for t in facts)==1, 'exactly one '+agent+' created')
        command('kill', address)
        check(request('create', **create)['result']['terminal']['address']==address, 'finished agent is not relaunched by retry')
    # Closing is bound to the exact core and terminal incarnation, never an alias.
    request('sync', owners=[owner])
    catalog=request('list',coreSession=session)
    command('run','--bg','--keep','--name','cliprelay-close-check','cmd.exe','/D','/Q')
    candidate=next(t for t in request('list',coreSession=session)['result']['terminals'] if t['name']=='cliprelay-close-check')
    closing=dict(instance=catalog['instance'],id=uuid.uuid4().hex,coreSession=session,
                 coreId=catalog['result']['coreId'],terminal=candidate['address'],createdMs=candidate['createdMs'])
    for wrong in (dict(coreId='old-core'),dict(createdMs=candidate['createdMs']+1),dict(instance='0'*32)):
        check(request('close',**dict(closing,**wrong))['code']=='HERDR_STALE','stale close cannot terminate a session')
    check(json.loads(command('get',candidate['address']))['state']=='live','rejected closes leave program running')
    request('sync',owners=[])
    check(request('close',**closing)['code']=='HERDR_UNPAIRED','revoked phone cannot close')
    request('sync',owners=[owner])
    check(request('close',**closing)['result']['closed'],'closes and removes a kept terminal')
    check(request('close',**closing)['result']['closed'],'already removed terminal can be reconciled safely')
    remaining=rpc('terminal.list',{'all':True})['terminals']
    check(not any(t['address']==candidate['address'] for t in remaining),'closed session is absent from core')
    check(any(t['address']==terminal and t['state']=='live' for t in remaining),'other terminal remains alive')
    check(any(p['id']==project_id for p in request('list',coreSession=session)['result']['projects']),'project catalog survives close')
    for search_query,expected in [('cliprelay-unlisted-agent','cli-'),('Custom Agent','fixture-custom')]:
        request('sync',owners=[owner])
        choices=request('agents',query=search_query)
        check(choices['ok'] and len(choices['result']['agents'])==1,'discovers arbitrary installed/configured CLI')
        choice=choices['result']['agents'][0]
        check(choice['id'].startswith(expected) and choice['available'],'catalog uses resolved opaque ID')
        create_id=uuid.uuid4().hex;creation_ids.append(create_id)
        made=request('create',id=create_id,coreSession=session,project=project_id,agent=choice['id'],name='Generic CLI check')
        check(made['ok'],'generic CLI creation succeeds')
        created=made['result']['terminal'];deadline=time.monotonic()+5;screen=''
        while time.monotonic()<deadline:
            screen=command('read',created['address'])
            if 'CUSTOM_AGENT_READY' in screen:break
            time.sleep(.1)
        check('CUSTOM_AGENT_READY' in screen,'generic CLI actually executes')
        check(created['agentName']==choice['name'],'generic Agent display name survives creation')
        if expected=='fixture-custom':check('argument with spaces' in screen,'configured arguments retain quoting')
        current=request('list',coreSession=session)
        check(request('close',instance=current['instance'],id=uuid.uuid4().hex,coreSession=session,coreId=current['result']['coreId'],terminal=created['address'],createdMs=created['createdMs'])['ok'],'removes only generic test session')
    check(request('create',id=uuid.uuid4().hex,coreSession=session,project=project_id,agent='unregistered-program-id')['code']=='HERDR_AGENT_UNAVAILABLE','unresolved IDs cannot execute arbitrary programs')
    rejected=request('create', id=uuid.uuid4().hex, coreSession=session, project='does-not-exist', agent='codex')
    check(rejected['code']=='HERDR_PROJECT_NOT_FOUND', 'arbitrary project IDs cannot launch commands')
    uncertain_id=uuid.uuid4().hex
    creation_ids.append(uncertain_id)
    key=hashlib.sha256((owner+'\n'+session+'\n'+uncertain_id).encode()).hexdigest()
    journal=Path(os.environ['LOCALAPPDATA'])/'ClipRelay/herdr-launches'/(key+'.json')
    journal.write_text(json.dumps({'fingerprint':hashlib.sha256((project_id+'\ncodex\n').encode()).hexdigest()}),encoding='utf8')
    before=len(rpc('terminal.list',{'all':True})['terminals'])
    check(request('create',id=uncertain_id,coreSession=session,project=project_id,agent='codex')['code']=='HERDR_CREATE_UNCERTAIN', 'reserved unknown creation is never launched again')
    check(len(rpc('terminal.list',{'all':True})['terminals'])==before,'unknown reservation has no launch side effect')
    request('sync',owners=[])
    check(request('create', **create)['code']=='HERDR_UNPAIRED', 'revoked client cannot create or recover an agent')
    print('PASS real herdr-core integration complete', flush=True)
finally:
    (worker.parent/'test-agents.json').unlink(missing_ok=True)
    (worker.parent / 'test-session.json').unlink(missing_ok=True)
    if process:
        process.stdin.close()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill();process.wait(timeout=5)
    if started:
        command('server', 'stop')
    if bootstrap:
        bootstrap.stdin.close()
        try: bootstrap.wait(timeout=5)
        except subprocess.TimeoutExpired: bootstrap.kill();bootstrap.wait(timeout=5)
    for create_id in creation_ids:
        key=hashlib.sha256((owner+'\n'+session+'\n'+create_id).encode()).hexdigest()
        (Path(os.environ['LOCALAPPDATA'])/'ClipRelay/herdr-launches'/(key+'.json')).unlink(missing_ok=True)
