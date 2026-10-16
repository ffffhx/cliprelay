"""Check real login-item registration with an owned, uniquely identified CI bundle."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid


def main():
    assert sys.platform == 'darwin' and os.environ.get('CI') == 'true' and os.environ.get('GITHUB_ACTIONS') == 'true', 'Disposable macOS CI only'
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--modules', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    runtime, modules, report = args.runtime.resolve(), args.modules.resolve(), args.report.resolve()
    assert runtime.suffix == '.app' and (modules/'login-startup.cjs').is_file()
    runner = Path(os.environ['RUNNER_TEMP']).resolve()
    report.parent.mkdir(parents=True, exist_ok=True)
    fixture = Path(__file__).resolve().parents[1]/'windows/tests/native-mac-login-startup.cjs'
    result = dict(protocol=1, passed=False, testCommit=os.environ['GITHUB_SHA'], cases=[], phases=[],
                  sourceSha256=hashlib.sha256((modules/'login-startup.cjs').read_bytes()).hexdigest(),
                  productionBundleRegistered=False, loginSessionRestarted=False, windowsCreated=0, cleanupConfirmed=False)
    failure = None
    with tempfile.TemporaryDirectory(prefix='cliprelay-login-test-', dir=runner) as temporary:
        directory = Path(temporary).resolve()
        isolated = directory/'ClipRelayLoginFixture.app'
        # Preserve the production runtime and load unchanged packaged modules,
        # but give the probe its own bundle ID, entry point and data directory.
        resources = runtime/'Contents/Resources'
        shutil.copytree(runtime, isolated, symlinks=True,
                        ignore=lambda location, names: ['app'] if Path(location) == resources else [])
        plist = isolated/'Contents/Info.plist'
        info = plistlib.loads(plist.read_bytes())
        info['CFBundleIdentifier'] = 'com.cliprelay.tests.login.fixture'+uuid.uuid4().hex
        # Electron resolves its existing helper executables from CFBundleName.
        # Keep that runtime name; only the fixture's registration identity and
        # user-visible display name differ from the production bundle.
        info['CFBundleDisplayName'] = 'ClipRelay Login Fixture'
        plist.write_bytes(plistlib.dumps(info))
        target = isolated/'Contents/Resources/app'
        target.mkdir()
        (target/'package.json').write_text(json.dumps(dict(name='cliprelay-login-fixture', version='1.0.0', main='main.cjs')))
        (target/'main.cjs').write_text('require('+json.dumps(str(fixture))+');\n')
        subprocess.run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', str(isolated)], check=True, capture_output=True)
        executable = isolated/'Contents/MacOS'/info['CFBundleExecutable']
        env = dict(os.environ, CLIPRELAY_NATIVE_LOGIN_FIXTURE='1')
        env.pop('ELECTRON_RUN_AS_NODE', None)
        result['bundleIdentifier'] = info['CFBundleIdentifier']
        result['productionRuntimeExecutableSha256'] = hashlib.sha256((runtime/'Contents/MacOS'/info['CFBundleExecutable']).read_bytes()).hexdigest()
        result['runtimeExecutableSha256'] = hashlib.sha256(executable.read_bytes()).hexdigest()
        (directory/'user-data').mkdir()

        def invoke(phase):
            receipt = directory/(phase+'.json')
            env['CLIPRELAY_NATIVE_LOGIN_OPTIONS'] = json.dumps(dict(phase=phase, userData=str(directory/'user-data'), modules=str(modules), report=str(receipt)))
            child = subprocess.Popen([str(executable)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            try:
                stdout, stderr = child.communicate(timeout=25)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.communicate()
                raise RuntimeError('Owned login fixture timed out: '+phase)
            data = json.loads(receipt.read_text()) if receipt.exists() else dict(passed=False, phase=phase, diagnostic=stderr.decode(errors='replace')[-2000:])
            result['phases'].append(data)
            if child.returncode or data['passed'] is not True:
                raise RuntimeError('Native login phase failed: '+phase+'\n'+stderr.decode(errors='replace')[-3000:])
            assert data['electron'] == '44.4.3'
            return data

        try:
            invoke('initial'); result['cases'].append('native-default-off-read-only')
            invoke('enable'); result['cases'].append('explicit-native-enable')
            invoke('reopen'); result['cases'].append('native-setting-survives-process-exit')
            invoke('external-disable'); result['cases'].append('external-disable-refresh-without-reenable')
        except Exception as error:
            failure = error
        finally:
            try:
                invoke('cleanup'); result['cleanupConfirmed'] = True
                result['cases'].append('native-registration-removed-before-fixture-deletion')
            except Exception as error:
                failure = failure or error
            result['passed'] = failure is None
            result['scope'] = 'Actual packaged production login controller and Electron API in a unique ad-hoc-signed disposable CI app. Registers only the fixture, observes persistence across separate processes and removes it. No production installation, system login/logout, UI automation, host startup, clipboard or user state access.'
            report.write_text(json.dumps(result, indent=2)+'\n')
    if failure:
        raise failure
    print(json.dumps(dict(passed=True, cases=len(result['cases']), architecture=result['phases'][0]['architecture'], cleanupConfirmed=True)))


if __name__ == '__main__':
    main()
