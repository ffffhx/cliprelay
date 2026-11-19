"""Resolve successful, nonexpired main component artifacts for desktop releases.

Manual builds retain explicit component selection. Automatic publication never
silently falls back to a clipboard-only package when a component is unavailable.
"""
import json
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

COMPONENTS = {
    'viewer': ('VIEWER', 'desktop-client.yml', 'ClipRelay-Stream-macOS'),
    'network': ('NETWORK', 'desktop-network.yml', 'ClipRelay-Desktop-Network-macOS'),
    'host': ('HOST', 'sunshine-macos.yml', None),
    'companion': ('COMPANION', 'host-companion-macos.yml', None),
}
SOURCES = {
    'viewer': ['engine/desktop-client', 'scripts', 'windows/electron/mac', 'windows/tests'],
    'network': ['network', 'scripts', 'windows/tests'],
    'host': ['engine/sunshine', 'scripts', 'network/hostprivacy', 'network/go.mod', 'network/go.sum'],
    'companion': ['network', 'scripts', 'android-app/remote-engine'],
}


def gh(*args):
    return json.loads(subprocess.check_output(['gh', *args], text=True))


def live_artifacts(run, artifact_name):
    artifacts = gh('api', f"repos/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{run}/artifacts")['artifacts']
    return any(not item['expired'] and (not artifact_name or item['name'] == artifact_name) for item in artifacts)


def resolve_one(item):
    key, (variable, workflow, artifact_name) = item
    selected = os.environ.get(variable, '')
    if not selected and os.environ.get('GITHUB_EVENT_NAME') == 'push':
        runs = gh('run', 'list', '--workflow', workflow, '--branch', 'main', '--status', 'success',
                  '--limit', '20', '--json', 'databaseId,headSha')
        for run in runs:
            if not live_artifacts(run['databaseId'], artifact_name):
                continue
            changed = subprocess.run(['git', 'diff', '--quiet', run['headSha'], os.environ['GITHUB_SHA'], '--', *SOURCES[key]], check=False)
            if changed.returncode == 0:
                selected = str(run['databaseId'])
                break
        if not selected:
            # Missing/stale binaries are rebuilt with their existing full acceptance
            # workflows. A different main commit must never be relabelled as this release.
            started = datetime.now(timezone.utc).replace(microsecond=0)
            subprocess.run(['gh', 'workflow', 'run', workflow, '--ref', 'main'], check=True)
            deadline = time.monotonic() + 140 * 60
            while time.monotonic() < deadline:
                runs = gh('run', 'list', '--workflow', workflow, '--branch', 'main', '--event', 'workflow_dispatch',
                          '--limit', '20', '--json', 'databaseId,headSha,createdAt,status,conclusion')
                candidates = [run for run in runs if datetime.fromisoformat(run['createdAt'].replace('Z', '+00:00')) >= started]
                if candidates:
                    run = min(candidates, key=lambda value: value['createdAt'])
                    if run['headSha'] != os.environ['GITHUB_SHA']:
                        raise RuntimeError(f'{workflow}: main advanced; the newer desktop release will publish instead')
                    if run['status'] == 'completed':
                        if run['conclusion'] != 'success' or not live_artifacts(run['databaseId'], artifact_name):
                            raise RuntimeError(f'{workflow}: component build or acceptance failed')
                        selected = str(run['databaseId'])
                        break
                time.sleep(30)
            if not selected:
                raise RuntimeError(f'{workflow}: component build timed out')
    if selected and not selected.isdigit():
        raise ValueError(f'Invalid {key} run ID')
    return key, selected


def resolve():
    with ThreadPoolExecutor(max_workers=4) as executor:
        values = dict(executor.map(resolve_one, COMPONENTS.items()))
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
        for key, value in values.items():
            output.write(f'{key}={value}\n')


if __name__ == '__main__':
    resolve()
