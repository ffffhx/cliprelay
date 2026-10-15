'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),https=require('node:https');
const {once}=require('node:events'),{spawn}=require('node:child_process'),readline=require('node:readline');
const {FileController}=require('../electron/mac/file-controller.cjs'),local=require('../electron/mac/file-storage.cjs'),protocol=require('../electron/mac/file-protocol.cjs');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const {fault}=require('../electron/mac/paired-transport.cjs');
const hostId=protocol.sha(new crypto.X509Certificate(identities.host.cert).raw),window={isDestroyed:()=>false};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let i=0;i<500;i++){if(predicate())return;await wait(10);}assert.fail('condition did not settle');}
function remote(){
  const files=new Map(),jobs=new Map(),calls=[];let hook;
  async function request(host,identity,command,signal){
    calls.push({...command,hostId:host.id});if(hook){const value=await hook(command,signal);if(value)return value;}
    const c=command;if(c.op==='roots')return {roots:[{id:'downloads',name:'downloads',writable:true}]};
    if(c.op==='list')return {root:c.root,path:c.path,next:'',entries:[...files].map(([name,bytes])=>({name,directory:false,blocked:false,hidden:false,size:bytes.length,modified:0}))};
    if(c.op==='mkdir')return {ok:true};
    if(c.op.endsWith('-start') && !jobs.has(c.id)){
      const download=c.op==='download-start',bytes=download?files.get(c.name):Buffer.alloc(0);if(!bytes)throw fault('FILES_NOT_FOUND');
      jobs.set(c.id,{id:c.id,root:c.root,path:c.path,name:c.name,direction:download?'download':'upload',size:download?bytes.length:c.size,sha256:download?protocol.sha(bytes):c.sha256,offset:0,verified:0,state:download?'ready':'uploading',finalName:'',bytes});
    }
    const task=jobs.get(c.id);if(!task)throw fault('FILES_NOT_FOUND');
    if(c.op==='upload-chunk'){
      const bytes=Buffer.from(c.data,'base64');assert.equal(protocol.sha(bytes),c.sha256);assert.equal(c.offset,task.offset);task.bytes=Buffer.concat([task.bytes,bytes]);task.offset+=bytes.length;
    }
    if(c.op==='download-chunk')return {size:task.size,offset:c.offset,bytes:task.bytes.subarray(c.offset,c.offset+protocol.CHUNK)};
    if(c.op==='finish'){
      assert.equal(c.sha256,protocol.sha(task.bytes));task.state='complete';if(task.direction==='upload'){task.finalName=files.has(task.name)?'copy-'+task.name:task.name;files.set(task.finalName,Buffer.from(task.bytes));}task.verified=task.size;
    }
    if(c.op==='cancel' && task.state!=='complete')task.state='cancelled';
    return {...task,bytes:undefined};
  }
  return {files,jobs,calls,request,set hook(value){hook=value;}};
}
async function fixture(t,options={}){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'cliprelay-desktop-files-')),server=remote();
  const directory=path.join(root,'queue'),source=path.join(root,'sources'),destination=path.join(root,'downloads');await fsp.mkdir(source);await fsp.mkdir(destination);
  const host={id:hostId,certificate:identities.host.cert,clientId:'a'.repeat(32),name:'Test PC',address:'127.0.0.1',port:48789,enabled:true};
  const store={data:{legacySelected:false},selected:()=>host,identity:async()=>identities.client};let selection=[],revealed;
  const dialog={showOpenDialog:async()=>({canceled:false,filePaths:selection})},shell={showItemInFolder:file=>{revealed=file;}};
  const controllers=[];function create(extra={}){const controller=new FileController({store,directory,dialog,shell,request:server.request,pollMs:1,...options,...extra});controllers.push(controller);return controller;}
  const controller=create();t.after(async()=>{for(const c of controllers)c.close();await Promise.all(controllers.map(c=>c.running));assert.ok(root.startsWith(path.join(os.tmpdir(),'cliprelay-desktop-files-')));await fsp.rm(root,{recursive:true,force:true});});
  return {root,directory,source,destination,host,store,dialog,server,controller,create,set selection(value){selection=value;},get revealed(){return revealed;}};
}
async function upload(f,content,name='test.bin'){
  const file=path.join(f.source,name);await fsp.writeFile(file,content);f.selection=[file];await f.controller.browse();await f.controller.pick(window,'upload');return f.controller.storage.jobs.at(-1);
}
async function download(f,content,name='test.bin'){
  f.server.files.set(name,content);await f.controller.browse();f.selection=[f.destination];await f.controller.pick(window,'download',[name]);return f.controller.storage.jobs.at(-1);
}
test('uploads and downloads multiple chunks, Unicode and empty files; never overwrites an existing name',async t=>{
  const f=await fixture(t),bytes=crypto.randomBytes(protocol.CHUNK*2+137);
  const sent=await upload(f,bytes,'中文.bin');await f.controller.running;assert.equal(sent.state,'complete');assert.deepEqual(f.server.files.get('中文.bin'),bytes);
  await fsp.writeFile(path.join(f.destination,'中文.bin'),'keep');const got=await download(f,bytes,'中文.bin');await f.controller.running;assert.equal(got.state,'complete');
  assert.equal(await fsp.readFile(path.join(f.destination,'中文.bin'),'utf8'),'keep');assert.deepEqual(await fsp.readFile(path.join(f.destination,got.finalName)),bytes);
  assert.notEqual(got.finalName,'中文.bin');await f.controller.reveal(got.id);assert.equal(f.revealed,await fsp.realpath(path.join(f.destination,got.finalName)));
  const empty=await upload(f,Buffer.alloc(0),'empty');await f.controller.running;assert.equal(empty.state,'complete');
  const zero=await download(f,Buffer.alloc(0),'zero');await f.controller.running;assert.equal(zero.state,'complete');assert.equal((await fsp.stat(path.join(f.destination,'zero'))).size,0);
  const publicState=JSON.stringify(f.controller.snapshot());assert.ok(!publicState.includes('PRIVATE KEY'));assert.ok(!publicState.includes(f.source));assert.ok(!publicState.includes(identities.client.cert));
});
test('lost upload acknowledgment resumes the same remote job after restart, without duplicate bytes',async t=>{
  const f=await fixture(t),base=f.server.request;let lost=false;
  f.controller.request=async(...args)=>{const reply=await base(...args);if(args[2].op==='upload-chunk' && !lost){lost=true;throw fault('TIMEOUT');}return reply;};
  const bytes=crypto.randomBytes(protocol.CHUNK+83),task=await upload(f,bytes);await f.controller.running;assert.equal(task.state,'paused');assert.equal(task.offset,0);assert.equal(f.server.jobs.get(task.id).offset,protocol.CHUNK);
  f.controller.close();const resumed=f.create();assert.equal(resumed.storage.get(task.id).state,'paused');const before=f.server.calls.length;await wait(30);assert.equal(f.server.calls.length,before);
  await resumed.resume(task.id);await resumed.running;assert.equal(resumed.storage.get(task.id).state,'complete');assert.equal(f.server.jobs.size,1);assert.deepEqual(f.server.files.get('test.bin'),bytes);
});
test('download restart truncates an uncheckpointed tail and verifies the full file',async t=>{
  const f=await fixture(t),bytes=crypto.randomBytes(protocol.CHUNK*2+53);let calls=0;
  f.server.hook=async c=>{if(c.op==='download-chunk' && ++calls===2)throw fault('TIMEOUT');};
  const task=await download(f,bytes);await f.controller.running;assert.equal(task.offset,protocol.CHUNK);assert.equal(task.state,'paused');
  await fsp.appendFile(local.partPath(task),'uncommitted crash tail');f.controller.close();f.server.hook=null;
  const next=f.create();await next.resume(task.id);await next.running;assert.equal(next.storage.get(task.id).state,'complete');assert.deepEqual(await fsp.readFile(path.join(f.destination,'test.bin')),bytes);
});
test('publication recovery recognizes the same inode and does not produce a second file',async t=>{
  const f=await fixture(t);const data=Buffer.from('publish crash');const original=local.publish;let linked=false;
  f.controller.storage.write=(directory,file,value)=>{
    if(value.jobs.some(task=>task.state==='complete') && !linked){linked=true;throw new Error('simulated journal interruption');}
    require('../electron/mac/paired-store.cjs').atomicWrite(directory,file,value);
  };
  const task=await download(f,data);await f.controller.running;assert.equal(linked,true);assert.equal(await fsp.readFile(path.join(f.destination,'test.bin'),'utf8'),'publish crash');
  // Read the durable publishing record without calling close() on the old
  // instance; that would turn the crash into a graceful shutdown checkpoint.
  f.controller.closed=true;const next=f.create();assert.equal(next.storage.get(task.id).state,'paused');await next.resume(task.id);await next.running;
  assert.equal(next.storage.get(task.id).state,'complete');assert.deepEqual(await fsp.readdir(f.destination),['test.bin']);assert.equal(local.publish,original);
});
test('file changed or replaced between attempts stops upload before sending more data',async t=>{
  const f=await fixture(t);f.server.hook=async c=>{if(c.op==='upload-start')throw fault('TIMEOUT');};
  const task=await upload(f,Buffer.from('old'));await f.controller.running;await fsp.writeFile(task.source.file,'new');f.server.hook=null;
  await f.controller.resume(task.id);await f.controller.running;assert.equal(task.state,'paused');assert.equal(task.error,'FILES_SOURCE_CHANGED');assert.equal(f.server.jobs.size,0);
});
test('switching computers aborts an active request and leaves queued tasks paused',async t=>{
  const f=await fixture(t);let entered=false,aborted=false;
  f.server.hook=async(c,signal)=>{if(c.op==='upload-chunk'){entered=true;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(fault('CANCELLED'));},{once:true}));}};
  const task=await upload(f,crypto.randomBytes(protocol.CHUNK+1));await until(()=>entered);f.host.id='b'.repeat(64);f.controller.reconcile();await f.controller.running;
  assert.equal(aborted,true);assert.equal(task.state,'paused');await assert.rejects(f.controller.resume(task.id),/FILES_TARGET_CHANGED/);const before=f.server.calls.length;
  f.host.id=hostId;f.controller.reconcile();await wait(30);assert.equal(f.server.calls.length,before);
});
test('a late native dialog answer cannot queue files to a changed target or closed window',async t=>{
  const f=await fixture(t),file=path.join(f.source,'secret.txt');await fsp.writeFile(file,'secret');await f.controller.browse();let answer;
  f.dialog.showOpenDialog=()=>new Promise(resolve=>{answer=resolve;});const pending=f.controller.pick(window,'upload');await until(()=>answer);
  f.host.id='b'.repeat(64);f.controller.reconcile();answer({canceled:false,filePaths:[file]});await assert.rejects(pending,/CANCELLED/);assert.equal(f.controller.storage.jobs.length,0);
});
test('cancellation remains pending while offline and confirms cleanup on an explicit retry',async t=>{
  const f=await fixture(t);f.server.hook=async c=>{if(c.op==='upload-chunk')throw fault('TIMEOUT');};
  const task=await upload(f,Buffer.from('cancel me'));await f.controller.running;f.server.hook=async c=>{if(c.op==='cancel')throw fault('TIMEOUT');};
  f.controller.cancel(task.id);await f.controller.running;assert.equal(task.state,'cancel-pending');assert.equal(f.server.jobs.get(task.id).state,'uploading');
  await assert.rejects(f.controller.forget(task.id),/FILES_INVALID_STATE/);f.server.hook=null;await f.controller.resume(task.id);await f.controller.running;assert.equal(task.state,'cancelled');assert.equal(f.server.jobs.get(task.id).state,'cancelled');
  await f.controller.forget(task.id);assert.equal(f.controller.storage.jobs.length,0);
});
test('a partial local file replaced by an unrelated inode is never truncated or deleted',async t=>{
  const f=await fixture(t),bytes=crypto.randomBytes(protocol.CHUNK+1);let reads=0;f.server.hook=async c=>{if(c.op==='download-chunk' && ++reads===2)throw fault('TIMEOUT');};
  const task=await download(f,bytes);await f.controller.running;const part=local.partPath(task),saved=part+'.original';await fsp.rename(part,saved);await fsp.writeFile(part,'unrelated');
  f.server.hook=null;await f.controller.resume(task.id);await f.controller.running;assert.equal(task.error,'FILES_DESTINATION_CHANGED');assert.equal(await fsp.readFile(part,'utf8'),'unrelated');
  f.controller.cancel(task.id);await f.controller.running;assert.equal(task.state,'cancel-pending');assert.equal(await fsp.readFile(part,'utf8'),'unrelated');
});
test('directory replacement, symlinks, traversal, reserved names and malformed replies fail closed',async t=>{
  const f=await fixture(t);for(const name of ['..','a/b','a\\b','NUL.txt','trailing.','.cliprelay-hidden'])assert.throws(()=>protocol.safeName(name));
  assert.throws(()=>protocol.location('downloads','safe/../bad'));
  const dest=await local.destination(f.destination);await fsp.rename(f.destination,f.destination+'-original');await fsp.mkdir(f.destination);await assert.rejects(local.directoryFor({destination:dest}),/FILES_DESTINATION_CHANGED/);
  assert.throws(()=>protocol.validateReply({op:'download-chunk',id:'a'.repeat(32),offset:0},{ok:true,id:'a'.repeat(32),offset:0,size:1,data:'eA==',sha256:'0'.repeat(64)}),/FILES_HASH_MISMATCH/);
  const listed=protocol.validateReply({op:'list',root:'downloads',path:''},{ok:true,root:'downloads',entries:[{name:'too-long-'.repeat(40),directory:false,blocked:false,hidden:false,size:1,modified:0}]});assert.equal(listed.entries[0].blocked,true);
  if(process.platform!=='win32'){const file=path.join(f.source,'real');await fsp.writeFile(file,'x');const link=file+'-link';await fsp.symlink(file,link);await assert.rejects(local.source(link),/FILES_LINK_NOT_ALLOWED/);}
});
test('partial transfer with corrupted bytes never publishes a destination file',async t=>{
  const f=await fixture(t),base=f.server.request;
  f.controller.request=async(...args)=>{const reply=await base(...args);if(args[2].op==='download-chunk')reply.bytes=Buffer.alloc(reply.bytes.length,0);return reply;};
  const task=await download(f,Buffer.from('expected'));await f.controller.running;assert.equal(task.state,'paused');assert.equal(task.error,'FILES_HASH_MISMATCH');await assert.rejects(fsp.stat(path.join(f.destination,'test.bin')),{code:'ENOENT'});
});
test('private journal rejects invalid bindings, duplicate IDs and renderer-provided local paths',async t=>{
  const f=await fixture(t);await f.controller.browse();await assert.rejects(f.controller.pick(window,'download',['../secret']),/FILES_BAD_PATH/);
  const task=await upload(f,Buffer.from('x'));await f.controller.running;const value=JSON.parse(await fsp.readFile(path.join(f.directory,'queue.json')));value.jobs[0].identity='invalid';await fsp.writeFile(path.join(f.directory,'queue.json'),JSON.stringify(value));assert.throws(()=>new local.FileStorage(f.directory),/INVALID_PRIVATE_STORAGE/);
  value.jobs[0].identity=task.identity;value.jobs.push(value.jobs[0]);await fsp.writeFile(path.join(f.directory,'queue.json'),JSON.stringify(value));assert.throws(()=>new local.FileStorage(f.directory),/INVALID_PRIVATE_STORAGE/);
});
test('native picker batches files and directory navigation uses bounded server cursors',async t=>{
  const f=await fixture(t),names=['first.txt','second.txt','third.txt'];
  for(const name of names)await fsp.writeFile(path.join(f.source,name),name);f.selection=names.map(name=>path.join(f.source,name));await f.controller.browse();await f.controller.pick(window,'upload');await f.controller.running;
  assert.equal(f.controller.storage.jobs.length,3);assert.ok(f.controller.storage.jobs.every(task=>task.state==='complete'));for(const name of names)assert.equal(f.server.files.get(name).toString(),name);
  const entry=name=>({name,directory:false,blocked:false,hidden:false,size:1,modified:0});
  f.server.hook=async c=>c.op==='list'?{root:c.root,path:c.path,entries:[entry(c.after?'page-two':'page-one')],next:c.after?'':'1:page-one'}:undefined;
  await f.controller.browse('downloads','');await f.controller.browse('downloads','',true);assert.deepEqual(f.controller.browser.entries.map(entry=>entry.name),['page-one','page-two']);assert.equal(f.controller.browser.next,'');
  await f.controller.mkdir('folder');assert.ok(f.server.calls.some(c=>c.op==='mkdir' && c.name==='folder' && c.path===''));
});
test('identity replacement and revoked pairing prevent a paused transfer from resuming',async t=>{
  const f=await fixture(t);f.server.hook=async c=>{if(c.op==='upload-start')throw fault('TIMEOUT');};const task=await upload(f,Buffer.from('bound'));await f.controller.running;const before=f.server.calls.length;
  f.store.identity=async()=>identities.wrong;await assert.rejects(f.controller.resume(task.id),/FILES_TARGET_CHANGED/);assert.equal(f.server.calls.length,before);
  f.store.identity=async()=>identities.client;f.controller.reconcile('UNPAIRED');await assert.rejects(f.controller.resume(task.id),/UNPAIRED/);assert.equal(f.server.calls.length,before);
});
test('cancelling after a lost completion acknowledgment retains the already uploaded file',async t=>{
  const f=await fixture(t),base=f.server.request;let lost=false;f.controller.request=async(...args)=>{const reply=await base(...args);if(args[2].op==='finish' && !lost){lost=true;throw fault('TIMEOUT');}return reply;};
  const task=await upload(f,Buffer.from('already published'));await f.controller.running;assert.equal(task.state,'paused');f.controller.cancel(task.id);await f.controller.running;assert.equal(task.state,'complete');assert.equal(f.server.files.get('test.bin').toString(),'already published');
});
test('cancelling after a publication crash reports the existing download as complete',async t=>{
  const f=await fixture(t);let interrupted=false;f.controller.storage.write=(directory,file,value)=>{if(value.jobs.some(task=>task.state==='complete') && !interrupted){interrupted=true;throw new Error('simulated crash');}require('../electron/mac/paired-store.cjs').atomicWrite(directory,file,value);};
  const task=await download(f,Buffer.from('published'));await f.controller.running;f.controller.closed=true;
  const next=f.create();next.cancel(task.id);await next.running;assert.equal(next.storage.get(task.id).state,'complete');assert.deepEqual(await fsp.readdir(f.destination),['test.bin']);
});
test('closing the owner window discards the native picker result',async t=>{
  const f=await fixture(t);await f.controller.browse();let answer;f.dialog.showOpenDialog=()=>new Promise(resolve=>{answer=resolve;});const pending=f.controller.pick(window,'upload');await until(()=>answer);f.controller.releaseWindow();answer({canceled:false,filePaths:[path.join(f.source,'not-read')]});await assert.rejects(pending,/CANCELLED/);assert.equal(f.controller.storage.jobs.length,0);
});
test('file transport pins TLS before sending a command and preserves bounded protocol errors',async t=>{
  let seen=0;const server=https.createServer({key:identities.host.key,cert:identities.host.cert,requestCert:true,rejectUnauthorized:false},async(req,res)=>{
    assert.ok(req.socket.getPeerCertificate().raw.equals(new crypto.X509Certificate(identities.client.cert).raw));seen++;
    const chunks=[];for await(const data of req)chunks.push(data);assert.equal(JSON.parse(Buffer.concat(chunks)).op,'roots');res.writeHead(409);res.end(JSON.stringify({ok:false,code:'FILES_DISK_FULL'}));
  });const port=await listen(server);t.after(()=>close(server));const host={address:'127.0.0.1',port:port-2,certificate:identities.host.cert};
  await assert.rejects(protocol.request(host,identities.client,{op:'roots'}),/FILES_DISK_FULL/);assert.equal(seen,1);
  await assert.rejects(protocol.request({...host,certificate:identities.wrong.cert},identities.client,{op:'roots'}),/HOST_CERT_CHANGED/);assert.equal(seen,1);
});
test('actual C# worker interoperates through pinned mutual TLS, resumes and publishes without overwrite',{skip:process.platform!=='win32'},async t=>{
  assert.ok(process.env.CLIPRELAY_TEST_FILE_WORKER,'Build windows/tests/file-transfer.ps1 -TestWorkerOutput and set CLIPRELAY_TEST_FILE_WORKER');
  const f=await fixture(t),root=path.join(f.root,'native');await fsp.mkdir(root);await fsp.mkdir(path.join(root,'files'));let child,reader,pending=[],stderr='';
  function start(){child=spawn(process.env.CLIPRELAY_TEST_FILE_WORKER,['--file-probe'],{windowsHide:true,env:{...process.env,CLIPRELAY_TEST_FILE_ROOT:root},stdio:['pipe','pipe','pipe']});reader=readline.createInterface({input:child.stdout});reader.on('line',line=>{const next=pending.shift();if(next)next.resolve(JSON.parse(line));});child.stderr.on('data',bytes=>{stderr+=bytes;});child.on('exit',()=>{for(const next of pending.splice(0))next.reject(new Error('worker stopped '+stderr));});}
  async function stop(){const done=once(child,'exit');child.stdin.end();await done;reader.close();}
  start();t.after(async()=>{if(child.exitCode===null)await stop();});const owner=protocol.sha(new crypto.X509Certificate(identities.client.cert).raw);
  const invoke=command=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write('files:'+JSON.stringify({...command,owner})+'\n');});
  let drop=true;const server=https.createServer({key:identities.host.key,cert:identities.host.cert,requestCert:true,rejectUnauthorized:false},async(req,res)=>{
    try{assert.ok(req.socket.getPeerCertificate().raw.equals(new crypto.X509Certificate(identities.client.cert).raw));const chunks=[];for await(const chunk of req)chunks.push(chunk);const command=JSON.parse(Buffer.concat(chunks));const reply=await invoke(command);
      // Mimic Go's omitempty encoding of the real worker response.
      for(const key of ['path','directory','sha256','data','finalName','code'])if(reply[key]==='')delete reply[key];
      if(command.op==='upload-chunk' && drop){drop=false;req.socket.destroy();return;}res.writeHead(reply.ok?200:409);res.end(JSON.stringify(reply));
    }catch(error){res.writeHead(503);res.end(JSON.stringify({ok:false,code:'FILES_UNAVAILABLE'}));}
  });const port=await listen(server);t.after(()=>close(server));f.host.port=port-2;f.controller.request=protocol.request;
  const bytes=crypto.randomBytes(protocol.CHUNK+500),task=await upload(f,bytes,'互通.bin');await f.controller.running;assert.equal(task.state,'paused');assert.equal(task.offset,0);
  await stop();start();await f.controller.resume(task.id);await f.controller.running;assert.equal(task.state,'complete',JSON.stringify(f.controller.snapshot()));assert.deepEqual(await fsp.readFile(path.join(root,'files','互通.bin')),bytes);
  await f.controller.browse();f.selection=[f.destination];await fsp.writeFile(path.join(f.destination,'互通.bin'),'existing');await f.controller.pick(window,'download',['互通.bin']);await f.controller.running;
  const received=f.controller.storage.jobs.at(-1);assert.equal(received.state,'complete',JSON.stringify(f.controller.snapshot()));assert.deepEqual(await fsp.readFile(path.join(f.destination,received.finalName)),bytes);assert.equal(await fsp.readFile(path.join(f.destination,'互通.bin'),'utf8'),'existing');
});
