'use strict';
const {requireValue,number,MAX}=require('./terminal-protocol.cjs');
const enabled=s=>!!s && [9,1000,1002,1003].includes(s.mode) && [0,1005,1006,1015,1016].includes(s.format);
// Only a foreground renderer supplies heartbeats. Sending or replaying a
// request never supplies evidence that the physical button is still held.
class MouseState{
  constructor(snapshot,now){this.snapshot=snapshot;this.now=now;this.queue=[];this.pending=null;this.gesture=0;this.buttons=0;this.revision=0;this.lastBeat=-Infinity;this.lastSent=-Infinity;this.cancelWanted=false;this.abandoned=false;}
  stop(){this.queue=[];this.buttons=0;this.lastBeat=-Infinity;this.cancelWanted=!!this.gesture || !!this.snapshot?.buttons || !!this.snapshot?.remainingMs;this.abandoned=true;this.revision++;}
  refresh(next){
    if(next && this.snapshot)requireValue(next.epoch>=this.snapshot.epoch && next.acceptedSequence>=this.snapshot.acceptedSequence && next.writtenSequence>=this.snapshot.writtenSequence);
    if(this.pending && next)requireValue(next.acceptedSequence<=this.pending.sequence,'TERMINAL_MOUSE_SEQUENCE');
    const changed=this.snapshot?.epoch!==next?.epoch,ended=next && this.gesture && ['expired','cancelled','mode-changed','closed'].includes(next.phase) && (next.phase!==this.snapshot?.phase || next.gesture!==this.snapshot?.gesture);
    this.snapshot=next;
    if(changed || !next || ended)this.stop();
    if(this.abandoned && this.pending){
      // A stopped gesture is never retransmitted as a new press. Inventory
      // reconciles whether it was accepted; the host expires any late delivery.
      this.pending=null;
    }
    if(next && this.gesture && next.gesture===this.gesture && next.buttons===0 && next.remainingMs===0 && !this.queue.length && !this.pending){this.gesture=0;this.cancelWanted=false;}
  }
  heartbeat(){requireValue(this.buttons!==0 && !this.abandoned,'TERMINAL_MOUSE_GESTURE');this.lastBeat=this.now();}
  enqueue(event){
    const s=this.snapshot;requireValue(enabled(s),'TERMINAL_MOUSE_MODE');requireValue(event.epoch===s.epoch,'TERMINAL_MOUSE_MODE');
    requireValue(['press','release','move','wheel'].includes(event.action) && number(event.button,0,event.action==='move' || event.action==='wheel'?3:2) && number(event.modifiers,0,28) && event.modifiers%4===0 && number(event.column,1,65535) && number(event.row,1,65535),'TERMINAL_BAD_REQUEST');
    const stateless=s.mode===9 || event.action==='wheel' || event.action==='move' && event.button===3;
    if(stateless && this.abandoned){requireValue(!this.pending && !this.cancelWanted && s.buttons===0 && s.remainingMs===0,'TERMINAL_BUSY');this.abandoned=false;}
    if(event.action==='move')requireValue(s.mode===1003 || s.mode===1002 && event.button!==3,'TERMINAL_MOUSE_MODE');
    if(s.mode===9)requireValue(event.action==='press','TERMINAL_MOUSE_MODE');
    if(event.action==='move' && event.button===3)requireValue(this.buttons===0 && s.buttons===0,'TERMINAL_MOUSE_GESTURE');
    if(!stateless){
      if(event.action==='press'){
        requireValue((this.buttons & 1<<event.button)===0,'TERMINAL_MOUSE_GESTURE');
        if(!this.buttons){
          requireValue(!this.cancelWanted && (this.gesture!==0 && !this.abandoned || !this.pending && !this.queue.length && s.buttons===0 && s.remainingMs===0),'TERMINAL_BUSY');
          this.gesture=Math.max(s.nextGesture,this.gesture?this.gesture+1:0);requireValue(this.gesture<MAX,'TERMINAL_MOUSE_GESTURE');this.abandoned=false;
        }
        this.buttons|=1<<event.button;
      }else{requireValue(!this.abandoned && !!this.gesture && (this.buttons & 1<<event.button)!==0,'TERMINAL_MOUSE_GESTURE');if(event.action==='release')this.buttons&=~(1<<event.button);}
      this.lastBeat=this.now();
    }
    const item={action:event.action,epoch:event.epoch,gesture:stateless?0:this.gesture,column:event.column,row:event.row,button:event.button,modifiers:event.modifiers,created:this.now()};
    const previous=this.queue.at(-1);
    if(item.action==='move' && previous?.action==='move' && previous.gesture===item.gesture && previous.button===item.button && previous.epoch===item.epoch)this.queue[this.queue.length-1]=item;
    else{if(this.queue.length>=32){this.stop();requireValue(false,'TERMINAL_MOUSE_FULL');}this.queue.push(item);}
  }
  command(instance,id){
    const s=this.snapshot;if(!s)return null;
    if(this.buttons && this.now()-this.lastBeat>600 || this.queue.some(item=>this.now()-item.created>600))this.stop();
    if(this.pending){if(!this.abandoned)return {...this.pending};return null;}
    let item;
    if(this.cancelWanted){
      if(s.gesture && s.remainingMs>0 && ['pending','held'].includes(s.phase))item={action:'cancel',epoch:s.epoch,gesture:s.gesture,column:0,row:0,button:0,modifiers:0};
      else if(s.buttons===0){this.cancelWanted=false;this.gesture=0;}
    }
    if(!item && !this.abandoned && this.queue.length){const first=this.queue[0];if(first.action==='press' && first.gesture>s.gesture && (s.buttons!==0 || s.remainingMs!==0))return null;item=this.queue.shift();}
    if(!item && !this.abandoned && this.buttons && this.now()-this.lastSent>=350)item={action:'renew',epoch:s.epoch,gesture:this.gesture,column:0,row:0,button:0,modifiers:0};
    if(!item)return null;
    requireValue(s.acceptedSequence<MAX,'TERMINAL_MOUSE_SEQUENCE');const {created,...wire}=item;
    this.pending={op:'mouse',instance,id,sequence:s.acceptedSequence+1,...wire};return {...this.pending};
  }
  acknowledge(reply){requireValue(this.pending && reply.instance===this.pending.instance && reply.session.id===this.pending.id && reply.session.mouse?.acceptedSequence===this.pending.sequence);this.pending=null;this.lastSent=this.now();this.refresh(reply.session.mouse);}
  rejected(code){
    if(['TERMINAL_MOUSE_MODE','TERMINAL_MOUSE_GESTURE','TERMINAL_CLOSED'].includes(code)){this.pending=null;this.stop();return true;}
    return false;
  }
  busy(){return !!(this.pending || this.queue.length || this.buttons || this.cancelWanted);}
}
module.exports={MouseState,enabled};
