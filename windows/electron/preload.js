'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('cliprelay', {
  request: async (action, data) => {
    try {return await ipcRenderer.invoke('relay:request', action, data);}
    catch (error) {
      // Electron adds transport details to already user-facing host errors.
      const message = String(error?.message ?? '').replace(/^Error invoking remote method 'relay:request': (?:Error: )?/, '') || '操作失败，请重试';
      throw new Error(message);
    }
  },
  window: (action, data) => ipcRenderer.invoke('relay:window', action, data),
  onError: callback => ipcRenderer.on('relay:error', (_event,message) => callback(message)),
  onClose: callback => ipcRenderer.on('relay:closing', () => callback()),
  onRefresh: callback => {
    const listener = () => callback();
    ipcRenderer.on('relay:refresh', listener);
    return () => ipcRenderer.removeListener('relay:refresh', listener);
  }
});
