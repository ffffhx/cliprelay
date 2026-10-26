'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function load(invoke){
  let api;
  const electron={contextBridge:{exposeInMainWorld:(_name,value)=>{api=value;}},ipcRenderer:{invoke,on(){},removeListener(){}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/preload.js'),'utf8'),{require:()=>electron});
  return api;
}

test('control center preload forwards host replies unchanged',async()=>{
  const api=load(async(channel,action,data)=>({channel,action,data}));
  assert.deepEqual(JSON.parse(JSON.stringify(await api.request('snapshot',{a:1}))),{channel:'relay:request',action:'snapshot',data:{a:1}});
});

test('control center preload hides Electron IPC details from host errors',async()=>{
  const api=load(async()=>{throw new Error("Error invoking remote method 'relay:request': Error: 接收设备地址重复：192.168.0.108:47632。");});
  await assert.rejects(api.request('patch',{}),error=>{
    assert.equal(error.message,'接收设备地址重复：192.168.0.108:47632。');
    return true;
  });
});

test('control center preload keeps an empty host message usable',async()=>{
  const api=load(async()=>{throw new Error("Error invoking remote method 'relay:request': Error: ");});
  await assert.rejects(api.request('patch',{}),error=>{
    assert.equal(error.message,'操作失败，请重试');
    return true;
  });
});
