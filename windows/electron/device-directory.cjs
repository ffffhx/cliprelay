'use strict';
const crypto=require('node:crypto');
const {BrokerClient}=require('./mac/network-broker.cjs');

// Public opt-in directory. No connection credentials, certificates or local
// addresses are sent to the renderer. Publishing stops when the tray exits.
class DeviceDirectory{
  constructor({request,client=new BrokerClient(crypto.randomBytes(32).toString('base64url')),interval=4000}){
    Object.assign(this,{request,client,interval});this.devices=[];this.error='';this.localId='';this.running=false;this.busy=false;
  }
  start(){if(this.running)return;this.running=true;void this.poll();}
  async poll(){
    if(!this.running||this.busy)return;
    this.busy=true;
    const abort=this.abort=new AbortController();
    try{
      const snapshot=await this.request('snapshot');
      if(!this.running)return;
      this.localId=String(snapshot.config.deviceId||'');
      // Publishing and browsing are independent: a missing host component
      // must not stop a computer from discovering somebody else's host.
      const [presence,directory]=await Promise.allSettled([
        this.request('remote',{action:'networkPresence',presence:{deviceId:this.localId,name:snapshot.config.deviceName,discoverable:snapshot.config.discoveryEnabled===true}}),
        this.client.request('directory',{},abort.signal)
      ]);
      if(!this.running)return;
      if(presence.status==='fulfilled'&&presence.value?.ok&&presence.value.data?.id)this.hostId=presence.value.data.id;
      if(directory.status==='fulfilled'){
        this.devices=directory.value.devices.filter(device=>device.id!==this.hostId&&device.deviceId!==this.localId);
        this.error='';
      }else{this.devices=[];this.error='设备列表暂时无法更新，请检查网络后重试。';}
    }catch{if(this.running){this.devices=[];this.error='设备列表暂时无法更新，请稍后重试。';}}
    finally{this.busy=false;if(this.running){this.timer=setTimeout(()=>this.poll(),this.interval);this.timer.unref?.();}}
  }
  snapshot(){return {devices:this.devices.map(device=>({...device})),error:this.error,refreshing:this.busy};}
  stop(){this.running=false;clearTimeout(this.timer);this.abort?.abort();this.devices=[];}
}
module.exports={DeviceDirectory};
