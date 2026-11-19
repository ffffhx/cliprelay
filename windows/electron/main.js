'use strict';
const {app, dialog} = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');
const {NativeHost, parseArguments, readAgentDebugPort} = require('./native-host.cjs');
const {PairingAutoApprover} = require('./pairing-auto-approve.cjs');
const developmentSource = process.argv.find(value => value.startsWith('--development-root='))?.slice('--development-root='.length);
if (developmentSource && (!path.isAbsolute(developmentSource) || !require('node:fs').existsSync(path.resolve(developmentSource, '../../.git')))) throw new Error('Development startup requires a source checkout');
if (developmentSource && path.resolve(developmentSource).toLowerCase() !== path.resolve(__dirname).toLowerCase()) {
  if (!require('node:fs').existsSync(path.resolve(developmentSource, '../../.git'))) throw new Error('Development startup requires a source checkout');
  require(path.join(developmentSource, 'main.js'));
} else {
if (developmentSource) process.env.CLIPRELAY_DEVELOPMENT = '1';

// The distribution keeps native assets outside ASAR so Windows PowerShell 5.1
// and the existing installers can read them without extraction or duplication.
const root = developmentSource ? path.resolve(developmentSource, '..') : app.isPackaged ? path.resolve(process.resourcesPath, '../..') : path.resolve(__dirname, '..');
const dataRoot = developmentSource && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ClipRelay') : root;
if (developmentSource) process.env.CLIPRELAY_DATA_DIRECTORY = dataRoot;
if (process.platform === 'darwin') {
  require('./mac/main.cjs');
} else if (process.argv.includes('--screen-share-engine')) {
  require(path.join(root, 'screen-share', 'main.js'));
} else {
  // Shortcuts and login startup may launch the EXE directly. Keep the optional
  // Agent connection independent of the launch method and native relay config.
  if (!app.commandLine.hasSwitch('remote-debugging-port')) {
    const debugPort = readAgentDebugPort(dataRoot);
    if (debugPort) {
      app.commandLine.appendSwitch('remote-debugging-port', String(debugPort));
      app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
    }
  }
  app.setName('ClipRelay');
  app.setAppUserModelId('ClipRelay.Desktop');
  const identity = crypto.createHash('sha256').update(dataRoot.toLowerCase()).digest('hex').slice(0,16);
  app.setPath('userData', path.join(app.getPath('appData'), 'ClipRelay', 'Desktop', identity));
  let host;
  let windows;
  let approver;
  let quitting = false;
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    app.on('window-all-closed', () => {});
    app.on('second-instance', () => host?.open());
    app.on('before-quit', event => {
      if (host && !quitting) {
        event.preventDefault();
        quitting = true;
        Promise.resolve(windows?.close()).finally(()=>host.stop());
      }
    });
    app.whenReady().then(async () => {
      await require('./lifecycle.cjs').initialize(app, {directory:dataRoot, development:!!developmentSource, sourceRoot:developmentSource?path.resolve(root,'..'):null});
      const options = parseArguments(process.argv.slice(app.isPackaged ? 1 : 2).filter(value => !value.startsWith('--development-root=')));
      host = new NativeHost({root, launcher: path.join(__dirname, 'launch-native.ps1'), ...options});
      const {DesktopWindows} = require('./windows.cjs');
      windows = new DesktopWindows(host, root, dataRoot);
      approver = new PairingAutoApprover({request: (action, data) => host.request(action, data)});
      host.on('message', message => { if (message.event === 'open') windows.open(message.window); });
      let developmentRuntime;
      host.on('ready', () => {
        if (developmentSource && !developmentRuntime) developmentRuntime = require('./development.cjs').install({app, root, source: __dirname, dataRoot});
        windows.refresh(); approver.start(); windows.directory.start(); void windows.aiServer.start().catch(error=>{windows.aiError=error.code||'AI_UNAVAILABLE';});
      });
      host.on('failure', error => dialog.showErrorBox('ClipRelay', error.message));
      host.on('exit', () => { approver.stop(); quitting = true; void windows.close().finally(()=>app.quit()); });
      return host.start();
    }).catch(error => {
      dialog.showErrorBox('ClipRelay', error.message);
      quitting = true;
      app.quit();
    });
  }
}
}
