'use strict';
class HostNotices{
  constructor({Notification,active,open}){Object.assign(this,{Notification,active,open});this.closed=false;this.current=null;}
  show({count}){
    if(this.closed || !this.active() || !Number.isInteger(count) || count<1 || count>8)return false;
    this.withdraw();
    try{
      if(!this.Notification.isSupported())return false;
      const notice=new this.Notification({title:'有设备请求连接这台 Mac',body:`${count} 台设备等待确认。点击打开请求列表并核对验证码。`,silent:false});
      this.current=notice;
      notice.on('click',()=>{if(!this.closed && this.current===notice && this.active())this.open();});
      // Retain at most one token until replacement/withdrawal. Activation must
      // not depend on the ordering of native click and dismissal events.
      notice.on('failed',()=>{if(this.current===notice)this.withdraw();});
      notice.show();return true;
    }catch{this.withdraw();return false;}
  }
  withdraw(){const notice=this.current;this.current=null;try{notice?.close();}catch{}}
  close(){this.closed=true;this.withdraw();}
}
module.exports={HostNotices};
