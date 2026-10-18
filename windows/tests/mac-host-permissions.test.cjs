'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),{EventEmitter}=require('node:events');
const {HostPermissions}=require('../electron/mac/host-permissions.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}){
  const children=[],launches=[],verifications=[],updates=[];
  const owner=new HostPermissions({directory:path.resolve('fixture-engine'),pin:{arch:'arm64',commit:'a'.repeat(40),manifestSha256:'b'.repeat(64)},
    platform:'darwin',arch:'arm64',queryTimeout:10000,requestTimeout:10000,killDelay:5,now:()=>123,
    onUpdate:value=>updates.push(value),verify:(...args)=>verifications.push(args),
    launch:(...args)=>{
      launches.push(args);const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kills=[];
      child.kill=signal=>{child.kills.push(signal);child.emit('kill-signal',signal);return true;};children.push(child);return child;
    },...options});
  const reply=(index=0,value={protocol:1,screenRecording:true,inputControl:false,requested:'none'},code=0)=>{
    children[index].stdout.emit('data',Buffer.from(JSON.stringify(value)));
    children[index].emit('close',code,null);
  };
  return {owner,children,launches,verifications,updates,reply};
}
test('query verifies the pinned engine and launches only a fixed owned status command',async()=>{
  const f=fixture(),pending=f.owner.query();assert.equal(f.verifications.length,1);
  assert.deepEqual(f.launches[0][1],['--cliprelay-permissions','status']);
  assert.equal(f.launches[0][2].shell,false);assert.equal(f.launches[0][2].detached,false);assert.equal(f.launches[0][2].windowsHide,true);
  f.reply();assert.deepEqual(await pending,{checking:false,screenRecording:true,inputControl:false,checkedAt:123,error:null});
  await f.owner.close();assert.equal(f.owner.snapshot().screenRecording,null);assert.equal(f.owner.snapshot().error,'HOST_PERMISSIONS_CLOSED');
});
test('concurrent status polls coalesce while permission requests reject overlap',async()=>{
  const f=fixture(),one=f.owner.query(),two=f.owner.query();assert.equal(one,two);assert.equal(f.children.length,1);
  await assert.rejects(f.owner.request('screenRecording'),{code:'HOST_PERMISSIONS_BUSY'});f.reply();await one;await f.owner.close();
});
test('each explicit request selects only its matching native command and reports denial',async()=>{
  const f=fixture();
  for(const [index,target,action] of [[0,'screenRecording','request-screen'],[1,'inputControl','request-input']]){
    const pending=f.owner.request(target);assert.deepEqual(f.launches[index][1],['--cliprelay-permissions',action]);
    f.reply(index,{protocol:1,screenRecording:false,inputControl:false,requested:target});
    const value=await pending;assert.equal(value.screenRecording,false);assert.equal(value.inputControl,false);
  }
  await f.owner.close();
});
test('unknown permission names and wrong platform never launch a child',async()=>{
  const f=fixture({platform:'win32'});
  for(const value of ['all','constructor','toString','__proto__',null,{},undefined])await assert.rejects(f.owner.request(value),{code:'INVALID_HOST_PERMISSION'});
  await assert.rejects(f.owner.query(),{code:'HOST_PLATFORM_UNSUPPORTED'});assert.equal(f.children.length,0);await f.owner.close();
});
test('artifact mismatch and architecture mismatch fail before execution',async()=>{
  const f=fixture({verify:()=>{throw new Error('private path');}});await assert.rejects(f.owner.query(),{code:'HOST_ENGINE_INVALID'});
  assert.equal(f.children.length,0);assert.equal(f.owner.snapshot().error,'HOST_ENGINE_INVALID');
  const other=fixture({arch:'x64'});await assert.rejects(other.owner.query(),{code:'HOST_ENGINE_INVALID'});assert.equal(other.children.length,0);
  await f.owner.close();await other.owner.close();
});
test('malformed, mismatched or polluted replies cannot retain permission grants',async()=>{
  for(const value of [{protocol:1,screenRecording:true,inputControl:true,requested:'screenRecording'},
    {protocol:1,screenRecording:'true',inputControl:false,requested:'none'},
    {protocol:true,screenRecording:true,inputControl:false,requested:'none'},
    {protocol:1,screenRecording:true,inputControl:false,requested:'none',extra:1}]){
    const f=fixture(),pending=f.owner.query(),rejected=assert.rejects(pending,{code:'HOST_PERMISSION_BAD_REPLY'});
    f.reply(0,value);await rejected;assert.equal(f.owner.snapshot().screenRecording,null);await f.owner.close();
  }
  const f=fixture(),pending=f.owner.query(),rejected=assert.rejects(pending,{code:'HOST_PERMISSION_BAD_REPLY'});
  f.children[0].stdout.emit('data',Buffer.from('log\n'));f.reply();await rejected;await f.owner.close();
});
test('stdout and stderr limits terminate the owned process without reflecting diagnostics',async()=>{
  for(const [stream,size] of [['stdout',4097],['stderr',16385]]){
    const f=fixture(),pending=f.owner.query(),rejected=assert.rejects(pending,{code:'HOST_PERMISSION_BAD_REPLY'});
    f.children[0][stream].emit('data',Buffer.alloc(size,65));await rejected;
    assert.deepEqual(f.children[0].kills,['SIGTERM']);assert.equal(f.owner.operation.chunks.length,0);
    f.children[0].emit('close',null,'SIGTERM');await f.owner.close();
  }
});
test('timeout remains busy until the old child closes and then permits retry',async()=>{
  const f=fixture({queryTimeout:5});const pending=f.owner.query(),rejected=assert.rejects(pending,{code:'HOST_PERMISSION_TIMEOUT'});
  await new Promise((resolve,reject)=>{
    const limit=setTimeout(()=>reject(new Error('Owned child was not force-stopped')),1000);
    f.children[0].on('kill-signal',signal=>{if(signal==='SIGKILL'){clearTimeout(limit);resolve();}});
  });await rejected;
  assert.deepEqual(f.children[0].kills,['SIGTERM','SIGKILL']);
  await assert.rejects(f.owner.query(),{code:'HOST_PERMISSIONS_BUSY'});
  f.children[0].emit('close',null,'SIGKILL');const retry=f.owner.query();f.reply(1);await retry;await f.owner.close();
});
test('cancellation rejects late success and waits for actual child close',async()=>{
  const f=fixture(),pending=f.owner.request('screenRecording'),rejected=assert.rejects(pending,{code:'HOST_PERMISSION_CANCELLED'});
  let closed=false;const stop=f.owner.cancel().then(()=>{closed=true;});await rejected;await tick();assert.equal(closed,false);
  f.reply(0,{protocol:1,screenRecording:true,inputControl:true,requested:'screenRecording'});await stop;
  assert.equal(f.owner.snapshot().screenRecording,null);await f.owner.close();
});
test('closing an owner prevents further launches and late UI notifications',async()=>{
  const f=fixture(),pending=f.owner.query(),rejected=assert.rejects(pending,{code:'HOST_PERMISSION_CANCELLED'});
  const count=f.updates.length,closed=f.owner.close();await rejected;f.reply();await closed;
  assert.equal(f.updates.length,count);await assert.rejects(f.owner.query(),{code:'HOST_PERMISSIONS_CLOSED'});
});
test('a failed fresh query clears previously granted state',async()=>{
  const f=fixture(),first=f.owner.query();f.reply();await first;
  const second=f.owner.query(),rejected=assert.rejects(second,{code:'HOST_PERMISSION_COMMAND_FAILED'});
  assert.equal(f.owner.snapshot().screenRecording,null);f.children[1].emit('close',1,null);await rejected;await f.owner.close();
});
test('synchronous spawn failure returns a fixed public error and releases the operation',async()=>{
  const f=fixture({launch:()=>{throw new Error('secret diagnostic');}});
  await assert.rejects(f.owner.query(),{code:'HOST_PERMISSION_COMMAND_FAILED'});assert.equal(f.owner.operation,null);await f.owner.close();
});
test('reentrant owner shutdown before verification never starts a child',async()=>{
  let owner;const f=fixture({onUpdate:()=>{void owner.close();}});owner=f.owner;
  await assert.rejects(owner.query(),{code:'HOST_PERMISSION_CANCELLED'});assert.equal(f.children.length,0);assert.equal(f.verifications.length,0);
});
