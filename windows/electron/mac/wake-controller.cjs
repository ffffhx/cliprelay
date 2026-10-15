'use strict';
const crypto=require('node:crypto');
const protocol=require('./wake-protocol.cjs');
const {WakeStore,binding}=require('./wake-store.cjs');
const {sameRoute}=require('./routed-store.cjs');
const {fault}=require('./paired-transport.cjs');
const token=()=>crypto.randomBytes(16).toString('hex');
const terminal=new Set(['HOST_CERT_CHANGED','UNPAIRED','RELAY_UNPAIRED','KEYCHAIN_UNAVAILABLE','UPDATE_HOST','WAKE_INVALID_RESPONSE','WAKE_TARGET_CHANGED']);
const reachable=host=>!!host&&host.enabled===true&&host.routeReady!==false&&!host.routeBlocked&&typeof host.address==='string'&&Number.isInteger(host.port);
function sameIdentity(a,b){try{const x=binding(a),y=binding(b);return ['id','clientId','networkId'].every(k=>x[k]===y[k]);}catch{return false;}}
const hasNetwork=(value,network)=>value.adapters.some(a=>a.connected&&a.networks.includes(network));
const hasTarget=(value,saved)=>value.adapters.some(a=>a.id.toLowerCase()===saved.adapter.toLowerCase()&&a.mac===saved.mac);
function message(error){return ({WAKE_STALE:'电脑或连接已改变，请重新操作',WAKE_BAD_REQUEST:'唤醒操作无效',WAKE_NOT_READY:'请先完成唤醒设置并连接局域网助手',WAKE_PAIRING_CHANGED:'配对已改变，请重新设置唤醒',WAKE_INVALID_STORAGE:'无法读取唤醒配置',WAKE_STORAGE_UNAVAILABLE:'无法保存唤醒配置，请检查本机存储',WAKE_INVALID_RESPONSE:'电脑返回的唤醒信息无效',WAKE_TARGET_CHANGED:'目标网卡已改变，请重新设置唤醒',WAKE_HELPER_OFFLINE:'局域网助手尚未连接',WAKE_NOT_ON_LAN:'助手当前没有连接所选局域网',WAKE_RATE_LIMITED:'唤醒请求过于频繁，请稍后重试',WAKE_BUSY:'助手正在处理请求，请稍后重试',WAKE_CONFIRM_LAN:'请确认助手确实与目标处于同一个局域网',WAKE_NO_ADAPTER:'目标没有可用的已连接物理网卡',WAKE_UPDATE_REQUIRED:'请更新目标电脑或局域网助手',WAKE_PAIRING_REQUIRED:'电脑配对已失效，请重新配对'})[error?.code]||'无法确认唤醒结果，请检查电脑与助手连接';}

