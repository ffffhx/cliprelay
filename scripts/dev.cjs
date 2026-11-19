'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {readRuntime} = require('../windows/electron/development.cjs');
const {requestApp} = require('../windows/electron/lifecycle.cjs');
const root = path.resolve(__dirname, '..');
function checked(executable, args) {
  const result = spawnSync(executable, args, {cwd: root, stdio: 'inherit', windowsHide: true});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
async function main() {
const dataRoot = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'ClipRelay') : path.join(require('node:os').homedir(), 'Library/Application Support/ClipRelay');
const runtime = readRuntime(dataRoot, path.join(root, 'windows'));
if (process.argv.includes('--restart')) {
  const result = await requestApp('quit');
  const deadline = Date.now() + 30000;
  let alive = true;
  while (Date.now() < deadline) {
    try { process.kill(result.pid, 0); } catch { alive = false; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (alive) throw new Error('ClipRelay has not finished graceful shutdown; no process was force-killed.');
} else if (runtime) { console.log(JSON.stringify({ok:true, method:'already-running', ...runtime})); return; }
if (process.platform === 'win32') {
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const inspected = spawnSync(powershell, ['-NoProfile', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='ClipRelay.exe'\" | Where-Object { $_.CommandLine -notmatch '(--type=|ai-mcp\\.cjs|--screen-share-engine)' } | Select-Object ProcessId) | ConvertTo-Json -Compress"], {encoding:'utf8',windowsHide:true});
  if (inspected.error || inspected.status !== 0) throw new Error('Cannot inspect the current ClipRelay process; development startup cancelled.');
  const processes = JSON.parse(inspected.stdout.trim() || '[]');
  if ((Array.isArray(processes) ? processes : [processes]).length) throw new Error('ClipRelay is already running without this checkout\'s development watcher. Use npm run dev -- --restart to quit through its CLI and launch development. An older process without this CLI needs one normal exit from its tray menu.');
  checked(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/clean_artifacts.ps1')]);
  // Prepare the runtime once; subsequent starts execute source directly.
  if(!fs.existsSync(path.join(root,'windows/desktop/ClipRelay.exe')))checked(powershell, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'windows/electron/setup.ps1')]);
  fs.copyFileSync(path.join(root,'windows/electron/main.js'),path.join(root,'windows/desktop/resources/app/main.js'));
  for(const [kind,name] of [['viewer','remote-viewer'],['network','desktop-network']]){
    const destination=path.join(root,'windows',name);
    if(fs.existsSync(path.join(destination,'manifest.json')))continue;
    const installed=path.join(process.env.LOCALAPPDATA,'ClipRelay',name);
    if(!fs.existsSync(path.join(installed,'manifest.json')))throw new Error(`Missing ${name}: install a complete ClipRelay package or build the component first.`);
    checked(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'windows/electron/stage-viewer.ps1'),'-Kind',kind,'-Artifact',installed,'-Destination',destination]);
  }
  checked(powershell, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'windows/start.ps1'), '-Development', '-OpenSettings']);
} else if (process.platform === 'darwin') {
  checked(process.execPath, [path.join(root, 'windows/electron/build-macos.cjs'), process.arch, '--development']);
  const bundle = path.join(root, '.tools/artifacts/acceptance/desktop-development-mac', `ClipRelay-darwin-${process.arch}`, 'ClipRelay.app');
  if (!fs.existsSync(bundle)) throw new Error('Development application was not built');
  checked('/usr/bin/open', ['-a', bundle, '--args', '--development']);
} else throw new Error('ClipRelay desktop development supports Windows and macOS');
const deadline = Date.now() + 90000;
while (Date.now() < deadline) {
  const ready = readRuntime(dataRoot, path.join(root, 'windows'));
  if (ready) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    if (!readRuntime(dataRoot, path.join(root, 'windows'))) throw new Error('ClipRelay exited during startup confirmation.');
    console.log(JSON.stringify({ok:true, method:'independent-development', ...ready})); return;
  }
  await new Promise(resolve => setTimeout(resolve, 500));
}
throw new Error('ClipRelay development startup was not confirmed within 90 seconds. Check the app error; an existing installed version may still be running.');
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
