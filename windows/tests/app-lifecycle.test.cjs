const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {serve,requestApp}=require('../electron/lifecycle.cjs');
const {readRuntime}=require('../electron/development.cjs');
test('restart preserves the development source but does not reopen the control center',()=>{
  assert.deepEqual(require('../electron/lifecycle.cjs').backgroundArguments(['ClipRelay','--open-settings','--development-root=C:/src/electron','--background']),['--development-root=C:/src/electron','--background']);
});
test('real local IPC authenticates lifecycle calls and only schedules one graceful operation',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clip-lifecycle-'));
  let server;const calls=[];
  try{
    server=await serve({directory,status:()=>({channel:'development'}),request:method=>calls.push(method)});
    assert.equal((await requestApp('status',{directory})).pid,process.pid);
    await assert.rejects(requestApp('quit',{directory,token:'wrong'}),/UNAUTHORIZED/);
    assert.deepEqual(calls,[]);
    const result=await requestApp('restart',{directory});
    assert.equal(result.accepted,true);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(calls,['restart']);
    await assert.rejects(requestApp('quit',{directory}),/SHUTTING_DOWN/);
    assert.equal((await requestApp('status',{directory})).channel,'development');
    await server.close();
    await assert.rejects(requestApp('status',{directory}),/not running/);
  }finally{await server?.close();await fs.rm(directory,{recursive:true,force:true});}
});
test('development receipt requires the live process and the exact source checkout',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clip-development-'));
  try{
    assert.equal(readRuntime(directory,directory),null);
    await fs.writeFile(path.join(directory,'development-runtime.json'),JSON.stringify({pid:process.pid,root:directory}));
    assert.equal(readRuntime(directory,directory).pid,process.pid);
    assert.equal(readRuntime(directory,path.join(directory,'different')),null);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
