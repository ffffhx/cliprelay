'use strict';
// Disposable CI client. Actual controller, storage, certificate pinning and file
// protocol are used; only the native picker and lost-ACK boundary are fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const readline=require('node:readline');
const appDirectory=process.argv[2]||path.resolve(__dirname,'../windows/electron/mac');
const {FileController}=require(path.join(appDirectory,'file-controller.cjs'));
const protocol=require(path.join(appDirectory,'file-protocol.cjs'));
const {fault}=require(path.join(appDirectory,'paired-transport.cjs'));
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity}),input=lines[Symbol.asyncIterator]();
async function read(){const value=await input.next();assert.equal(value.done,false);return JSON.parse(value.value);}
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
async function main(){
  const config=await read(),identity={cert:config.cert,key:config.key};
  const host={id:protocol.sha(new crypto.X509Certificate(config.cert).raw),certificate:config.cert,clientId:'a'.repeat(32),name:'CI Mac',address:'127.0.0.1',port:48789,enabled:true};
  const store={data:{legacySelected:false},selected:()=>host,identity:async()=>identity};
  const sources=path.join(config.local,'sources'),destination=path.join(config.local,'downloads'),queue=path.join(config.local,'queue');
  await fs.mkdir(sources);await fs.mkdir(destination);
  const content=crypto.randomBytes(protocol.CHUNK+517),name='fixture.bin',file=path.join(sources,name);
  await fs.writeFile(file,content);let selection=[file],lost=false;
  const options={store,directory:queue,dialog:{showOpenDialog:async()=>({canceled:false,filePaths:selection})},shell:{showItemInFolder:()=>{}},pollMs:20};
  let controller=new FileController({...options,request:async(...args)=>{
    const reply=await protocol.request(...args);
    if(args[2].op==='upload-chunk'&&!lost){lost=true;throw fault('TIMEOUT');}return reply;
  }});
  const window={isDestroyed:()=>false};
  try{
    await controller.browse('home',config.remote);await controller.pick(window,'upload');await controller.running;
    const task=controller.storage.jobs.at(-1);assert.equal(task.state,'paused');assert.equal(task.offset,0);
    const remote=await protocol.request(host,identity,{op:'status',id:task.id});assert.equal(remote.offset,protocol.CHUNK);
    controller.close();emit({stage:'paused',id:task.id,size:content.length,sha256:protocol.sha(content),offset:remote.offset});
    assert.deepEqual(await read(),{op:'resume'});controller=new FileController(options);
    assert.equal(controller.storage.get(task.id).state,'paused');await controller.resume(task.id);await controller.running;
    const completed=controller.storage.get(task.id);assert.equal(completed.state,'complete');assert.notEqual(completed.finalName,name);
    await controller.browse('home',config.remote);
    await fs.writeFile(path.join(destination,completed.finalName),'preserved local file');selection=[destination];
    await controller.pick(window,'download',[completed.finalName]);await controller.running;
    const downloaded=controller.storage.jobs.at(-1);assert.equal(downloaded.state,'complete');assert.notEqual(downloaded.finalName,completed.finalName);
    assert.equal(await fs.readFile(path.join(destination,completed.finalName),'utf8'),'preserved local file');
    assert.deepEqual(await fs.readFile(path.join(destination,downloaded.finalName)),content);
    await controller.mkdir('created-directory');
    emit({stage:'complete',id:completed.id,finalName:completed.finalName,size:content.length,sha256:protocol.sha(content),downloadId:downloaded.id});
  }finally{controller.close();await controller.running;lines.close();process.stdin.destroy();await input.return();}
}
main().catch(error=>{process.stderr.write(String(error.stack)+'\n');process.exitCode=1;});
