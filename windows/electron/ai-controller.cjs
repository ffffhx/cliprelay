'use strict';
const crypto=require('node:crypto');
const {jsonRequest,endpoint,fault}=require('./mac/paired-transport.cjs');
const {sameRoute}=require('./mac/routed-store.cjs');
const id=()=>crypto.randomBytes(16).toString('hex');
const operations=new Set(['status','profiles','profile','apps','browser.open','browser.observe','browser.action','browser.tabs','browser.navigate','browser.tab_close','browser.handoff','browser.resume','browser.close','windows','window.observe','window.action','window.screenshot']);
async function request(host,identity,body,signal){
  const target=endpoint(host.address,host.port);
  let reply;
  try{reply=await jsonRequest({...target,port:target.port+2,path:'/v1/automation',body,identity,trust:{cert:host.certificate},signal,timeout:55000,limit:4*1024*1024,acceptStatuses:[200,400,403,409,415,429,503]});}
  catch(error){if(/BAD_CERTIFICATE|CERTIFICATE_REQUIRED|UNKNOWN_CA/.test(error.code||''))throw fault('AUTOMATION_UNPAIRED');throw error;}
  if(!reply||typeof reply.ok!=='boolean'||(reply.ok&&!/^[a-f0-9]{32}$/.test(reply.instance)))throw fault('AUTOMATION_INVALID_RESPONSE');
  if(!reply.ok)throw fault(/^AUTOMATION_[A-Z_]+$/.test(reply.code)?reply.code:'AUTOMATION_FAILED');
  if(body.instance&&reply.instance!==body.instance)throw fault('AUTOMATION_STALE');
  return reply;
}
class AiController{
  constructor({getClient,directory,request:send=request,now=Date.now}){Object.assign(this,{getClient,directory,send,now});this.sessions=new Map();this.connecting=false;this.closed=false;}
  async devices(){
    const client=this.getClient();
    return {devices:[...this.directory.snapshot().devices.map(d=>({id:'directory:'+d.id,name:d.name,platform:d.platform,connectable:d.connectable})),...client.paired.store.hosts().map(h=>({id:'paired:'+h.id,name:h.name,connectable:h.enabled&&!h.routeBlocked}))]};
  }
  async connect(owner,device){
    if(this.closed||this.connecting)throw fault('AUTOMATION_BUSY');
    if(this.sessions.size>=8)throw fault('AUTOMATION_CAPACITY');
    const client=this.getClient();
    if(client.direct.busy||client.paired.pairController||client.network.pairAbort)throw fault('PAIRING_BUSY');
    this.connecting=true;
    try{
      let host;
      if(typeof device==='string'&&device.startsWith('directory:')){
        const directoryId=device.slice(10);
        if(!this.directory.snapshot().devices.some(d=>d.id===directoryId&&d.connectable))throw fault('DEVICE_NOT_AVAILABLE');
        client.network.connectDiscovered(directoryId);await client.network.pairTask;
        if(client.network.pairing.state!=='paired')throw fault(client.network.pairing.error||'NETWORK_CONNECTION_FAILED');
        const record=client.network.catalog.records().find(r=>r.peerId===directoryId);
        host=client.paired.store.hosts().find(h=>h.networkId===record?.id);
      }else if(typeof device==='string'&&device.startsWith('paired:'))host=client.paired.store.hosts().find(h=>h.id===device.slice(7));
      if(!host||!host.enabled||host.routeBlocked||host.routeReady===false)throw fault('AUTOMATION_HOST_UNAVAILABLE');
      const identity=await client.paired.store.identity();
      const reply=await this.send(host,identity,{op:'capabilities'});
      if(reply.result?.stopped)throw fault('AUTOMATION_USER_STOPPED');
      if(this.closed)throw fault('CANCELLED');
      const session=id();this.sessions.set(session,{id:session,owner,host:{...host},instance:reply.instance,busy:false,pending:null,last:this.now()});
      return {session,deviceId:device,name:host.name,capabilities:reply.result};
    }finally{this.connecting=false;}
  }
  current(owner,session){
    const value=this.sessions.get(session);if(!value||value.owner!==owner)throw fault('AUTOMATION_SESSION_NOT_FOUND');
    const host=this.getClient().paired.store.hosts().find(h=>h.id===value.host.id);
    if(!host?.enabled||host.routeBlocked||!sameRoute(host,value.host))throw fault('AUTOMATION_ROUTE_CHANGED');
    return value;
  }
  async execute(owner,{session,operation,params={},requestId}){
    if(!operations.has(operation)||!params||typeof params!=='object'||Array.isArray(params)||Buffer.byteLength(JSON.stringify(params))>49152)throw fault('AUTOMATION_BAD_REQUEST');
    const value=this.current(owner,session);if(value.busy)throw fault('AUTOMATION_BUSY');
    if(requestId!==undefined&&!/^[a-f0-9]{32}$/.test(requestId))throw fault('AUTOMATION_BAD_REQUEST');
    const body={op:operation,instance:value.instance,requestId:requestId||id(),session,params};
    // Preserve the exact uncertain request. A retry retrieves its receipt;
    // another operation must observe state before deciding what to do next.
    if(value.pending&&requestId===value.pending.requestId&&JSON.stringify(body)!==JSON.stringify(value.pending))throw fault('AUTOMATION_ID_CONFLICT');
    value.busy=true;value.last=this.now();
    const previousPending=value.pending;
    try{
      const identity=await this.getClient().paired.store.identity();
      this.current(owner,session);
      const reply=await this.send(value.host,identity,body);
      this.current(owner,session);value.pending=null;
      return {requestId:body.requestId,result:reply.result};
    }catch(error){
      value.pending=['AUTOMATION_BUSY','AUTOMATION_CONTROL_BUSY'].includes(error.code)?previousPending:body;error.requestId=body.requestId;throw error;
    }finally{value.busy=false;if(value.abandoned)void this.release(owner);}
  }
  async disconnect(owner,session){
    const value=this.sessions.get(session);if(!value||value.owner!==owner)throw fault('AUTOMATION_SESSION_NOT_FOUND');
    if(value.busy)throw fault('AUTOMATION_BUSY');
    value.busy=true;
    try{
      this.current(owner,session);const identity=await this.getClient().paired.store.identity();
      await this.send(value.host,identity,{op:'close',instance:value.instance,requestId:id(),session});
    }finally{this.sessions.delete(session);}
    return {closed:true};
  }
  async heartbeat(owner){
    let healthy=true;
    for(const session of this.sessions.values())if(session.owner===owner&&!session.busy&&!session.pending){
      try{await this.execute(owner,{session:session.id,operation:'status'});}catch{healthy=false;}
    }
    return healthy;
  }
  async release(owner){for(const session of [...this.sessions.values()])if(session.owner===owner){if(session.busy){session.abandoned=true;continue;}try{await this.disconnect(owner,session.id);}catch{this.sessions.delete(session.id);}}}
  async close(){this.closed=true;for(const owner of new Set([...this.sessions.values()].map(s=>s.owner)))await this.release(owner);}
}
module.exports={AiController,request,operations};
