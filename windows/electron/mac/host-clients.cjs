'use strict';
const crypto=require('node:crypto');
const {hostClientRequest,validClientId}=require('./host-admin.cjs');
const fault=code=>Object.assign(new Error(code),{code});
// Saved native identities belong to one running host session. UI view tokens
// cannot carry a decision across stop/restart, even when UUIDs persist on disk.
class HostClients{
  constructor({session,request=hostClientRequest}){Object.assign(this,{session,request});this.tasks=new Set();this.closed=false;}
  current(r){return !this.closed && this.record===r && !r.abort.signal.aborted && this.session.current===r.session && this.session.snapshot().phase==='running';}
  reconcile(){
    if(this.record && this.current(this.record))return;
    if(this.record){this.record.abort.abort();this.record.read?.abort.abort();this.record=null;}
    if(!this.closed && this.session.current && this.session.snapshot().phase==='running')this.record={
      session:this.session.current,viewId:crypto.randomBytes(16).toString('hex'),abort:new AbortController(),devices:[],phase:'loading',error:null,read:null,mutation:null};
  }
  snapshot(){
    this.reconcile();const r=this.record;
    return r?{viewId:r.viewId,phase:r.phase,error:r.error,devices:r.devices.map(device=>({...device})),revoking:r.mutation?.uuid || null}:
      {viewId:null,phase:'unavailable',error:null,devices:[],revoking:null};
  }
  check(r){if(!this.current(r))throw fault('HOST_CLIENTS_STALE');}
  track(task){this.tasks.add(task);task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));return task;}
  async query(r,operation,uuid,signal=r.abort.signal){
    this.check(r);if(signal.aborted)throw fault('HOST_CLIENTS_CANCELLED');
    const result=await this.request({state:this.session.engine.state,operation,uuid,signal});
    this.check(r);if(signal.aborted)throw fault('HOST_CLIENTS_CANCELLED');return result;
  }
  refresh(){
    this.reconcile();const r=this.record;if(!r || r.mutation)return Promise.resolve(this.snapshot());
    if(r.read)return r.read.task;
    const read={abort:new AbortController()};r.read=read;
    read.task=this.track((async()=>{
      try{
        const devices=await this.query(r,'list',undefined,read.abort.signal);
        if(this.current(r) && r.read===read){r.devices=devices;r.phase='ready';if(r.error==='HOST_CLIENTS_UNAVAILABLE')r.error=null;}
      }catch(error){if(this.current(r) && r.read===read && !read.abort.signal.aborted){r.devices=[];r.phase='failed';r.error='HOST_CLIENTS_UNAVAILABLE';}}
      finally{if(r.read===read)r.read=null;}
      return this.snapshot();
    })());return read.task;
  }
  revoke(data){
    this.reconcile();const r=this.record;
    if(!data || Object.keys(data).sort().join(',')!=='uuid,viewId' || !validClientId(data.uuid) || typeof data.viewId!=='string')return Promise.reject(fault('HOST_CLIENTS_INVALID'));
    if(!r || r.viewId!==data.viewId || !['ready','revoking'].includes(r.phase) || !r.devices.some(device=>device.uuid===data.uuid))return Promise.reject(fault('HOST_CLIENTS_STALE'));
    if(r.mutation)return Promise.reject(fault('HOST_CLIENTS_BUSY'));
    this.releaseWindow();const mutation={uuid:data.uuid};r.mutation=mutation;r.phase='revoking';r.error=null;
    mutation.task=this.track((async()=>{
      try{
        r.devices=await this.query(r,'list');
        if(r.devices.some(device=>device.uuid===data.uuid)){
          // Native disable revokes trust and terminates streams for this cert.
          // Unpair alone does not end an individual client's existing stream.
          const disabled=await this.query(r,'disable',data.uuid);
          if(disabled.status!==true)throw fault('HOST_CLIENTS_UNCONFIRMED');
          r.devices=await this.query(r,'list');
          const remaining=r.devices.find(device=>device.uuid===data.uuid);
          if(remaining?.enabled)throw fault('HOST_CLIENTS_UNCONFIRMED');
          if(remaining){await this.query(r,'unpair',data.uuid);r.devices=await this.query(r,'list');}
          if(r.devices.some(device=>device.uuid===data.uuid))throw fault('HOST_CLIENTS_UNCONFIRMED');
        }
        r.phase='ready';r.error=null;
      }catch(error){
        if(this.current(r)){
          r.error='HOST_CLIENTS_UNCONFIRMED';
          // A partial revoke stays visible as disabled. A fresh native list
          // can confirm removal after a lost reply; never re-enable or retry
          // a mutation automatically when the final state is still uncertain.
          try{
            r.devices=await this.query(r,'list');r.phase='ready';
            if(!r.devices.some(device=>device.uuid===data.uuid)){r.error=null;return;}
          }
          catch{if(this.current(r)){r.devices=[];r.phase='failed';}}
        }
        throw fault(this.current(r)?'HOST_CLIENTS_UNCONFIRMED':'HOST_CLIENTS_STALE');
      }finally{if(r.mutation===mutation)r.mutation=null;}
    })().then(()=>this.snapshot()));return mutation.task;
  }
  releaseWindow(){const r=this.record;if(r?.read){r.read.abort.abort();r.read=null;}}
  close(){this.closed=true;this.reconcile();return Promise.allSettled([...this.tasks]);}
}
module.exports={HostClients};
