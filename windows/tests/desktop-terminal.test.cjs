'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),https=require('node:https'),{spawn}=require('node:child_process'),{once}=require('node:events'),readline=require('node:readline');
const protocol=require('../electron/mac/terminal-protocol.cjs'),{TerminalController}=require('../electron/mac/terminal-controller.cjs'),{fault}=require('../electron/mac/paired-transport.cjs');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function remote(){
  let instance='1'.repeat(32),nextOpen=1,hook,mouseProtocol=0;const sessions=new Map(),calls=[],writes=[];
  const snapshot=s=>({id:s.id,shell:s.shell,state:s.state,columns:s.columns,rows:s.rows,exitCode:s.exitCode,openSequence:s.openSequence,acceptedSequence:s.acceptedSequence,writtenSequence:s.writtenSequence,start:s.start,end:s.bytes.length,remainingMs:s.state==='running'?1800000:0,...(s.mouse?{mouse:{...s.mouse}}:{})});
  async function request(host,identity,c,signal){
    calls.push({...c});if(hook)await hook(c,signal);
    if(c.op==='list')return {instance,nextOpen,pasteLimit:16396,mouseProtocol,sessions:[...sessions.values()].map(snapshot)};
    if(c.instance!==instance)throw fault('TERMINAL_STALE');let s=sessions.get(c.id);
    if(c.op==='open' && !s){assert.equal(c.sequence,nextOpen++);s={id:c.id,shell:c.shell,columns:c.columns,rows:c.rows,state:'running',exitCode:0,openSequence:c.sequence,acceptedSequence:0,writtenSequence:0,start:0,bytes:Buffer.from('ready\r\n')};sessions.set(c.id,s);}
    if(!s)throw fault('TERMINAL_NOT_FOUND');
    if(c.op==='mouse'){
      const m=s.mouse;assert.equal(c.sequence,m.acceptedSequence+1);assert.equal(c.epoch,m.epoch);m.acceptedSequence=c.sequence;m.writtenSequence=c.sequence;m.outcome='written';
      if(c.action==='press'){m.gesture=c.gesture;m.nextGesture=c.gesture+1;m.buttons|=1<<c.button;}
      if(c.action==='release')m.buttons&=~(1<<c.button);if(c.action==='cancel')m.buttons=0;
      m.remainingMs=m.buttons?1500:0;m.phase=m.buttons?'held':c.action==='cancel'?'cancelled':'idle';
    }
    if(c.op==='write' || c.op==='paste'){
      if(c.sequence===s.acceptedSequence)assert.equal(c.data,s.lastData);else{assert.equal(c.sequence,s.acceptedSequence+1);s.acceptedSequence=c.sequence;s.writtenSequence=c.sequence;s.lastData=c.data;writes.push({id:s.id,data:Buffer.from(c.data,'base64')});s.bytes=Buffer.concat([s.bytes,Buffer.from(c.data,'base64')]);}
    }
    if(c.op==='close')s.state='closed';if(c.op==='resize'){s.columns=c.columns;s.rows=c.rows;}
    if(c.op==='read'){const offset=Math.max(c.offset,s.start),data=s.bytes.subarray(offset,offset+32768);return {instance,session:snapshot(s),offset,next:offset+data.length,gap:offset!==c.offset,data};}
    return {instance,session:snapshot(s)};
  }
  return {sessions,calls,writes,request,get instance(){return instance;},restart(){instance='2'.repeat(32);sessions.clear();nextOpen=1;},set hook(value){hook=value;},enableMouse(){mouseProtocol=1;for(const s of sessions.values())s.mouse={mode:1002,format:1006,epoch:1,offset:0,buttons:0,remainingMs:0,gesture:0,nextGesture:1,acceptedSequence:0,writtenSequence:0,phase:'idle',outcome:'none'};}};
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

test('host shell inventory preserves legacy Windows and restricts Mac session creation',async t=>{
  const legacy=fixture(t);await poll(legacy);assert.deepEqual(legacy.controller.snapshot().shells,['powershell','cmd']);
  const f=fixture(t),base=f.controller.request;
  f.controller.request=async(...args)=>{const reply=await base(...args);return args[2].op==='list'?{...reply,shells:['zsh','bash']}:reply;};
  await poll(f);assert.deepEqual(f.controller.snapshot().shells,['zsh','bash']);
  assert.throws(()=>f.controller.open('powershell'),/BAD_REQUEST/);assert.equal(f.server.sessions.size,0);
  const first=await open(f,'zsh'),second=await open(f,'bash');assert.notEqual(first,second);
  f.controller.snapshot().shells.push('cmd');assert.throws(()=>f.controller.open('cmd'),/BAD_REQUEST/);
  assert.deepEqual([...f.server.sessions.values()].map(s=>s.shell),['zsh','bash']);
});

test('malformed or unadvertised shells cannot be accepted as legacy Windows',()=>{
  const value={ok:true,instance:'1'.repeat(32),nextOpen:2,sessions:[]};
  for(const shells of [null,[],['zsh','zsh'],['/bin/zsh'],['zsh','fish'],[1],{zsh:true}])assert.throws(()=>protocol.validate({op:'list'},{...value,shells}),/INVALID_RESPONSE/);
  const s={id:'a'.repeat(32),shell:'zsh',state:'running',columns:80,rows:24,exitCode:0,openSequence:1,acceptedSequence:0,writtenSequence:0,start:0,end:0,remainingMs:1};
  assert.throws(()=>protocol.validate({op:'list'},{...value,sessions:[s]}),/INVALID_RESPONSE/);
  assert.equal(protocol.validate({op:'list'},{...value,shells:['zsh','bash'],sessions:[s]}).sessions[0].shell,'zsh');
  assert.throws(()=>protocol.validate({op:'list'},{...value,shells:['bash'],sessions:[s]}),/INVALID_RESPONSE/);
});

test('a changed inventory stops an uncertain open before it can be resent',async t=>{
  const f=fixture(t),base=f.controller.request;let changed=false;
  f.controller.request=async(...args)=>{const reply=await base(...args);return args[2].op==='list'?{...reply,shells:changed?['bash']:['zsh']}:reply;};
  await poll(f);f.controller.open('zsh');changed=true;f.controller.needList=true;await poll(f);
  assert.equal(f.controller.phase,'error');assert.equal(f.controller.error,'TERMINAL_INVALID_RESPONSE');assert.equal(f.server.calls.filter(c=>c.op==='open').length,0);
});
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
test('reviewed paste retains the entire frame through pause, uncertain acknowledgment and deduplication',async t=>{
  const f=fixture(t);await open(f);await drain(f);let entered=false,accepted;
  const base=f.controller.request;f.controller.request=async(...args)=>{const reply=await base(...args);if(args[2].op==='paste' && !entered){entered=true;accepted=reply;await new Promise((resolve,reject)=>args[3].addEventListener('abort',()=>reject(fault('CANCELLED')),{once:true}));}return reply;};
  const draft=f.controller.beginPaste({view:f.controller.view,id:f.controller.selected},'文'.repeat(5000));
  f.controller.submitPaste({...draft,bracketed:true});const pending=poll(f);while(!entered)await sleep(1);f.controller.pause();await pending;
  const current=f.controller.states.get(f.controller.selected);assert.equal(current.queuedBytes,15012);assert.equal(f.server.writes.length,1);assert.match(f.server.writes[0].data.toString(),/^\x1b\[200~文+\x1b\[201~$/);
  assert.equal(accepted.session.acceptedSequence,1);f.controller.resume();await drain(f);assert.equal(f.server.writes.length,1);assert.equal(current.queuedBytes,0);
  const requests=f.server.calls.filter(c=>c.op==='paste');assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
});
test('paste preview is editable, sanitized, single-use and bound to the active view',async t=>{
  const f=fixture(t);await open(f);const view={view:f.controller.view,id:f.controller.selected};
  let draft=f.controller.beginPaste(view,'echo a\r\n\x1b\x00\x9b');assert.equal(draft.text,'echo a\n');assert.equal(draft.changed,true);assert.equal(f.server.writes.length,0);
  let result=f.controller.submitPaste({...draft,text:'new\r\n\x1b',bracketed:true});assert.equal(result.review,true);assert.equal(result.text,'new\n');assert.equal(f.controller.states.get(view.id).queuedBytes,0);
  result=f.controller.submitPaste({...draft,text:result.text,bracketed:true});assert.equal(result.sent,true);assert.throws(()=>f.controller.submitPaste({...draft,bracketed:true}),/PASTE_CHANGED/);
  draft=f.controller.beginPaste(view,'old');f.controller.pause();assert.throws(()=>f.controller.submitPaste({...draft,bracketed:false}),/VIEW_CHANGED/);
  f.controller.resume();await poll(f);draft=f.controller.beginPaste({view:f.controller.view,id:view.id},'old');f.controller.failure(fault('TIMEOUT'));f.advance();await poll(f);assert.throws(()=>f.controller.submitPaste({...draft,bracketed:false}),/PASTE_CHANGED/);
  assert.throws(()=>protocol.preparePaste('\ud800'),/BAD_REQUEST/);assert.throws(()=>protocol.preparePaste('文'.repeat(5462)),/PASTE_LIMIT/);assert.throws(()=>protocol.preparePaste('\x00'),/PASTE_EMPTY/);
});
test('old hosts use one bounded write and queue saturation never accepts a paste prefix',async t=>{
  const f=fixture(t);await open(f);const view={view:f.controller.view,id:f.controller.selected};f.controller.pasteLimit=0;
  let draft=f.controller.beginPaste(view,'x'.repeat(4085));assert.throws(()=>f.controller.submitPaste({...draft,bracketed:true}),/PASTE_HOST/);assert.equal(f.controller.states.get(view.id).queuedBytes,0);
  f.controller.submitPaste({...draft,text:'x'.repeat(4084),bracketed:true});let current=f.controller.states.get(view.id);assert.equal(current.command(f.controller.instance).op,'write');assert.equal(current.queuedBytes,4096);
  f.controller.pasteLimit=16396;draft=f.controller.beginPaste(view,'x'.repeat(16384));f.controller.submitPaste({...draft,bracketed:true});draft=f.controller.beginPaste(view,'x'.repeat(16384));assert.throws(()=>f.controller.submitPaste({...draft,bracketed:true}),/INPUT_FULL/);assert.equal(current.queuedBytes,20492);assert.equal(current.queue.length,2);assert.equal(f.controller.pasteDraft.token,draft.token);
  assert.equal(protocol.validate({op:'list'},{ok:true,instance:f.controller.instance,nextOpen:1}).pasteLimit,0);assert.throws(()=>protocol.validate({op:'list'},{ok:true,instance:f.controller.instance,nextOpen:1,pasteLimit:999999}),/INVALID_RESPONSE/);
});
async function mouseFixture(t){const f=fixture(t);await open(f);await drain(f);f.server.enableMouse();f.controller.needList=true;await f.controller.poll();return f;}
function mouseEvent(f,action,extra={}){const c=f.controller,s=c.states.get(c.selected).snapshot;return c.mouse({view:c.view,id:c.selected,epoch:s.mouse.epoch,revision:c.snapshot().mouse.revision,action,column:5,row:7,button:0,modifiers:0,...extra});}
async function mousePoll(f){const result=await f.controller.poll();f.advance(16);if(result.frame)f.controller.parsed({view:result.frame.view,id:result.state.selected,token:result.frame.token});return result;}
test('mouse input waits for the renderer receipt and stale frame or gesture tokens cannot target a new view',async t=>{
  const f=await mouseFixture(t);assert.throws(()=>mouseEvent(f,'press'),/MOUSE_WAIT/);await mousePoll(f);assert.equal(f.controller.snapshot().mouse.ready,true);
  const old={view:f.controller.view,id:f.controller.selected,epoch:1,revision:f.controller.snapshot().mouse.revision,action:'press',column:5,row:7,button:0,modifiers:0};
  mouseEvent(f,'press');await mousePoll(f);assert.equal(f.server.sessions.get(f.controller.selected).mouse.buttons,1);
  mouseEvent(f,'cancel');assert.throws(()=>f.controller.mouse(old),/MOUSE_GESTURE/);for(let n=0;n<5;n++)await mousePoll(f);assert.equal(f.server.sessions.get(f.controller.selected).mouse.buttons,0);
  f.controller.resize({view:f.controller.view,id:f.controller.selected,columns:110,rows:35});assert.equal(f.controller.snapshot().mouse.ready,false);assert.throws(()=>mouseEvent(f,'press'),/MOUSE_WAIT/);
  for(let n=0;n<5;n++)await mousePoll(f);assert.equal(f.controller.snapshot().mouse.ready,true);
  const frame=await f.controller.poll();f.controller.select(f.controller.selected);assert.throws(()=>f.controller.parsed({view:frame.frame.view,id:f.controller.selected,token:frame.frame.token}),/VIEW_CHANGED/);
});
test('lost accepted or unaccepted mouse receipts stop the gesture without retransmitting its press',async t=>{
  for(const accepted of [false,true]){
    const f=await mouseFixture(t);await mousePoll(f);const base=f.controller.request;let lost=false;
    f.controller.request=async(...args)=>{if(args[2].op==='mouse' && args[2].action==='press' && !lost){lost=true;if(accepted)await base(...args);throw fault('TIMEOUT');}return base(...args);};
    mouseEvent(f,'press');await mousePoll(f);assert.equal(f.controller.phase,'recovering');f.advance(1000);
    for(let n=0;n<12;n++)await mousePoll(f);
    assert.equal(f.server.calls.filter(c=>c.op==='mouse' && c.action==='press').length,accepted?1:0);assert.equal(f.server.sessions.get(f.controller.selected).mouse.buttons,0);assert.equal(f.controller.snapshot().mouse.buttons,0);
  }
});
test('continuous mouse movement still reads output and sends keyboard input',async t=>{
  const f=await mouseFixture(t);await mousePoll(f);mouseEvent(f,'press');await mousePoll(f);input(f,'key');
  for(let n=0;n<40;n++){mouseEvent(f,'move',{column:10+n});await mousePoll(f);}
  assert.equal(f.server.writes.length,1);assert.ok(f.server.calls.filter(c=>c.op==='read').length>=5);assert.ok(f.server.calls.filter(c=>c.op==='mouse' && c.action==='move').length>=5);
  assert.equal(f.server.sessions.get(f.controller.selected).mouse.buttons,1);
});
test('network latency and continuous keys cannot starve live mouse movements',async t=>{
  for(const rendererDelay of [0,100]){
  const f=await mouseFixture(t);await mousePoll(f);mouseEvent(f,'press');await mousePoll(f);
  f.server.hook=async()=>{f.advance(120);};
  for(let n=0;n<24;n++){input(f,'key');mouseEvent(f,'move',{column:10+n});await mousePoll(f);f.advance(rendererDelay);}
  assert.ok(f.server.writes.length>=5);
  assert.ok(f.server.calls.filter(c=>c.op==='read').length>=5);
  assert.ok(f.server.calls.filter(c=>c.op==='mouse' && c.action==='move').length>=5,'mouse was starved by read/write requests');
  }
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
      if(['write','paste'].includes(command.op) && drop){drop=false;req.socket.destroy();return;}res.writeHead(reply.ok?200:409);res.end(JSON.stringify(reply));
    }catch{res.writeHead(503);res.end(JSON.stringify({ok:false,code:'TERMINAL_UNAVAILABLE'}));}
  });const port=await listen(server);t.after(()=>close(server));const f=fixture(t,{request:protocol.request});f.host.port=port-2;
  const id=await open(f);input(f,'set CLIPRELAY_COUNT=0\r');await drain(f);drop=true;input(f,'set /a CLIPRELAY_COUNT+=1\r');await poll(f);await poll(f);f.advance(1000);await drain(f);
  input(f,'echo COUNT_IS_%CLIPRELAY_COUNT%\r');await drain(f);let output='';for(let i=0;i<100 && !output.includes('COUNT_IS_1');i++){const result=await poll(f);if(result.frame)output+=Buffer.from(result.frame.data,'base64').toString();await sleep(20);}assert.match(output,/COUNT_IS_1/);assert.ok(!output.includes('COUNT_IS_2'));
  f.controller.pause();f.controller.resume();await poll(f);assert.equal(f.controller.selected,id);input(f,'echo RECONNE^CTED_OK\r');await drain(f);
  output='';for(let i=0;i<100 && !output.includes('RECONNECTED_OK');i++){const result=await poll(f);if(result.frame)output+=Buffer.from(result.frame.data,'base64').toString();await sleep(20);}assert.match(output,/RECONNECTED_OK/);
  input(f,'set CLIPRELAY_PASTE_COUNT=0\r');await drain(f);const draft=f.controller.beginPaste({view:f.controller.view,id},('rem '+'x'.repeat(5000)+'\n').repeat(3)+'set /a CLIPRELAY_PASTE_COUNT+=1\necho PASTE_COU^NT_%CLIPRELAY_PASTE_COUNT%\n');
  drop=true;f.controller.submitPaste({...draft,bracketed:false});await poll(f);await poll(f);f.advance(1000);await drain(f);
  output='';for(let i=0;i<150 && !output.includes('PASTE_COUNT_1');i++){const result=await poll(f);if(result.frame)output+=Buffer.from(result.frame.data,'base64').toString();await sleep(20);}assert.match(output,/PASTE_COUNT_1/);assert.ok(!output.includes('PASTE_COUNT_2'));
  f.controller.end({view:f.controller.view,id});await drain(f);assert.equal(f.controller.states.get(id).snapshot.state,'closed');
  const ps=await open(f,'powershell');input(f,"Write-Output ('POWER'+'SHELL_OK')\r");await drain(f);
  output='';for(let i=0;i<150 && !output.includes('POWERSHELL_OK');i++){const result=await poll(f);if(result.frame)output+=Buffer.from(result.frame.data,'base64').toString();await sleep(20);}assert.match(output,/POWERSHELL_OK/);
  f.controller.resize({view:f.controller.view,id:ps,columns:110,rows:35});for(let i=0;i<5 && f.controller.states.get(ps).snapshot.columns!==110;i++)await poll(f);assert.equal(f.controller.states.get(ps).snapshot.columns,110);assert.equal(f.controller.states.get(ps).snapshot.rows,35);
  f.controller.end({view:f.controller.view,id:ps});await drain(f);assert.equal(f.controller.states.get(ps).snapshot.state,'closed');
  const mouseFixture=process.env.CLIPRELAY_TERMINAL_MOUSE_FIXTURE || require('node:path').join(__dirname,'../../.tools/uu-parity/terminal-tests.exe');assert.ok(require('node:fs').existsSync(mouseFixture));
  const mouseId=await open(f);input(f,'"'+mouseFixture+'" --mouse-echo\r');await drain(f);
  const terminal=new (require('../electron/mac/vendor/terminal/xterm.js').Terminal)();t.after(()=>terminal.dispose());output='';
  const pump=async()=>{const result=await f.controller.poll();f.advance(16);if(result.frame){const frame=result.frame,data=Buffer.from(frame.data,'base64');output+=data.toString();await new Promise(resolve=>terminal.write(data,resolve));f.controller.parsed({view:frame.view,id:mouseId,token:frame.token});}assert.notEqual(f.controller.phase,'error',f.controller.error);};
  for(let n=0;n<100 && (!f.controller.snapshot().mouse.ready || terminal.modes.mouseTrackingMode!=='drag');n++){await pump();await sleep(20);}assert.equal(f.controller.snapshot().mouse.ready,true);assert.equal(terminal.modes.mouseTrackingMode,'drag');
  mouseEvent(f,'press');for(let n=0;n<20 && f.controller.states.get(mouseId).snapshot.mouse.acceptedSequence<1;n++)await pump();
  mouseEvent(f,'move',{column:6,row:8,modifiers:16});const heldUntil=Date.now()+1800;let nextHeartbeat=0;
  while(Date.now()<heldUntil){if(Date.now()>=nextHeartbeat){mouseEvent(f,'heartbeat');nextHeartbeat=Date.now()+200;}await pump();await sleep(20);}
  assert.match(output,/MOUSE_MOVE_SEEN/);assert.ok(!output.includes('MOUSE_CAPTURE:'));assert.equal(f.controller.states.get(mouseId).snapshot.mouse.buttons,1);assert.ok(f.controller.states.get(mouseId).snapshot.mouse.acceptedSequence>2);
  f.controller.pause();await sleep(1750);f.advance(1750);f.controller.resume();
  for(let n=0;n<100 && !output.includes('MOUSE_CAPTURE:');n++){await pump();await sleep(20);}
  const captured=/MOUSE_CAPTURE:([A-Za-z0-9+/=]+)/.exec(output);assert.ok(captured,'paused gesture did not release in native program');assert.equal(Buffer.from(captured[1],'base64').toString(),'\x1b[<0;5;7M\x1b[<48;6;8M\x1b[<16;6;8m');
  assert.equal(f.controller.states.get(mouseId).snapshot.mouse.buttons,0);assert.equal(f.controller.states.get(mouseId).snapshot.mouse.writtenSequence,2);
  f.controller.end({view:f.controller.view,id:mouseId});await drain(f);
});
