'use strict';
const {app, dialog} = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');
const {NativeHost, parseArguments} = require('./native-host.cjs');

// The distribution keeps native assets outside ASAR so Windows PowerShell 5.1
// and the existing installers can read them without extraction or duplication.
const root = app.isPackaged ? path.resolve(process.resourcesPath, '../..') : path.resolve(__dirname, '..');
if (process.platform === 'darwin') {
  require('./mac/main.cjs');
} else if (process.argv.includes('--screen-share-engine')) {
  require(path.join(root, 'screen-share', 'main.js'));
} else {
  app.setName('ClipRelay');
  app.setAppUserModelId('ClipRelay.Desktop');
  const identity = crypto.createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,16);
  app.setPath('userData', path.join(app.getPath('appData'), 'ClipRelay', 'Desktop', identity));
  let host;
  let windows;
  let quitting = false;
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    app.on('window-all-closed', () => {});
    app.on('second-instance', () => host?.open());
    app.on('before-quit', event => {
      if (host && !quitting) {
        event.preventDefault();
        quitting = true;
        host.stop();
      }
    });
    app.whenReady().then(() => {
      const options = parseArguments(process.argv.slice(app.isPackaged ? 1 : 2));
      host = new NativeHost({root, launcher: path.join(__dirname, 'launch-native.ps1'), ...options});
      const {DesktopWindows} = require('./windows.cjs');
      windows = new DesktopWindows(host, root);
      host.on('message', message => { if (message.event === 'open') windows.open(message.window); });
      host.on('ready', () => windows.refresh());
      host.on('failure', error => dialog.showErrorBox('ClipRelay', error.message));
      host.on('exit', () => { quitting = true; windows.close(); app.quit(); });
      return host.start();
    }).catch(error => {
      dialog.showErrorBox('ClipRelay', error.message);
      quitting = true;
      app.quit();
    });
  }
}
