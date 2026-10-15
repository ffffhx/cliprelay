'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),https=require('node:https'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {identities,listen,close}=require('./mac-pairing-fixture.cjs');
const {BrokerClient,credentialId}=require('../electron/mac/network-broker.cjs');
const {NetworkCatalog}=require('../electron/mac/network-catalog.cjs');
const {NetworkController}=require('../electron/mac/network-controller.cjs');
const {PairedStore}=require('../electron/mac/paired-store.cjs');
const {RoutedStore,sameRoute}=require('../electron/mac/routed-store.cjs');
const {PairedController}=require('../electron/mac/paired-controller.cjs');
const token=()=>crypto.randomBytes(32).toString('base64url');
const peer={id:'1'.repeat(24),name:'Fixture PC',online:true,addresses:['100.64.0.2']};
const error=code=>Object.assign(new Error(code),{code});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<300;i++){if(check())return;await delay(10);}throw new Error('test deadline');}
function safeStorage(){const key=crypto.randomBytes(32);return {isEncryptionAvailable:()=>true,
  encryptString:value=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]);},
  decryptString:bytes=>{const cipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString();}};}
function setup(t,options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-desktop-network-')),secure=safeStorage();
  const catalog=new NetworkCatalog(path.join(directory,'network'),secure),store=new PairedStore(path.join(directory,'paired'),secure);store.cachedIdentity=identities.client;
  const control={approved:true,offline:false,revoked:false,peer:{...peer},reauthorize:false,hostChange:false},channels=[],sent=[];
  const host={id:crypto.createHash('sha256').update(new crypto.X509Certificate(identities.host.cert).raw).digest('hex'),name:'Fixture',certificate:identities.host.cert,clientId:'a'.repeat(32),enabled:true};
  const manager=new NetworkController({catalog,store,directory:path.join(directory,'helper'),localName:'Fixture desktop',available:true,pollMs:20,retryMs:20,routeTimeoutMs:1000,
    client:credential=>({id:credentialId(credential),request:async(action,data,signal)=>{
      if(signal?.aborted)throw error('CANCELLED');if(control.revoked)throw error('NETWORK_REVOKED');if(control.offline)throw error('BROKER_UNAVAILABLE');
      if(action==='claim')return {id:credentialId(credential),state:'pending',computer:peer.name};
      if(action==='enroll')return {hostname:'cr-'+credentialId(credential),controlUrl:'https://control.invalid',authKey:'one-use'};
      return {id:credentialId(credential),state:control.approved?'approved':'pending',peers:[{...control.peer}],reauthorize:control.reauthorize};
    }}),
    channel:options=>{
      const instance={phase:'idle',route:null,closed:false,snapshot(){return {phase:this.phase,route:this.route,path:'direct'};},
        async start(value){sent.push(value);this.phase='ready';this.route={address:'127.0.0.1',port:32000,overlay:true,overlayPort:48789,routeId:crypto.randomUUID()};options.onUpdate(this.snapshot());return {...this.route};},
        async stop(){this.closed=true;this.phase='idle';this.route=null;options.onUpdate(this.snapshot());}};
      channels.push(instance);return instance;
    },pair:async value=>{value.onVerification({verification:'ABCD EFGH IJKL'});return {...host,address:value.address,port:value.port};},...options});
  t.after(async()=>{await manager.close();await manager.pairTask;const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true});});
  return {directory,secure,catalog,store,manager,control,channels,sent,host};
}

