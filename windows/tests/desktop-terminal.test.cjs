'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),https=require('node:https'),{spawn}=require('node:child_process'),{once}=require('node:events'),readline=require('node:readline');
const protocol=require('../electron/mac/terminal-protocol.cjs'),{TerminalController}=require('../electron/mac/terminal-controller.cjs'),{fault}=require('../electron/mac/paired-transport.cjs');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function remote(){
  let instance='1'.repeat(32),nextOpen=1,hook;const sessions=new Map(),calls=[],writes=[];
  const snapshot=s=>({id:s.id,shell:s.shell,state:s.state,columns:s.columns,rows:s.rows,exitCode:s.exitCode,openSequence:s.openSequence,acceptedSequence:s.acceptedSequence,writtenSequence:s.writtenSequence,start:s.start,end:s.bytes.length,remainingMs:s.state==='running'?1800000:0});
  async function request(host,identity,c,signal){
    calls.push({...c});if(hook)await hook(c,signal);
    if(c.op==='list')return {instance,nextOpen,sessions:[...sessions.values()].map(snapshot)};
    if(c.instance!==instance)throw fault('TERMINAL_STALE');let s=sessions.get(c.id);
    if(c.op==='open' && !s){assert.equal(c.sequence,nextOpen++);s={id:c.id,shell:c.shell,columns:c.columns,rows:c.rows,state:'running',exitCode:0,openSequence:c.sequence,acceptedSequence:0,writtenSequence:0,start:0,bytes:Buffer.from('ready\r\n')};sessions.set(c.id,s);}
    if(!s)throw fault('TERMINAL_NOT_FOUND');
    if(c.op==='write'){
      if(c.sequence===s.acceptedSequence)assert.equal(c.data,s.lastData);else{assert.equal(c.sequence,s.acceptedSequence+1);s.acceptedSequence=c.sequence;s.writtenSequence=c.sequence;s.lastData=c.data;writes.push({id:s.id,data:Buffer.from(c.data,'base64')});s.bytes=Buffer.concat([s.bytes,Buffer.from(c.data,'base64')]);}
    }
    if(c.op==='close')s.state='closed';if(c.op==='resize'){s.columns=c.columns;s.rows=c.rows;}
    if(c.op==='read'){const offset=Math.max(c.offset,s.start),data=s.bytes.subarray(offset,offset+32768);return {instance,session:snapshot(s),offset,next:offset+data.length,gap:offset!==c.offset,data};}
    return {instance,session:snapshot(s)};
  }
  return {sessions,calls,writes,request,get instance(){return instance;},restart(){instance='2'.repeat(32);sessions.clear();nextOpen=1;},set hook(value){hook=value;}};
}
function fixture(t,extra={}){
  const server=remote(),host={id:crypto.createHash('sha256').update(new crypto.X509Certificate(identities.host.cert).raw).digest('hex'),certificate:identities.host.cert,clientId:'a'.repeat(32),name:'Test PC',address:'127.0.0.1',port:48789,enabled:true};let time=100000;
  const store={selected:()=>host,identity:async()=>identities.client,data:{legacySelected:false}},controller=new TerminalController({store,request:server.request,now:()=>time,...extra});controller.bind();
  t.after(()=>controller.close());return {server,host,store,controller,advance:(ms=1000)=>{time+=ms;}};
}
async function poll(f){const value=await f.controller.poll();f.advance(100);return value;}
async function open(f,shell='cmd'){if(!f.controller.instance)await poll(f);assert.equal(f.controller.phase,'ready',f.controller.error);f.controller.open(shell);for(let i=0;i<5 && f.controller.pendingAction;i++)await poll(f);assert.ok(f.controller.selected);return f.controller.selected;}
function input(f,text){return f.controller.input({id:f.controller.selected,view:f.controller.view,text});}
async function drain(f){for(let i=0;i<50 && (f.controller.states.get(f.controller.selected)?.queuedBytes || f.controller.pendingAction || f.controller.needList);i++)await poll(f);}
test('multiple sessions keep independent input sequences, UTF-8 bytes and output positions',async t=>{
  const f=fixture(t),first=await open(f);input(f,'中文 😀\r');await drain(f);assert.equal(f.server.writes[0].data.toString(),'中文 😀\r');
  const initial=await poll(f);assert.equal(initial.frame.replay,false);assert.match(Buffer.from(initial.frame.data,'base64').toString(),/中文/);
  const second=await open(f,'powershell');assert.notEqual(first,second);input(f,'second\r');await drain(f);assert.equal(f.server.writes[1].id,second);
  f.controller.select(first);const replay=await poll(f);assert.equal(replay.frame.replay,true);assert.equal(f.controller.states.get(first).snapshot.acceptedSequence,1);assert.equal(f.controller.states.get(second).snapshot.acceptedSequence,1);
  assert.ok(!JSON.stringify(f.controller.snapshot()).includes('PRIVATE KEY'));assert.ok(!JSON.stringify(f.controller.snapshot()).includes('中文'));
});
test('a lost acknowledgment resends the exact command and never executes input twice',async t=>{
  const f=fixture(t),base=f.server.request;let lost=false;f.controller.request=async(...args)=>{const result=await base(...args);if(args[2].op==='write' && !lost){lost=true;throw fault('TIMEOUT');}return result;};
  await open(f);input(f,'counter++\r');await poll(f);await poll(f);assert.equal(f.controller.phase,'recovering');assert.equal(f.server.writes.length,1);
  f.advance(1000);await drain(f);assert.equal(f.server.writes.length,1);assert.equal(f.controller.states.get(f.controller.selected).pending,null);
  const requests=f.server.calls.filter(c=>c.op==='write');assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
});
test('lost open acknowledgment reuses its original session ID and sequence',async t=>{
  const f=fixture(t),base=f.server.request;let lost=false;f.controller.request=async(...args)=>{const result=await base(...args);if(args[2].op==='open' && !lost){lost=true;throw fault('TIMEOUT');}return result;};
  await poll(f);f.controller.open('cmd');await poll(f);assert.equal(f.controller.phase,'recovering');assert.equal(f.server.sessions.size,1);f.advance(1000);await drain(f);assert.equal(f.server.sessions.size,1);assert.ok(f.controller.selected);
  const opens=f.server.calls.filter(c=>c.op==='open');assert.equal(opens.length,2);assert.deepEqual(opens[0],opens[1]);
});
test('pause discards never-sent input, retains only the uncertain write, and requires explicit resume',async t=>{
  const f=fixture(t);await open(f);await drain(f);let entered=false;
  f.server.hook=async(c,signal)=>{if(c.op==='write'){entered=true;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(fault('CANCELLED')),{once:true}));}};
  input(f,'a'.repeat(8000));const pending=poll(f);while(!entered)await sleep(1);f.controller.pause();await pending;
  const state=f.controller.states.get(f.controller.selected);assert.equal(state.queuedBytes,4096);assert.ok(state.pending);const count=f.server.calls.length;await poll(f);assert.equal(f.server.calls.length,count);
  assert.throws(()=>input(f,'late'),/TERMINAL_PAUSED/);f.server.hook=null;f.controller.resume();f.advance(1000);await drain(f);assert.equal(f.server.writes.length,1);assert.equal(f.server.writes[0].data.length,4096);
});
test('switching computer and authorization revocation invalidate old input tokens',async t=>{
  const f=fixture(t);await open(f);const data={id:f.controller.selected,view:f.controller.view,text:'old'};f.host.id='f'.repeat(64);f.controller.reconcile();assert.equal(f.controller.phase,'paused');assert.throws(()=>f.controller.input(data),/TERMINAL_VIEW_CHANGED/);assert.throws(()=>f.controller.resume(),/TERMINAL_TARGET_CHANGED/);
  f.host.id=f.controller.bound.id;f.controller.resume();await poll(f);f.controller.reconcile('UNPAIRED');assert.equal(f.controller.phase,'paused');assert.throws(()=>f.controller.resume(),/UNPAIRED/);assert.equal(f.server.writes.length,0);
});

