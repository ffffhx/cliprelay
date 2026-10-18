'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('cliprelayMac',{request:async(action,data)=>{
  try{return await ipcRenderer.invoke('mac:request',action,data);}
  catch(error){
    // Electron adds transport details to already user-facing host errors.
    const message=String(error?.message || '操作失败，请重试').replace(/^Error invoking remote method 'mac:request': (?:Error: )?/,'');
    throw new Error(message);
  }
}});
