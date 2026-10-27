"""Exercise the distributable PowerShell MCP entry, including real stdin/stdout."""
import argparse
import json
import os
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('entry', type=pathlib.Path)
parser.add_argument('--devices', action='store_true', help='Also connect to the running ClipRelay app')
args = parser.parse_args()
requests = [
    {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'ClipRelay launcher test', 'version': '1'}}},
    {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
    {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
]
if args.devices:
    requests.append({'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'cliprelay_devices', 'arguments': {}}})
shell = pathlib.Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
result = subprocess.run([str(shell), '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', str(args.entry.resolve())],
                        input=''.join(json.dumps(r) + '\n' for r in requests), capture_output=True, text=True,
                        encoding='utf-8', timeout=75, creationflags=subprocess.CREATE_NO_WINDOW)
assert result.returncode == 0, result.stderr
replies = {r['id']: r for r in map(json.loads, result.stdout.splitlines())}
assert replies[1]['result']['serverInfo']['name'] == 'cliprelay'
tools = replies[2]['result']['tools']
assert {'cliprelay_profiles', 'cliprelay_electron_apps', 'cliprelay_window_action'} <= {t['name'] for t in tools}
proof = {'stdioLauncher': True, 'version': replies[1]['result']['serverInfo']['version'], 'tools': len(tools)}
if args.devices:
    assert not replies[3]['result'].get('isError'), replies[3]['result']
    proof['privateAppConnection'] = True
    proof['deviceCount'] = len(json.loads(replies[3]['result']['content'][0]['text'])['devices'])
print(json.dumps(proof))