test('broker uses verified HTTPS, binds replies to credential identity and never follows redirects',async()=>{
  const credential=token(),id=credentialId(credential);let mode='valid',requests=0;
  const server=https.createServer({key:identities.broker.key,cert:identities.broker.cert},(req,res)=>{
    requests++;assert.equal(req.headers.authorization,'Bearer '+credential);
    if(mode==='redirect'){res.writeHead(302,{Location:'/capture'});res.end();return;}
    if(mode==='oversize'){res.end('x'.repeat(131073));return;}
    res.end(JSON.stringify({id:mode==='wrong-id'?'f'.repeat(24):id,name:'Desktop',state:'approved',peers:[peer],reauthorize:false}));
  });
  const port=await listen(server),client=new BrokerClient(credential,{endpoint:'https://127.0.0.1:'+port+'/network',ca:identities.brokerRoot.cert});
  try{
    assert.equal((await client.request('status')).peers[0].id,peer.id);
    const unknown=new BrokerClient(credential,{endpoint:'https://127.0.0.1:'+port+'/network'});
    await assert.rejects(unknown.request('status'),{code:'BROKER_UNAVAILABLE'});assert.equal(requests,1);
    mode='redirect';await assert.rejects(client.request('status'),{code:'BROKER_REDIRECT'});assert.equal(requests,2);
    mode='wrong-id';await assert.rejects(client.request('status'),{code:'BROKER_BAD_REPLY'});
    mode='oversize';await assert.rejects(client.request('status'),{code:'BROKER_BAD_REPLY'});
    await assert.rejects(client.request('approve'),{code:'INVALID_BROKER_ACTION'});
  }finally{await close(server);}
});

test('broker abort closes a stalled response and response bodies cannot become public errors',async()=>{
  let stalled=true;const server=https.createServer({key:identities.broker.key,cert:identities.broker.cert},(req,res)=>{if(stalled)return;res.writeHead(401);res.end('{"error":"private-enrollment-provider-detail"}');});
  const port=await listen(server),client=new BrokerClient(token(),{endpoint:'https://127.0.0.1:'+port,ca:identities.brokerRoot.cert,timeout:100});
  try{await assert.rejects(client.request('status'),{code:'BROKER_UNAVAILABLE'});const abort=new AbortController(),request=client.request('status',{},abort.signal);abort.abort();await assert.rejects(request,{code:'CANCELLED'});stalled=false;await assert.rejects(client.request('status'),{code:'NETWORK_REVOKED',message:'NETWORK_REVOKED'});}finally{await close(server);}
});

test('catalog encrypts credentials, reloads exact identity and preserves old state after write failure',t=>{
  const f=setup(t),credential=token(),record=f.catalog.save(credential,peer);
  assert.ok(!fs.readFileSync(f.catalog.file,'utf8').includes(credential));assert.ok(!JSON.stringify(f.catalog.records()).includes('encrypted'));
  const reopened=new NetworkCatalog(f.catalog.directory,f.secure);assert.equal(reopened.credential(record.id),credential);
  reopened.write=()=>{throw new Error('disk unavailable');};assert.throws(()=>reopened.enable(record.id,false));assert.equal(reopened.get(record.id).enabled,true);
  const bad=new NetworkCatalog(f.catalog.directory,{isEncryptionAvailable:()=>false});assert.throws(()=>bad.credential(record.id),{code:'KEYCHAIN_UNAVAILABLE'});
});

test('full approval and secure-host pairing persist no transient port and bind both identities',async t=>{
  const f=setup(t);f.manager.claim('12345678');await f.manager.pairTask;
  assert.equal(f.manager.pairing.state,'paired');const record=f.catalog.records()[0],saved=f.store.hosts()[0];
  assert.equal(saved.networkId,record.id);assert.equal(saved.id,f.host.id);assert.equal(saved.address,undefined);assert.equal(saved.port,undefined);
  const reopened=new PairedStore(f.store.directory,f.secure);assert.deepEqual(reopened.selected(),saved);
  for(const extra of [{port:32000},{address:'127.0.0.1'},{overlayPort:48789},{routeReady:true},{routeId:'old'}])assert.throws(()=>reopened.add({...saved,...extra}),{code:'INVALID_HOST'});
  const routed=new RoutedStore(f.store,id=>f.manager.route(id)),active=routed.selected();assert.equal(active.address,'127.0.0.1');assert.equal(active.port,32000);assert.equal(active.overlay,true);
  assert.ok(!JSON.stringify(f.manager.snapshot()).includes('one-use'));
  f.manager.enable(record.id,false);assert.equal(routed.selected().routeReady,false);assert.equal(f.channels[0].closed,true);
});

