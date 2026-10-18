"""Compile shipped Android terminal protocol/state for native Mac CI interop.

The TLS adapter is a JVM fixture, not Android NvHTTP, WebView or Activity.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
JAVA = ['TerminalProtocol', 'TerminalSessionState', 'TerminalMouseState']
JSON_SHA256 = '7dd2de1533e766e2b6c07d8194da85145ad313a167a4760050f5c9b6839604fe'


def run(state, mouse_command):
    with tempfile.TemporaryDirectory(prefix='cliprelay-android-terminal-') as temporary:
        directory = Path(temporary)
        jar = directory/'json.jar'
        with urllib.request.urlopen('https://repo.maven.apache.org/maven2/org/json/json/20260814/json-20260814.jar', timeout=20) as response:
            body = response.read(256*1024)
        assert hashlib.sha256(body).hexdigest() == JSON_SHA256, 'Android JSON dependency hash mismatch'
        jar.write_bytes(body)
        sources = [ROOT/'android-app/remote-engine/src/main/java/com/limelight/terminal'/(name+'.java') for name in JAVA]
        sources.append(ROOT/'scripts/TerminalMacInterop.java')
        subprocess.run(['javac', '--release', '17', '-encoding', 'UTF-8', '-cp', str(jar), '-d', str(directory), *map(str, sources)], check=True, timeout=30)
        completed = subprocess.run(['java', '-Xmx128m', '-cp', os.pathsep.join([str(directory), str(jar)]), 'TerminalMacInterop'],
                                   input=json.dumps({'state': str(state), 'mouseCommand': mouse_command}).encode(),
                                   capture_output=True, timeout=90)
        assert completed.returncode == 0, completed.stderr.decode()
        assert json.loads(completed.stdout) == {'passed': True, 'shells': ['bash', 'zsh'], 'lostReplies': True,
                                              'mouseExpiry': True, 'reconnectAndGap': True}
