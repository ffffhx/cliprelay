'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('cliprelay', {
  postMessage: value => ipcRenderer.send('share-message', value),
  onMessage: handler => ipcRenderer.on('share-message', (_event, value) => handler({data:value}))
});