test('route replacement invalidates both queued input and an in-flight response even when a port is reused',async t=>{
  const f=fixture(t);await open(f);input(f,'never sent');let data={id:f.controller.selected,view:f.controller.view,text:'old'};
  f.host.routeId='replacement';f.controller.reconcile();assert.equal(f.controller.phase,'recovering');assert.equal(f.controller.states.get(data.id).queuedBytes,0);assert.throws(()=>f.controller.input(data),/TERMINAL_VIEW_CHANGED/);await poll(f);
  let entered=false;f.server.hook=async(c,signal)=>{if(c.op==='read'){entered=true;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(fault('CANCELLED')),{once:true}));}};
  data={id:f.controller.selected,view:f.controller.view,text:'stale'};const pending=poll(f);while(!entered)await sleep(1);f.host.routeId='another-generation';f.controller.reconcile();assert.equal((await pending).frame,undefined);assert.throws(()=>f.controller.input(data),/TERMINAL_VIEW_CHANGED/);f.server.hook=null;await poll(f);assert.equal(f.controller.phase,'ready');assert.equal(f.server.writes.length,0);
  data={id:f.controller.selected,view:f.controller.view,text:'missed notification'};f.host.routeId='not-yet-reconciled';assert.throws(()=>f.controller.input(data),/TERMINAL_VIEW_CHANGED/);
});
test('service restart clears old pending operations instead of forwarding them to the new instance',async t=>{
  const f=fixture(t);await open(f);input(f,'old');f.controller.states.get(f.controller.selected).command(f.controller.instance);f.controller.pause();f.server.restart();f.controller.resume();await poll(f);assert.equal(f.controller.selected,'');assert.equal(f.controller.states.size,0);assert.match(f.controller.notice,/重启/);assert.equal(f.server.writes.length,0);
});
test('history gaps reset the screen and suppress replies to replayed terminal queries',async t=>{
  const f=fixture(t);const id=await open(f);await drain(f);const s=f.server.sessions.get(id);s.bytes=Buffer.from('discard\x1b[6nkept');s.start=7;f.controller.select(id);const result=await poll(f);assert.equal(result.frame.gap,true);assert.equal(result.frame.replay,true);assert.equal(result.frame.data,Buffer.from('\x1b[6nkept').toString('base64'));assert.match(result.state.notice,/重置/);
});