class WakeController{
  constructor({store,directory,preferences,request=protocol.request,now=()=>performance.now(),pollMs=2000,observeMs=45000}){
    Object.assign(this,{store,request,now,pollMs,observeMs});this.invalidPeers=new Map();
    try{this.preferences=preferences||new WakeStore(directory);}catch{this.storageError='WAKE_INVALID_STORAGE';}
  }
  current(r){const host=this.store.selected();return !this.closed&&this.record===r&&host?.enabled===true&&sameIdentity(host,r.host);}
  valid(r,op){return this.current(r)&&r.operation===op&&!op.abort.signal.aborted;}
  guard(r,op){if(!this.valid(r,op))throw fault('CANCELLED');}
  host(id){return this.store.hosts().find(host=>host.id===id);}
  assertRoute(host){if(!reachable(this.host(host.id))||!sameRoute(host,this.host(host.id)))throw fault('WAKE_STALE');}
  untrusted(host){return !!host&&sameIdentity(host,this.invalidPeers.get(host.id));}
  saved(r){return this.untrusted(r.host)?null:this.preferences?.get(r.host,this.store.hosts());}
  helper(saved){const host=saved&&this.host(saved.helper.id);return host&&reachable(host)&&!this.untrusted(host)?host:null;}
  async call(r,op,host,verb,body=null){
    try{return await this.request(host,r.identity,verb,body,op.abort.signal);}
    catch(error){
      if(['HOST_CERT_CHANGED','UNPAIRED','RELAY_UNPAIRED'].includes(error.code)){
        this.invalidPeers.set(host.id,{...host});
        try{this.preferences.invalidate(host);}catch{this.storageError='WAKE_STORAGE_UNAVAILABLE';}
      }
      throw error;
    }
  }
  dispose(){const r=this.record;this.record=null;if(r){r.operation?.abort.abort();clearTimeout(r.timer);}}
  reconcile(){
    if(this.closed||!this.preferences)return;
    try{this.preferences.reconcile(this.store.hosts());this.storageError='';}catch{this.storageError='WAKE_STORAGE_UNAVAILABLE';this.dispose();return;}
    if(this.record&&this.current(this.record))return;
    this.dispose();const host=this.store.selected();if(!host?.enabled)return;
    try{binding(host);}catch{return;}
    this.record={host:{...host},viewId:token(),phase:'ready',error:'',choices:new Map(),helpers:new Map()};
  }
  start(r,phase,task){
    if(r.operation)throw fault('WAKE_BUSY');clearTimeout(r.timer);
    const op={abort:new AbortController()};r.operation=op;r.phase=phase;r.error='';
    void (async()=>{
      try{if(!r.identity)r.identity=await this.store.identity();this.guard(r,op);await task(op);}
      catch(error){if(this.valid(r,op)){
        r.error=error.code==='UPDATE_HOST'?'WAKE_UPDATE_REQUIRED':['HOST_CERT_CHANGED','UNPAIRED','RELAY_UNPAIRED'].includes(error.code)?'WAKE_PAIRING_REQUIRED':error.code?.startsWith('WAKE_')?error.code:'WAKE_UNAVAILABLE';
        r.phase=r.attempt&&!r.attempt.confirmed?'unconfirmed':'error';
        if(r.attempt&&terminal.has(error.code))r.attempt.noRetry=true;
      }}finally{if(r.operation===op){r.operation=null;if(r.observing&&this.current(r))this.schedule(r);}}
    })();
  }
  prepare(r){
    r.attempt=null;r.observing=false;r.choices.clear();r.helpers.clear();const host={...this.store.selected()};
    this.start(r,'reading',async op=>{
      this.assertRoute(host);const value=await this.call(r,op,host,'status');this.guard(r,op);this.assertRoute(host);
      for(const adapter of value.adapters)if(adapter.connected)for(const network of adapter.networks)r.choices.set(token(),{adapter,network});
      if(!r.choices.size)throw fault('WAKE_NO_ADAPTER');
      for(const helper of this.store.hosts())if(helper.id!==host.id&&reachable(helper)&&!this.untrusted(helper))r.helpers.set(token(),{...helper});
      r.configHost=host;r.configAt=this.now();r.phase='choosing';
    });
  }
  save(r,data){
    if(data.sameLan!==true)throw fault('WAKE_CONFIRM_LAN');
    const choice=r.choices.get(data.adapter),helper=r.helpers.get(data.helper),target=r.configHost;
    if(r.phase!=='choosing'||!choice||!helper||this.now()-r.configAt>30000)throw fault('WAKE_STALE');
    this.assertRoute(target);this.assertRoute(helper);
    this.start(r,'saving',async op=>{
      const targetState=await this.call(r,op,target,'status');this.guard(r,op);this.assertRoute(target);this.assertRoute(helper);
      const adapter=targetState.adapters.find(a=>a.id===choice.adapter.id&&a.mac===choice.adapter.mac&&a.connected&&a.networks.includes(choice.network));
      if(!adapter)throw fault('WAKE_TARGET_CHANGED');
      const helperState=await this.call(r,op,helper,'status');this.guard(r,op);this.assertRoute(target);this.assertRoute(helper);
      if(!hasNetwork(helperState,choice.network))throw fault('WAKE_NOT_ON_LAN');
      try{this.preferences.save(target,helper,adapter,choice.network);}catch(error){throw fault(error.code||'WAKE_STORAGE_UNAVAILABLE');}
      r.choices.clear();r.helpers.clear();r.phase='ready';r.viewId=token();
    });
  }
  send(r){
    const saved=this.saved(r),helper=this.helper(saved);if(!saved||!helper)throw fault('WAKE_NOT_READY');
    r.observing=false;r.attempt=null;const route={...helper};
    this.start(r,'checking',async op=>{
      const target=this.store.selected();
      if(reachable(target)){
        try{const value=await this.call(r,op,{...target},'status');this.guard(r,op);
          if(!hasTarget(value,saved))throw fault('WAKE_TARGET_CHANGED');r.phase='online';r.onlineAt=this.now();return;
        }catch(error){this.guard(r,op);if(terminal.has(error.code)||error.code?.startsWith('WAKE_'))throw error;}
      }
      this.assertRoute(route);const inventory=await this.call(r,op,route,'status');this.guard(r,op);this.assertRoute(route);
      if(!hasNetwork(inventory,saved.network))throw fault('WAKE_NOT_ON_LAN');
      if(!this.saved(r))throw fault('WAKE_PAIRING_CHANGED');
      r.attempt={helper:route,saved,body:{id:token(),mac:saved.mac,network:saved.network},started:this.now(),confirmed:false};
      await this.dispatch(r,op);
    });
  }
  async dispatch(r,op){
    const a=r.attempt;this.assertRoute(a.helper);r.phase='sending';
    const result=await this.call(r,op,a.helper,'send',a.body);this.guard(r,op);
    a.confirmed=true;a.sent=result.sent;r.phase='waiting';r.observing=true;r.observeUntil=this.now()+this.observeMs;
  }
  schedule(r){clearTimeout(r.timer);r.timer=setTimeout(()=>this.observe(r),this.pollMs);r.timer.unref?.();}
  observe(r){
    if(!this.current(r)){this.reconcile();return;}if(!r.observing||r.operation)return;
    if(this.now()>=r.observeUntil){r.observing=false;r.phase='unconfirmed';return;}
    const host=this.store.selected();if(!reachable(host)){this.schedule(r);return;}
    this.start(r,'waiting',async op=>{
      try{const value=await this.call(r,op,{...host},'status');this.guard(r,op);
        if(!hasTarget(value,r.attempt.saved))throw fault('WAKE_TARGET_CHANGED');
        r.observing=false;r.phase='online';r.onlineAt=this.now();
      }catch(error){this.guard(r,op);if(terminal.has(error.code)||error.code?.startsWith('WAKE_')){r.observing=false;throw error;}r.phase='waiting';}
    });
  }
  stop(r){
    r.operation?.abort.abort();r.operation=null;clearTimeout(r.timer);r.observing=false;r.error='';
    r.phase=r.attempt?(r.attempt.confirmed?'sent':'unconfirmed'):'stopped';
  }
  snapshot(){
    const r=this.record;if(this.storageError)return {phase:'error',error:this.storageError};
    if(!r||!this.current(r))return {phase:'idle'};
    const saved=this.saved(r),helper=this.helper(saved),busy=!!r.operation,a=r.attempt;
    const retry=!!(saved&&a&&saved.capturedAt===a.saved.capturedAt&&!a.confirmed&&!a.noRetry&&this.now()-a.started<90000&&sameRoute(a.helper,this.host(a.helper.id))&&reachable(this.host(a.helper.id)));
    const cooldown=a?(a.confirmed?10000:150000):0;
    return {viewId:r.viewId,phase:r.phase,error:r.error,target:r.host.name||'目标电脑',busy,packetSent:!!a?.confirmed,
      helper:saved?(this.host(saved.helper.id)?.name||'局域网助手'):'',network:saved?.network||'',configured:!!saved,helperReady:!!helper,
      canPrepare:!busy&&!r.observing&&!this.untrusted(r.host)&&reachable(this.store.selected()),canSave:!busy&&r.phase==='choosing'&&this.now()-r.configAt<=30000,
      canSend:!!(!busy&&!r.observing&&saved&&helper&&(!a||this.now()-a.started>=cooldown)&&(r.phase!=='online'||this.now()-r.onlineAt>=5000)),
      canRetry:!busy&&retry,canStop:busy||r.observing,canForget:!busy&&!!saved,
      adapters:[...r.choices].map(([id,c])=>({id,label:c.adapter.name+' · '+c.network,configuration:c.adapter.configuration})),
      helpers:[...r.helpers].map(([id,h])=>({id,label:h.name||'局域网助手'}))};
  }
  action(action,data){
    this.reconcile();const r=this.record;
    const keys=action==='wake-save'?'adapter,helper,sameLan,viewId':'viewId';
    if(!data||Object.keys(data).sort().join(',')!==keys||typeof data.viewId!=='string')throw fault('WAKE_BAD_REQUEST');
    if(!r||r.viewId!==data.viewId)throw fault(this.storageError||'WAKE_STALE');
    const state=this.snapshot();
    if(action==='wake-stop'){if(state.canStop)this.stop(r);return;}
    if(r.operation)throw fault('WAKE_BUSY');
    if(action==='wake-prepare'&&state.canPrepare)this.prepare(r);
    else if(action==='wake-save'&&state.canSave)this.save(r,data);
    else if(action==='wake-send'&&state.canSend)this.send(r);
    else if(action==='wake-retry'&&state.canRetry)this.start(r,'sending',op=>this.dispatch(r,op));
    else if(action==='wake-forget'&&state.canForget){this.stop(r);try{this.preferences.remove(r.host.id);}catch{throw fault('WAKE_STORAGE_UNAVAILABLE');}r.attempt=null;r.phase='ready';r.viewId=token();}
    else throw fault('WAKE_NOT_READY');
  }
  close(){this.closed=true;this.dispose();}
}
module.exports={WakeController,message};
