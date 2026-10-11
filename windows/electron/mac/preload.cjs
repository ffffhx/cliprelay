'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('cliprelayMac',{request:(action,data)=>ipcRenderer.invoke('mac:request',action,data)});