test('new output after a replay boundary is delivered separately so live queries are answered',async t=>{
  const f=fixture(t),id=await open(f);await drain(f);f.controller.select(id);const s=f.server.sessions.get(id),old=Buffer.from(s.bytes);s.bytes=Buffer.concat([s.bytes,Buffer.from('\x1b[6n')]);
  const history=await poll(f);assert.equal(history.frame.replay,true);assert.equal(Buffer.from(history.frame.data,'base64').toString(),old.toString());
  const live=await poll(f);assert.equal(live.frame.replay,false);assert.equal(Buffer.from(live.frame.data,'base64').toString(),'\x1b[6n');
});
test('input and reply limits reject invalid UTF-8 framing metadata, mismatched IDs and changed sequence',async t=>{
  const f=fixture(t);await open(f);assert.throws(()=>input(f,'x'.repeat(16385)),/TERMINAL_BAD_REQUEST/);input(f,'x'.repeat(16384));input(f,'x'.repeat(16384));assert.throws(()=>input(f,'x'),/TERMINAL_INPUT_FULL/);
  const s={id:'a'.repeat(32),shell:'cmd',state:'running',columns:80,rows:24,exitCode:0,openSequence:1,acceptedSequence:0,writtenSequence:0,start:0,end:8,remainingMs:1};
  assert.throws(()=>protocol.validate({op:'read',instance:'b'.repeat(32),id:s.id,offset:0},{ok:true,instance:'b'.repeat(32),session:s,offset:0,next:2,gap:false,data:'eA=='}),/INVALID_RESPONSE/);
  assert.throws(()=>protocol.validate({op:'list'},{ok:true,instance:'b'.repeat(32),nextOpen:2,sessions:[s,s]}),/INVALID_RESPONSE/);
});
test('successful inventory replies do not reset a repeated failing input retry budget',async t=>{
  const f=fixture(t);await open(f);input(f,'retry');f.server.hook=async c=>{if(c.op==='write')throw fault('TIMEOUT');};
  for(let i=0;i<40 && f.controller.phase!=='error';i++){f.advance(6000);await poll(f);await poll(f);}assert.equal(f.controller.phase,'error');assert.equal(f.controller.error,'TERMINAL_RETRY_EXHAUSTED');assert.equal(f.server.writes.length,0);
});
test('pinned TLS rejects changed certificates before any terminal command is sent',async t=>{
  let seen=0;const server=https.createServer({key:identities.host.key,cert:identities.host.cert,requestCert:true,rejectUnauthorized:false},(req,res)=>{seen++;res.writeHead(503);res.end(JSON.stringify({ok:false,code:'TERMINAL_USER_REQUIRED'}));});const port=await listen(server);t.after(()=>close(server));
  const host={address:'127.0.0.1',port:port-2,certificate:identities.host.cert};await assert.rejects(protocol.request(host,identities.client,{op:'list'}),/TERMINAL_USER_REQUIRED/);
  await assert.rejects(protocol.request({...host,certificate:identities.wrong.cert},identities.client,{op:'list'}),/HOST_CERT_CHANGED/);assert.equal(seen,1);
});
test('real ConPTY over pinned mutual TLS confirms input deduplication and reconnects to a running shell',{skip:process.platform!=='win32',timeout:30000},async t=>{
  assert.ok(process.env.CLIPRELAY_TERMINAL_TEST_WORKER,'Build windows/tests/terminal.ps1 and set CLIPRELAY_TERMINAL_TEST_WORKER');
  const child=spawn(process.env.CLIPRELAY_TERMINAL_TEST_WORKER,['--terminal-probe'],{stdio:['pipe','pipe','pipe'],windowsHide:true}),reader=readline.createInterface({input:child.stdout});let pending=[],stderr='';
  reader.on('line',line=>{const next=pending.shift();if(next)next.resolve(JSON.parse(line));});child.stderr.on('data',bytes=>{stderr+=bytes;});child.on('exit',()=>{for(const next of pending.splice(0))next.reject(new Error('worker exited '+stderr));});
  t.after(async()=>{if(child.exitCode===null){const ended=once(child,'exit');child.stdin.end();await ended;}reader.close();if(stderr)t.diagnostic(stderr);});
  const rpc=command=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify(command)+'\n');});
  const owner=crypto.createHash('sha256').update(new crypto.X509Certificate(identities.client.cert).raw).digest('hex');let drop=false,chain=Promise.resolve();
  const server=https.createServer({key:identities.host.key,cert:identities.host.cert,requestCert:true,rejectUnauthorized:false},async(req,res)=>{
    try{assert.ok(req.socket.getPeerCertificate().raw.equals(new crypto.X509Certificate(identities.client.cert).raw));const chunks=[];for await(const chunk of req)chunks.push(chunk);const command=JSON.parse(Buffer.concat(chunks));
      const job=chain.then(async()=>{assert.equal((await rpc({op:'sync',owners:[owner]})).ok,true);return rpc({...command,owner});});chain=job.catch(()=>{});const reply=await job;
      if(command.op==='write' && drop){drop=false;req.socket.destroy();return;}res.writeHead(reply.ok?200:409);res.end(JSON.stringify(reply));
    }catch{res.writeHead(503);res.end(JSON.stringify({ok:false,code:'TERMINAL_UNAVAILABLE'}));}
  });const port=await listen(server);t.after(()=>close(server));const f=fixture(t,{request:protocol.request});f.host.port=port-2;
  const id=await open(f);input(f,'set CLIPRELAY_COUNT=0\r');await drain(f);drop=true;input(f,'set /a CLIPRELAY_COUNT+=1\r');await poll(f);await poll(f);f.advance(1000);await drain(f);
  input(f,'echo COUNT_IS_%CLIPRELAY_COUNT%\r');await drain(f);let output='';for(let i=0;i<100 && !output.includes('COUNT_IS_1');i++){const result=await poll(f);if(result.frame)output+=Buffer.from(result.frame.data,'base64').toString();await sleep(20);}assert.match(output,/COUNT_IS_1/);assert.ok(!output.includes('COUNT_IS_2'));
  f.controller.pause();f.controller.resume();await poll(f);assert.equal(f.controller.selected,id);input(f,'echo RECONNE^CTED_OK\r');await drain(f);
  output='';for(let i=0;i<100 && !output.includes('RECONNECTED_OK');i++){const result=await poll(f);if(result.frame)output+=Buffer.from(result.frame.data,'base64').toString();await sleep(20);}assert.match(output,/RECONNECTED_OK/);
  f.controller.end({view:f.controller.view,id});await drain(f);assert.equal(f.controller.states.get(id).snapshot.state,'closed');
  const ps=await open(f,'powershell');input(f,"Write-Output ('POWER'+'SHELL_OK')\r");await drain(f);
  output='';for(let i=0;i<150 && !output.includes('POWERSHELL_OK');i++){const result=await poll(f);if(result.frame)output+=Buffer.from(result.frame.data,'base64').toString();await sleep(20);}assert.match(output,/POWERSHELL_OK/);
  f.controller.resize({view:f.controller.view,id:ps,columns:110,rows:35});for(let i=0;i<5 && f.controller.states.get(ps).snapshot.columns!==110;i++)await poll(f);assert.equal(f.controller.states.get(ps).snapshot.columns,110);assert.equal(f.controller.states.get(ps).snapshot.rows,35);
  f.controller.end({view:f.controller.view,id:ps});await drain(f);assert.equal(f.controller.states.get(ps).snapshot.state,'closed');
});
