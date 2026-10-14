'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events');
const net=require('node:net');
const {NativeHost,parseArguments,readAgentDebugPort}=require('../electron/native-host.cjs');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(options={}){
  const children=[],launches=[];const host=new NativeHost({root:__dirname,launcher:'launch-native.ps1',...options,spawnProcess:(exe,args,settings)=>{const child=new EventEmitter();children.push(child);launches.push({exe,args,settings});return child;}});
  host.on('failure',()=>{});await host.start();
  const socket=net.connect('\\\\.\\pipe\\'+host.pipeName);socket.setEncoding('utf8');await once(socket,'connect');await turn();
  return {host,socket,children,launches};
}
test('startup options validate ports and keep peer strings out of shell syntax',()=>{
  assert.deepEqual(parseArguments(['--background','--port','47931','--peer','phone.local','--open-settings']),{openSettings:true,port:47931,peer:'phone.local'});
  for(const args of [['--port','0'],['--port','65536'],['--port','bad'],['--peer','x" -File evil'],['--unknown']])assert.throws(()=>parseArguments(args));
});
test('Electron Agent switches preserve native options and reject invalid endpoints',()=>{
  assert.deepEqual(parseArguments(['--remote-debugging-port=9337','--remote-debugging-address=127.0.0.1','--open-settings','--port','47632']),{openSettings:true,port:47632});
  for(const arg of ['--remote-debugging-port=0','--remote-debugging-port=1023','--remote-debugging-port=65536','--remote-debugging-port=bad','--remote-debugging-address=0.0.0.0'])assert.throws(()=>parseArguments([arg]));
});
test('persisted Agent debugging is opt-in and requires a numeric local port',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-agent-config-'));
  const file=path.join(root,'desktop-agent.json');
  try {
    assert.equal(readAgentDebugPort(root),0);
    for(const port of [0,9337,65535]){fs.writeFileSync(file,'\uFEFF'+JSON.stringify({debugPort:port}));assert.equal(readAgentDebugPort(root),port);}
    for(const port of ['9337',null,-1,1023,65536,9337.5]){fs.writeFileSync(file,JSON.stringify({debugPort:port}));assert.throws(()=>readAgentDebugPort(root),/Invalid Agent debug port/);}
    fs.writeFileSync(file,'not json');assert.throws(()=>readAgentDebugPort(root));
  } finally {if(fs.existsSync(file))fs.unlinkSync(file);fs.rmdirSync(root);}
});
test('host queues open until ready and correlates fragmented RPC responses',{skip:process.platform!=='win32'},async()=>{
  const {host,socket,children,launches}=await fixture({openSettings:true});
  try{
    const opened=once(socket,'data');socket.write('rea');socket.write('dy\n');assert.equal((await opened)[0],'open\n');
    assert.ok(launches[0].exe.endsWith('WindowsPowerShell\\v1.0\\powershell.exe'));
    assert.ok(launches[0].args.includes('-STA'));assert.equal(launches[0].settings.windowsHide,true);
    const sent=once(socket,'data');const response=host.request('snapshot');const message=JSON.parse((await sent)[0]);
    const reply=JSON.stringify({id:message.id,ok:true,data:{port:47931}})+'\n';socket.write(reply.slice(0,10));socket.write(reply.slice(10));assert.deepEqual(await response,{port:47931});
    const failed=once(socket,'data');const pending=host.request('patch',{});const rejected=assert.rejects(pending,/invalid/);socket.write(JSON.stringify({id:JSON.parse((await failed)[0]).id,ok:false,error:'invalid'})+'\n');await rejected;
  }finally{socket.destroy();children[0].emit('exit',0);}
});
test('settings restart waits for native exit and drops first-launch overrides',{skip:process.platform!=='win32'},async()=>{
  const {host,socket,children,launches}=await fixture({port:47931,peer:'phone.local'});
  socket.write('ready\nrestart\n');await turn();await new Promise(resolve=>setTimeout(resolve,10));
  children[0].emit('exit',0);assert.equal(children.length,2);
  assert.ok(!launches[1].args.includes('-Port'));assert.ok(!launches[1].args.includes('-Peer'));
  const exited=once(host,'exit');host.stop();children[1].emit('exit',0);await exited;
});
test('normal exit does not restart and host stop asks native engine to quit',{skip:process.platform!=='win32'},async()=>{
  const {host,socket,children}=await fixture();const ready=once(host,'ready');socket.write('ready\n');await ready;
  const message=once(socket,'data');host.stop();assert.equal((await message)[0],'quit\n');
  const exited=once(host,'exit');children[0].emit('exit',0);await exited;assert.equal(children.length,1);
});
test('a restart marker queued after process exit is drained before shutdown',{skip:process.platform!=='win32'},async()=>{
  const {host,socket,children}=await fixture();const ready=once(host,'ready');socket.write('ready\n');await ready;
  children[0].emit('exit',0);socket.end('restart\n');
  const deadline=Date.now()+2000;while(children.length<2 && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(children.length,2);host.stop();children[1].emit('exit',0);
});
