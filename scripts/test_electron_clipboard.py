"""Exercise packaged production clipboard modules in a real disposable Electron main process."""
import argparse
import base64
import binascii
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib


def main():
    assert os.environ.get('CI') == 'true' and os.environ.get('GITHUB_ACTIONS') == 'true', 'Disposable CI only'
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--modules', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--native-worker', type=Path)
    args = parser.parse_args()
    runtime, modules, report = args.runtime.resolve(), args.modules.resolve(), args.report.resolve()
    assert runtime.exists() and (modules/'clipboard-access.cjs').is_file()
    fixture = Path(__file__).resolve().parents[1]/'windows/tests/native-electron-clipboard.cjs'
    report.parent.mkdir(parents=True, exist_ok=True)
    def chunk(kind, value):
        return struct.pack('>I', len(value))+kind+value+struct.pack('>I', binascii.crc32(kind+value))
    png = (b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 3, 8, 6, 0, 0, 0))
           +chunk(b'IDAT', zlib.compress((b'\0'+b'\xff\0\0\x80'*2)*3))+chunk(b'IEND', b''))
    env = dict(os.environ)
    env.pop('ELECTRON_RUN_AS_NODE', None)
    env['CLIPRELAY_NATIVE_CLIPBOARD_FIXTURE'] = '1'
    with tempfile.TemporaryDirectory(prefix='cliprelay-native-clipboard-') as temporary:
        directory = Path(temporary).resolve()
        (directory/'user-data').mkdir()
        worker = args.native_worker.resolve() if args.native_worker else modules/'host-companion/runtime/cliprelay-host-network'
        if args.native_worker:
            assert worker.is_file(), 'Requested native worker missing'
        options = dict(userData=str(directory/'user-data'), modules=str(modules), report=str(report), png=base64.b64encode(png).decode())
        if worker.is_file():
            options['nativeWorker'] = str(worker)
        env['CLIPRELAY_NATIVE_CLIPBOARD_OPTIONS'] = json.dumps(options)
        if sys.platform == 'darwin':
            assert runtime.suffix == '.app'
            resources = runtime/'Contents/Resources'
            # Copy runtime only: never execute the product entry point, tray, host
            # service or startup handlers. All app/controller code comes from the
            # unchanged package directory specified above.
            isolated = directory/'ClipboardFixture.app'
            shutil.copytree(runtime, isolated, symlinks=True,
                            ignore=lambda path, names: ['app'] if Path(path) == resources else [])
            target = isolated/'Contents/Resources/app'
            target.mkdir()
            (target/'package.json').write_text(json.dumps({'name':'cliprelay-clipboard-fixture','version':'1.0.0','main':'main.cjs'}))
            (target/'main.cjs').write_text('require('+json.dumps(str(fixture))+');\n')
            command = [str(isolated/'Contents/MacOS/ClipRelay')]
        else:
            assert sys.platform == 'win32' and runtime.name.lower() == 'electron.exe'
            command = [str(runtime), str(fixture)]
        result = subprocess.run(command, env=env, capture_output=True, timeout=90,
                                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
        if result.returncode:
            raise RuntimeError('Native Electron clipboard fixture failed:\n'+result.stderr.decode(errors='replace')[-6000:])
    data = json.loads(report.read_text())
    assert len(data['cases']) == (15 if sys.platform == 'darwin' else 14)+(1 if worker.is_file() else 0)
    assert data['syntheticOnly'] and data['windowsCreated'] == 0 and data['electron'] == '44.4.3'
    print(json.dumps(data, indent=2))


if __name__ == '__main__':
    main()