test('direct fallback is permitted for a temporary outage but blocked after pause or revocation',async t=>{
  const f=setup(t);f.store.add({...f.host,address:'192.168.1.8',port:48789});f.manager.claim('12345678');await f.manager.pairTask;
  const record=f.catalog.records()[0],routed=new RoutedStore(f.store,id=>f.manager.route(id),id=>f.manager.streamPolicy(id));assert.equal(routed.selected().overlay,true);
  const session=f.manager.sessions.get(record.id);f.manager.withdraw(session);
  assert.equal(routed.selected().address,'192.168.1.8');assert.equal(routed.selected().certificate,f.host.certificate);assert.equal(routed.selected().routeReady,true);
  f.manager.enable(record.id,false);assert.equal(routed.selected().routeReady,false);assert.equal(routed.selected().routeBlocked,'NETWORK_PAUSED');assert.equal(routed.selected().address,undefined);
  f.manager.enable(record.id,true);await until(()=>f.manager.route(record.id));f.control.revoked=true;await until(()=>f.manager.sessions.get(record.id).phase==='error');
  assert.equal(routed.selected().routeReady,false);assert.equal(routed.selected().routeBlocked,'NETWORK_REVOKED');assert.equal(routed.selected().address,undefined);
  f.store.enable(f.host.id,false);assert.equal(routed.selected().enabled,false);
});

test('close prevents delayed network updates from restarting receivers',async t=>{
  let changes=0;const f=setup(t,{onUpdate:()=>changes++}),record=f.catalog.save(token(),peer);f.manager.reconcile();await until(()=>f.manager.route(record.id));
  const before=changes;await f.manager.close();f.manager.reconcile();assert.equal(changes,before);assert.equal(f.manager.route(record.id),null);assert.equal(f.channels[0].closed,true);
});

test('cancelled approval cannot overwrite a saved computer or start a channel',async t=>{
  const f=setup(t);f.control.approved=false;f.manager.claim('12345678');await until(()=>f.manager.pairing.state==='approval');f.manager.cancelPair();await f.manager.pairTask;
  assert.equal(f.manager.pairing.error,'CANCELLED');assert.equal(f.catalog.records().length,0);assert.equal(f.channels.length,0);
});

test('pausing a paired host withdraws its network and reports paused until the host is enabled again',async t=>{
  const f=setup(t);f.manager.claim('12345678');await f.manager.pairTask;const id=f.catalog.records()[0].id,first=f.manager.route(id);
  f.store.enable(f.host.id,false);f.manager.reconcile();assert.equal(f.manager.snapshot().computers[0].phase,'paused');assert.equal(f.manager.route(id),null);assert.equal(f.channels[0].closed,true);
  f.store.enable(f.host.id,true);f.manager.reconcile();await until(()=>f.manager.route(id));assert.notEqual(f.manager.route(id).routeId,first.routeId);assert.equal(f.manager.snapshot().computers[0].phase,'ready');
});

test('coordinator outage preserves a working route; explicit revocation withdraws and closes it',async t=>{
  const f=setup(t),record=f.catalog.save(token(),peer);f.manager.reconcile();await until(()=>f.manager.route(record.id));const first=f.manager.route(record.id);
  f.control.offline=true;await until(()=>f.manager.sessions.get(record.id).error==='BROKER_UNAVAILABLE');assert.deepEqual(f.manager.route(record.id),first);assert.equal(f.channels[0].closed,false);
  f.control.offline=false;f.control.revoked=true;await until(()=>f.manager.sessions.get(record.id).phase==='error');assert.equal(f.manager.route(record.id),null);assert.equal(f.channels[0].closed,true);
  await delay(40);assert.equal(f.manager.sessions.get(record.id).error,'NETWORK_REVOKED');assert.equal(f.channels.length,1);
});

