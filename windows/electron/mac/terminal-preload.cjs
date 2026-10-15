'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('cliprelayTerminal',{request:(action,data)=>ipcRenderer.invoke('terminal:request',action,data)});
