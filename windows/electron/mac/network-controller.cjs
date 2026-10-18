'use strict';
const path=require('node:path'),crypto=require('node:crypto');
const {BrokerClient,overlayIP}=require('./network-broker.cjs');
const {NetworkChannel,executable}=require('./network-channel.cjs');
const {pairHost}=require('./pairing.cjs');
const {fault}=require('./paired-transport.cjs');
const terminal=new Set(['NETWORK_REVOKED','NETWORK_NOT_APPROVED','NETWORK_PEER_CHANGED','BROKER_BAD_REPLY','BROKER_BAD_REQUEST','BROKER_REDIRECT','INVALID_NETWORK_CREDENTIAL','KEYCHAIN_UNAVAILABLE','PAIRING_CODE_EXPIRED','NETWORK_INVALID','NETWORK_UNAVAILABLE','INVALID_NETWORK_STORAGE','INVALID_NETWORK_INITIALIZATION']);
function wait(ms,signal){return new Promise((resolve,reject)=>{
  const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve();};
  const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(fault('CANCELLED'));};
  const timer=setTimeout(finish,ms);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
});}
class NetworkController{
  constructor({catalog,store,directory,localName,onUpdate=()=>{},canPair=()=>true,
    client=credential=>new BrokerClient(credential),channel=options=>new NetworkChannel(options),pair=pairHost,
    pollMs=3000,retryMs=5000,pairTimeoutMs=420000,routeTimeoutMs=60000,available}){
    Object.assign(this,{catalog,store,directory,localName,onUpdate,canPair,client,channel,pair,pollMs,retryMs,pairTimeoutMs,routeTimeoutMs});
    this.sessions=new Map();this.pairing={state:'idle'};this.closed=false;
    this.available=available ?? (()=>{try{executable(directory);const manifest=require('node:fs').readFileSync(path.join(directory,'manifest.json'),'utf8');return JSON.parse(manifest).capabilities?.includes('pairing-bootstrap')===true;}catch{return false;}})();
  }
  changed(){if(!this.closed)this.onUpdate();}
  snapshot(){return {available:this.available,pairing:{...this.pairing},computers:this.catalog.records().map(record=>{
    const session=this.sessions.get(record.id);return {id:record.id,name:record.name,enabled:record.enabled,
      paired:this.store.hosts().some(host=>host.networkId===record.id),phase:record.enabled?(session?.phase || 'connecting'):'paused',
      error:session?.error || '',path:session?.path || 'connecting'};
  })};}
  route(id){const record=this.catalog.get(id),session=this.sessions.get(id);return record?.enabled && session?.record.deviceId===record.deviceId && !session.abort.signal.aborted && session.route?{...session.route}:null;}
  streamPolicy(id){
    const record=this.catalog.get(id),session=this.sessions.get(id);
    if(this.closed || !this.available)return 'NETWORK_UNAVAILABLE';
    if(!record)return 'NETWORK_REVOKED';
    if(!record.enabled || session?.abort.signal.aborted)return 'NETWORK_PAUSED';
    if(session && (session.record.deviceId!==record.deviceId || session.record.peerId!==record.peerId))return 'NETWORK_PEER_CHANGED';
    if(session?.terminalError || session?.phase==='error')return session.terminalError || session.error || 'NETWORK_CONNECTION_FAILED';
    return '';
  }
  publish(session,phase,error='',route=session.route){
    if(this.sessions.get(session.record.id)!==session || session.abort.signal.aborted || this.closed)return;
    const before=JSON.stringify([session.phase,session.error,session.route,session.path]);
    Object.assign(session,{phase,error,route});session.path=session.channel?.snapshot().path || 'connecting';
    if(before!==JSON.stringify([session.phase,session.error,session.route,session.path]))this.changed();
  }
  withdraw(session){session.route=null;if(this.sessions.get(session.record.id)===session)this.changed();}
  stopSession(session){session.abort.abort();session.phase='paused';session.error='';session.path='connecting';this.withdraw(session);session.channel?.stop();}
  reconcile(forceId){
    if(this.closed)return;
    const records=this.catalog.records(),hosts=this.store.hosts();
    for(const [id,session] of this.sessions){
      const record=records.find(value=>value.id===id),bound=hosts.filter(host=>host.networkId===id);
      const desired=this.available && record?.enabled && (!bound.length || bound.some(host=>host.enabled));
      if(!desired || record.deviceId!==session.record.deviceId || record.peerId!==session.record.peerId || id===forceId)this.stopSession(session);
    }
    for(const record of records){
      const bound=hosts.filter(host=>host.networkId===record.id),previous=this.sessions.get(record.id);
      if(!this.available || !record.enabled || (bound.length && !bound.some(host=>host.enabled)) || (previous && !previous.abort.signal.aborted))continue;
      const session={record,abort:new AbortController(),phase:'connecting',error:'',route:null,path:'connecting'};
      this.sessions.set(record.id,session);
      session.task=(async()=>{
        await previous?.task;
        if(session.abort.signal.aborted)return;
        await this.connect(session);
      })().catch(error=>{if(!session.abort.signal.aborted)this.publish(session,'error',terminal.has(error.code)?error.code:'NETWORK_CONNECTION_FAILED',null);});
    }
    this.changed();
  }
  async connect(session){
    const {record,abort}=session,signal=abort.signal;
    const client=this.client(this.catalog.credential(record.id));
    const peerOf=status=>{
      if(status.id!==record.deviceId || status.state!=='approved' || status.peers.length!==1 || status.peers[0].id!==record.peerId)throw fault('NETWORK_PEER_CHANGED');
      return status.peers[0];
    };
    while(!signal.aborted){
      let current;
      try{
        this.publish(session,'connecting','',null);
        const status=await client.request('status',{},signal),peer=peerOf(status),ip=peer.addresses.find(overlayIP);
        if(!ip){this.publish(session,'waiting','',null);await wait(this.pollMs,signal);continue;}
        const enrollment=await client.request('enroll',{},signal);
        if(signal.aborted)throw fault('CANCELLED');
        current=this.channel({directory:this.directory,stateDirectory:path.join(this.catalog.directory,'nodes',record.id,record.deviceId),onUpdate:state=>{
          if(session.channel!==current || signal.aborted || session.terminalError)return;
          if(state.route)this.publish(session,'ready','',state.route);
          else this.publish(session,'connecting',state.error,null);
        }});
        session.channel=current;
        const route=await current.start({...enrollment,peerIP:ip},{signal});
        if(signal.aborted)throw fault('CANCELLED');this.publish(session,'ready','',route);
        while(!signal.aborted){
          await wait(this.pollMs,signal);
          if(current.snapshot().phase!=='ready')break;
          let state;
          try{state=await client.request('status',{},signal);}
          catch(error){if(signal.aborted || terminal.has(error.code))throw error;this.publish(session,'ready','BROKER_UNAVAILABLE');continue;}
          const peer=peerOf(state),next=peer.addresses.find(overlayIP);
          if(state.reauthorize || next!==ip)break;
          this.publish(session,'ready','');
        }
      }catch(error){
        if(signal.aborted)return;
        if(terminal.has(error.code)){
          session.terminalError=error.code;
          this.publish(session,'error',error.code,null);
          // Explicit revocation stops the route. Keep the record for a clear
          // explanation and deliberate re-pairing; do not silently mint identity.
          return;
        }
        this.publish(session,'connecting','NETWORK_CONNECTION_FAILED',null);
      }finally{
        this.withdraw(session);
        if(current)await current.stop();
        if(session.channel===current)session.channel=null;
      }
      await wait(this.retryMs,signal);
    }
  }
  job(operation){
    if(this.closed || !this.available)throw fault('NETWORK_UNAVAILABLE');
    if(this.pairAbort || !this.canPair())throw fault('PAIRING_BUSY');
    this.catalog.secure();const abort=this.pairAbort=new AbortController();
    this.pairing={state:'preparing'};this.changed();
    let timedOut=false;const timer=setTimeout(()=>{timedOut=true;abort.abort();},this.pairTimeoutMs);
    this.pairTask=(async()=>{
      try{await operation(abort.signal);if(abort.signal.aborted)throw fault('CANCELLED');this.pairing={state:'paired'};}
      catch(error){this.pairing={state:'error',error:timedOut?'TIMEOUT':error.code || 'NETWORK_CONNECTION_FAILED'};}
      finally{clearTimeout(timer);if(this.pairAbort===abort)this.pairAbort=null;this.changed();}
    })();return this.snapshot();
  }
  claim(code){
    if(typeof code!=='string' || !/^[0-9]{8}$/.test(code))throw fault('INVALID_PAIRING_CODE');
    return this.job(async signal=>{
      const credential=crypto.randomBytes(32).toString('base64url'),client=this.client(credential);
      const claim=await client.request('claim',{code,name:this.localName},signal);
      if(signal.aborted)throw fault('CANCELLED');
      this.pairing={state:'approval',verification:claim.id.slice(0,6).toUpperCase(),computer:claim.computer};this.changed();
      let approved;
      do{await wait(this.pollMs,signal);approved=await client.request('status',{},signal);}while(approved.state!=='approved');
      if(signal.aborted)throw fault('CANCELLED');
      if(approved.peers.length!==1)throw fault('BROKER_BAD_REPLY');
      const record=this.catalog.save(credential,approved.peers[0]);this.reconcile(record.id);
      await this.finishPair(record.id,signal);
    });
  }
  pairSaved(id){if(!this.catalog.get(id)?.enabled)throw fault('UNKNOWN_NETWORK');return this.job(signal=>this.finishPair(id,signal));}
  async finishPair(id,signal){
    const record=this.catalog.get(id);if(!record)throw fault('UNKNOWN_NETWORK');
    this.pairing={state:'connecting',computer:record.name};this.changed();
    const deadline=Date.now()+this.routeTimeoutMs;let route;
    while(!(route=this.route(id))){
      const session=this.sessions.get(id);if(session?.phase==='error')throw fault(session.error);
      if(Date.now()>deadline)throw fault('NETWORK_NOT_READY');await wait(Math.min(100,this.pollMs),signal);
    }
    const identity=await this.store.identity();if(signal.aborted)throw fault('CANCELLED');
    const old=this.store.hosts().find(host=>host.networkId===id);
    const active=()=>!signal.aborted && this.route(id)?.routeId===route.routeId && this.catalog.get(id)?.deviceId===record.deviceId;
    if(!active())throw fault('CANCELLED');
    const pairingAbort=new AbortController(),cancel=()=>pairingAbort.abort();signal.addEventListener('abort',cancel,{once:true});
    const monitor=setInterval(()=>{if(!active())cancel();},50);
    try{
      const host=await this.pair({address:route.address,port:route.port,name:this.localName,identity,expectedCert:old?.certificate,signal:pairingAbort.signal,onVerification:value=>{
        if(!active())throw fault('CANCELLED');this.pairing={state:'waiting',computer:record.name,verification:value.verification};this.changed();
      }});
      if(!active())throw fault('CANCELLED');
      const prior=this.store.hosts().find(value=>value.id===host.id);
      if(prior?.networkId && prior.networkId!==id)throw fault('NETWORK_PEER_CHANGED');
      const {address,port,...paired}=host;
      this.store.add({...paired,name:record.name,networkId:id,...(prior?.address?{directAddress:prior.address,directPort:prior.port}:prior?.directAddress?{directAddress:prior.directAddress,directPort:prior.directPort}:{})});
    }finally{clearInterval(monitor);signal.removeEventListener('abort',cancel);}
  }
  cancelPair(){this.pairAbort?.abort();}
  enable(id,enabled){this.catalog.enable(id,enabled);this.reconcile(id);}
  remove(id){
    const session=this.sessions.get(id);if(session)this.stopSession(session);
    this.cancelPair();for(const host of this.store.hosts())if(host.networkId===id)this.store.remove(host.id);
    this.catalog.remove(id);this.reconcile();
  }
  async close(){this.closed=true;this.cancelPair();for(const session of this.sessions.values())this.stopSession(session);await Promise.allSettled([...this.sessions.values()].map(session=>session.task));}
}
module.exports={NetworkController};