test('changed peer identity stops without redirecting; address changes wait for old helper cleanup',async t=>{
  const f=setup(t),record=f.catalog.save(token(),peer);f.manager.reconcile();await until(()=>f.manager.route(record.id));const first=f.manager.route(record.id);
  f.control.peer={...peer,addresses:['100.64.0.3']};await until(()=>f.channels.length===2 && f.manager.route(record.id));assert.equal(f.channels[0].closed,true);assert.notEqual(f.manager.route(record.id).routeId,first.routeId);
  assert.equal(f.sent[1].peerIP,'100.64.0.3');f.control.peer={...peer,id:'2'.repeat(24)};await until(()=>f.manager.sessions.get(record.id).phase==='error');assert.equal(f.manager.route(record.id),null);assert.equal(f.channels.length,2);
});

test('a late host-pairing result cannot bind a replaced route or a removed record',async t=>{
  let done,entered;const started=new Promise(resolve=>entered=resolve),pending=new Promise(resolve=>done=resolve);
  const f=setup(t,{pair:async value=>{entered();await pending;return {...f.host,address:value.address,port:value.port};}});
  f.manager.claim('12345678');await started;const record=f.catalog.records()[0];f.manager.remove(record.id);done();await f.manager.pairTask;
  assert.equal(f.store.hosts().length,0);assert.equal(f.catalog.records().length,0);assert.equal(f.manager.route(record.id),null);
});

test('route comparison catches reused local ports and TLS identity changes',()=>{
  const a={id:'first',enabled:true,address:'127.0.0.1',port:32000,routeId:'one',certificate:'pin',clientId:'client'};
  assert.equal(sameRoute(a,{...a}),true);assert.equal(sameRoute(a,{...a,routeId:'two'}),false);assert.equal(sameRoute(a,{...a,certificate:'other'}),false);
});

test('route replacement cancels queued clipboard writes and in-flight sends even when the local port is reused',async t=>{
  const f=setup(t);f.manager.claim('12345678');await f.manager.pairTask;
  const routed=new RoutedStore(f.store,id=>f.manager.route(id));let release,reads=0,writes=0,refreshes=0;
  class Receiver{constructor(options){this.options=options;}refresh(){refreshes++;}close(){}}
  const controller=new PairedController({store:routed,localName:'Fixture',Receiver,clipboard:{writeText:()=>writes++,readText:()=>{reads++;return 'text';},readImage:()=>({isEmpty:()=>true})},send:async()=>assert.fail('stale send')});
  t.after(()=>controller.close());controller.start();f.manager.onUpdate=()=>controller.reconcileRoutes();
  const selected=routed.selected(),id=f.catalog.records()[0].id;
  const gate=controller.withClipboard(()=>new Promise(resolve=>release=resolve));await Promise.resolve();
  const pendingWrite=controller.receiver.options.apply({kind:'json',text:'stale'},()=>sameRoute(selected,routed.selected()));
  const writeRejected=assert.rejects(pendingWrite,{code:'CANCELLED'}),send=controller.sendCurrent(),sendRejected=assert.rejects(send,{code:'CANCELLED'});
  f.control.peer={...peer,addresses:['100.64.0.4']};await until(()=>f.manager.route(id)?.routeId && f.manager.route(id).routeId!==selected.routeId);
  release();await Promise.all([gate,writeRejected,sendRejected]);assert.equal(reads,0);assert.equal(writes,0);assert.ok(refreshes>=2);
  f.manager.enable(id,false);await assert.rejects(controller.sendCurrent(),{code:'NETWORK_NOT_READY'});assert.equal(reads,0);
});
