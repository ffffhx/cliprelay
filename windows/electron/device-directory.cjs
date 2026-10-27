'use strict';
// Keep the host network available, but never enumerate other computers.
// Discovery is LAN-only; Internet enrollment requires a device code.
class DeviceDirectory{
  constructor({request,interval=4000}){Object.assign(this,{request,interval});this.devices=[];this.running=false;this.busy=false;}
  start(){if(this.running)return;this.running=true;void this.poll();}
  async poll(){
    if(!this.running||this.busy)return;this.busy=true;
    try{const {config}=await this.request('snapshot');if(this.running)await this.request('remote',{action:'networkPresence',presence:{deviceId:config.deviceId,name:config.deviceName,discoverable:false}});}
    catch{}finally{this.busy=false;if(this.running){this.timer=setTimeout(()=>this.poll(),this.interval);this.timer.unref?.();}}
  }
  snapshot(){return {devices:[],error:'',refreshing:false};}
  stop(){this.running=false;clearTimeout(this.timer);}
}
module.exports={DeviceDirectory};
