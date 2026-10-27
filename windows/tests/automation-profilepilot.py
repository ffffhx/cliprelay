"""Real installed ProfilePilot through the native worker; never touches existing tabs."""
import argparse
import json
import pathlib
import subprocess
import uuid
import http.server
import threading
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--worker',type=pathlib.Path,default=ROOT/'.tools/ai-control/ClipRelay.Remote.Service.exe')
    parser.add_argument('--manage',action='store_true',help='Create, rename and remove an isolated test Profile')
    parser.add_argument('--browser',action='store_true',help='Open an isolated test browser and verify DOM actions')
    parser.add_argument('--native-profile',help='Exact connected Profile ID; creates only a new fixture tab')
    parser.add_argument('--gateway-profile',help='Exact authorized, registered browser Profile ID; creates only a new fixture tab')
    parser.add_argument('--electron-app',help='Exact registered Electron ID; observe only')
    args=parser.parse_args()
    process=subprocess.Popen([str(args.worker),'--automation-probe'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW)
    owner='a'*64
    def exchange(value):
        process.stdin.write(json.dumps(value,ensure_ascii=False)+'\n');process.stdin.flush()
        line=process.stdout.readline()
        if not line: raise RuntimeError('Native worker ended: '+process.stderr.read()[:1000])
        response=json.loads(line)
        if not response.get('ok'): raise RuntimeError(response.get('code'))
        return response
    exchange({'op':'sync','owners':[owner]})
    capabilities=exchange({'op':'capabilities','owner':owner})
    assert capabilities['result']['profilepilot'], 'ProfilePilot CLI not installed'
    session=uuid.uuid4().hex
    def call(op,params=None):
        exchange({'op':'sync','owners':[owner]})
        return exchange({'op':op,'owner':owner,'instance':capabilities['instance'],'requestId':uuid.uuid4().hex,'session':session,'params':params or {}})['result']
    def cli(value):
        assert value['exitCode']==0, value
        assert value['data'].get('ok') is True, value
        return value['data'].get('data',value['data'])
    profile_id=None
    browser_id=None
    tab_id=None
    server=None
    proof={}
    try:
        profiles=cli(call('profiles'))['profiles']
        assert any(p['id'].startswith('native:') for p in profiles)
        assert any('系统' in p['name'] for p in profiles), 'Unicode CLI output was corrupted'
        apps=call('apps')['apps']
        if args.manage or args.browser:
            name='ClipRelay AI fixture '+uuid.uuid4().hex[:8]
            created=cli(call('profile',{'command':'create','name':name}))
            all_profiles=cli(call('profiles'))['profiles']
            selected=[p for p in all_profiles if p['name']==name]
            assert len(selected)==1 and selected[0]['manageable']
            profile_id=selected[0]['id']
            cli(call('profile',{'command':'rename','profileId':profile_id,'name':name+' 中文'}))
            after=cli(call('profiles'))['profiles']
            assert next(p for p in after if p['id']==profile_id)['name']==name+' 中文'
        if args.browser or args.native_profile or args.gateway_profile:
                class Page(http.server.BaseHTTPRequestHandler):
                    def do_GET(self):
                        body=b'''<!doctype html><html><title>ClipRelay AI fixture</title><label>Fixture input <input id="input"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Apply fixture</button><output></output></html>'''
                        self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
                    def log_message(self,*unused):pass
                server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Page)
                threading.Thread(target=server.serve_forever,daemon=True).start()
                if args.browser:cli(call('profile',{'command':'start','profileId':profile_id}))
                opened=call('browser.open',{'profileId':args.native_profile,'newTab':True} if args.native_profile else {'profileId':args.gateway_profile or profile_id})
                browser_id=opened['browserId']
                assert opened['result']['exitCode']==0,opened
                nav=call('browser.navigate',{'browserId':browser_id,'url':f'http://127.0.0.1:{server.server_port}/',**({'newTab':True} if args.gateway_profile else {})})
                assert nav['exitCode']==0,nav
                observed=cli(call('browser.observe',{'browserId':browser_id}))
                # Ref selection comes only from this observed fixture DOM.
                result=observed.get('result',observed)
                if args.native_profile or args.gateway_profile:
                    tabs=cli(call('browser.tabs',{'browserId':browser_id}))
                    result_tabs=tabs.get('result',tabs)
                    if isinstance(result_tabs,dict):result_tabs=result_tabs.get('tabs',[])
                    selected=[tab for tab in result_tabs if tab.get('url','').startswith(f'http://127.0.0.1:{server.server_port}/')]
                    assert len(selected)==1, 'Fixture tab not uniquely identified'
                    tab_id=selected[0].get('id',selected[0].get('tabId'))
                def ref(observation,label):
                    candidates=observation.get('fast',{}).get('candidates',[])
                    matching=[c['ref'] for c in candidates if label in (c.get('name','')+' '+c.get('text','')+' '+c.get('label',''))]
                    if len(matching)==1:return matching[0]
                    lines=[line for line in observation.get('snapshot','').splitlines() if label in line]
                    found=[m.group(1) for line in lines for m in re.finditer(r'\[ref=(@?(?:f\d+)?e\d+)\]',line)]
                    assert len(found)==1, {'missingFixtureRef':label,'observation':observation}
                    return found[0]
                literal='你好 ClipRelay & $() ` " quoted'
                cli(call('browser.action',{'browserId':browser_id,'action':{'kind':'fill','version':result['version'],'ref':ref(result,'Fixture input'),'value':literal}}))
                result=cli(call('browser.observe',{'browserId':browser_id}));result=result.get('result',result)
                cli(call('browser.action',{'browserId':browser_id,'action':{'kind':'click','version':result['version'],'ref':ref(result,'Apply fixture')}}))
                result=cli(call('browser.observe',{'browserId':browser_id}));result=result.get('result',result)
                assert literal in result.get('snapshot',''), 'Fixture did not expose applied Unicode text'
                proof['domFillAndClick']=True
        if args.electron_app:
            opened=call('browser.open',{'profileId':args.electron_app})
            electron_id=opened['browserId']
            try:
                observed=call('browser.observe',{'browserId':electron_id})
                assert observed['exitCode']==0, observed
                proof['electronObserved']=True
            finally:call('browser.close',{'browserId':electron_id})
        proof.update({'passed':True,'profileCount':len(profiles),'registeredElectronApps':len(apps),'unicode':True,'managedProfileRoundTrip':bool(profile_id),'browserOpened':bool(browser_id)})
    finally:
        try:
            if browser_id:
                if tab_id is not None:call('browser.tab_close',{'browserId':browser_id,'tabId':tab_id})
                call('browser.close',{'browserId':browser_id})
            if profile_id:
                if args.browser: cli(call('profile',{'command':'stop','profileId':profile_id}))
                try: cli(call('profile',{'command':'delete','profileId':profile_id}))
                except RuntimeError as error:
                    if str(error)!='AUTOMATION_OUTCOME_UNKNOWN':raise
                    # Inspect an uncertain deletion; never replay it.
                    assert not any(p['id']==profile_id for p in cli(call('profiles'))['profiles'])
                    proof['deletionReceipt']='unknown; verified absent in fresh catalog'
            call('close')
        finally:
            if server:server.shutdown();server.server_close()
            process.stdin.close()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill();process.wait();raise
    print(json.dumps(proof,ensure_ascii=True))

if __name__=='__main__':main()
