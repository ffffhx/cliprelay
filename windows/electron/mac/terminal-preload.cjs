'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('cliprelayTerminal',{request:async(action,data)=>{
  try{return await ipcRenderer.invoke('terminal:request',action,data);}
  catch(error){throw new Error(String(error?.message || '操作失败，请重试').replace(/^Error invoking remote method 'terminal:request': (?:Error: )?/,''));}
}});
