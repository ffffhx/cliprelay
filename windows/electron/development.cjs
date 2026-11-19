'use strict';
const fs = require('node:fs');
const path = require('node:path');
function readRuntime(dataRoot, root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataRoot, 'development-runtime.json'), 'utf8'));
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || path.resolve(value.root) !== path.resolve(root)) return null;
    process.kill(value.pid, 0);
    return value;
  } catch { return null; }
}
function install({app, root, source, dataRoot = app.getPath('userData')}) {
  const {BrowserWindow, Notification} = require('electron');
  const mirror = file => {
    if (!file.startsWith('electron/') || path.resolve(source) === path.resolve(root, 'electron')) return;
    const origin = path.join(root, file), destination = path.join(source, file.slice('electron/'.length));
    if (fs.existsSync(origin)) { if (fs.statSync(origin).isDirectory()) return; fs.mkdirSync(path.dirname(destination), {recursive:true}); fs.copyFileSync(origin, destination); }
    else fs.rmSync(destination, {force: true});
  };
  let timer, changedBackend = false, stopping = false;
  const pending = new Set();
  app.on('browser-window-created', (_event, window) => {
    window.on('page-title-updated', event => { event.preventDefault(); });
    window.once('ready-to-show', () => window.setTitle(`${window.getTitle()} · 开发版`));
  });
  const watcher = fs.watch(root, {recursive: true}, (_event, filename) => {
    const file = String(filename || '').replaceAll('\\', '/');
    if (stopping || /(^|\/)(?:node_modules|desktop|engine|bin|Downloads|\.tools)(\/|$)/.test(file)
      || !/\.(?:js|cjs|css|html|ps1|cs)$/.test(file)) return;
    pending.add(file); clearTimeout(timer);
    timer = setTimeout(() => {
      const onlyUi = [...pending].every(name => name.startsWith('electron/renderer/') || /electron\/mac\/.*\.(?:html|css)$/.test(name));
      for (const file of pending) mirror(file);
      pending.clear();
      if (onlyUi) {
        for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.reloadIgnoringCache();
      } else if (!changedBackend) {
        changedBackend = true;
        // Never restart a live remote-control/file-transfer connection on a save.
        const notice = new Notification({title: 'ClipRelay 开发版需要重启', body: '后台代码已修改。结束当前连接后，点击此通知重启并加载修改。'});
        notice.on('click', async () => {
          const {response} = await require('electron').dialog.showMessageBox({type: 'question', message: '重启 ClipRelay 开发版？',
            detail: '将结束当前远程连接，再从本地源码重新启动。', buttons: ['重启', '稍后'], defaultId: 1, cancelId: 1});
          if (response === 0) { app.relaunch({args: require('./lifecycle.cjs').backgroundArguments()}); app.quit(); } else changedBackend = false;
        });
        notice.show();
      }
    }, 600);
  });
  fs.mkdirSync(dataRoot, {recursive: true});
  const receipt = path.join(dataRoot, 'development-runtime.json');
  fs.writeFileSync(receipt, JSON.stringify({pid: process.pid, root: path.resolve(root), startedAt: new Date().toISOString()}));
  const close = () => {
    if (stopping) return;
    stopping = true; clearTimeout(timer); watcher.close();
    try { if (JSON.parse(fs.readFileSync(receipt, 'utf8')).pid === process.pid) fs.rmSync(receipt); } catch {}
  };
  watcher.on('error', error => { console.error('[development]', error); close(); });
  app.once('before-quit', close);
  return {close};
}
module.exports = {install, readRuntime};
