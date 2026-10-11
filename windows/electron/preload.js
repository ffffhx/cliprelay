'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('cliprelay', {
  request: (action, data) => ipcRenderer.invoke('relay:request', action, data),
  window: (action, data) => ipcRenderer.invoke('relay:window', action, data),
  onError: callback => ipcRenderer.on('relay:error', (_event,message) => callback(message)),
  onClose: callback => ipcRenderer.on('relay:closing', () => callback()),
  onRefresh: callback => {
    const listener = () => callback();
    ipcRenderer.on('relay:refresh', listener);
    return () => ipcRenderer.removeListener('relay:refresh', listener);
  }
});
