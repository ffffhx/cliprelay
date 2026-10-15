(function(root){
  'use strict';
  const modifiers=e=>(e.shiftKey?4:0)+(e.altKey || e.metaKey?8:0)+(e.ctrlKey?16:0);
  const buttons=e=>(e.buttons&1?1:0)+(e.buttons&4?2:0)+(e.buttons&2?4:0);
  class TerminalMouse{
    constructor({window,document,element,term,getState,send,changed,problem}){
      Object.assign(this,{window,document,element,term,getState,send,changed,problem});
      this.held=0;this.selectionMode=false;this.selecting=false;this.key='';this.listeners=[];this.wheelX=0;this.wheelY=0;this.chain=Promise.resolve();this.outbox=[];this.sending=null;
      this.listen(element,'mousedown',e=>this.down(e));
      this.listen(window,'mousemove',e=>this.move(e));this.listen(window,'mouseup',e=>this.up(e));
      this.listen(element,'wheel',e=>this.wheel(e),{capture:true,passive:false});
      this.listen(element,'contextmenu',e=>{if(this.tracking())this.consume(e);});
      for(const name of ['click','auxclick','dblclick'])this.listen(element,name,e=>{if(this.tracking())this.consume(e);});
      this.listen(window,'mousedown',e=>{if(!element.contains(e.target))this.cancel();});
      this.listen(window,'blur',()=>this.cancel());this.listen(window,'mouseout',e=>{if(!e.relatedTarget)this.cancel();});
      this.listen(document,'visibilitychange',()=>{if(document.hidden)this.cancel();});
      this.heartbeat=window.setInterval(()=>this.beat(),200);
    }
    listen(target,type,fn,options=true){target.addEventListener(type,fn,options);this.listeners.push([target,type,fn,options]);}
    consume(e){e.preventDefault();e.stopImmediatePropagation();}
    tracking(){return this.getState()?.mode!==0 && !!this.getState()?.mode || this.term.modes.mouseTrackingMode!=='none';}
    localSelection(){return this.selectionMode || !this.getState()?.supported || !this.getState()?.available;}
    sync(){
      const s=this.getState(),key=[s?.view,s?.id,s?.epoch].join(':'),held=this.held,changed=key!==this.key || s?.revision!==this.revision;
      if(key!==this.key){this.cancel(false);this.key=key;}
      else if(s?.blocked){const selecting=this.selecting;this.cancel(false);this.selecting=selecting;}
      else if(s?.revision!==this.revision){const selecting=this.selecting;this.cancel(false);this.selecting=selecting;}
      this.revision=s?.revision;
      this.changed?.();
      if(held && changed)this.problem?.('本次鼠标操作已停止，请松开后重新按下。');
    }
    toggle(){const s=this.getState();this.cancel(true,s?.supported && s.available && !s.blocked);this.selectionMode=!this.selectionMode;this.term.clearSelection();this.changed?.();}
    post(action,data={}){
      const s=this.getState(),payload={view:s.view,id:s.id,epoch:s.epoch,revision:s.revision,action,...data},previous=this.outbox.at(-1);
      if(action==='move' && previous?.action==='move' && previous.button===payload.button && previous.view===payload.view)this.outbox[this.outbox.length-1]=payload;
      else if(this.outbox.length<64)this.outbox.push(payload);
      else{this.held=0;this.outbox=[{view:s.view,id:s.id,epoch:s.epoch,revision:s.revision,action:'cancel'}];this.problem?.('鼠标请求过多，已停止本次拖动。');}
      if(!this.sending)this.chain=this.flush();
    }
    async flush(){try{while(this.outbox.length){const payload=this.outbox.shift(),current=this.getState();if(current.view!==payload.view || current.id!==payload.id || current.revision!==payload.revision)continue;this.sending=payload;const reply=await this.send(payload);if(!reply){this.cancel(false);this.problem?.('鼠标操作已停止，请重新按下。');}}}catch{this.cancel(false);this.problem?.('鼠标操作已停止，请重新按下。');}finally{this.sending=null;}}
    cancel(notify=true,force=false){const active=force || this.held!==0 || this.outbox.length>0 || !!this.sending;this.held=0;this.selecting=false;this.outbox=[];this.wheelX=this.wheelY=0;if(active && notify)this.post('cancel');}
    beat(){if(!this.held)return;const s=this.getState();if(this.document.hidden || !this.document.hasFocus() || s.blocked || !s.ready){this.cancel();return;}this.post('heartbeat');}
    geometry(e,clamp=false){
      const screen=this.element.querySelector('.xterm-screen'),rect=screen?.getBoundingClientRect();
      if(!rect || rect.width<=0 || rect.height<=0)return null;
      let x=e.clientX-rect.left,y=e.clientY-rect.top;
      if(!clamp && (x<0 || y<0 || x>=rect.width || y>=rect.height))return null;
      x=Math.max(0,Math.min(rect.width-.001,x));y=Math.max(0,Math.min(rect.height-.001,y));
      return {column:Math.min(this.term.cols,Math.floor(x*this.term.cols/rect.width)+1),row:Math.min(this.term.rows,Math.floor(y*this.term.rows/rect.height)+1),pixelX:Math.min(65535,Math.floor(x)+1),pixelY:Math.min(65535,Math.floor(y)+1),cellX:x*this.term.cols/rect.width,boundary:Math.min(this.term.cols,Math.floor(x*this.term.cols/rect.width+.5)),height:rect.height/this.term.rows,rect};
    }
    boundary(p,row){const cell=this.term.buffer.active.getLine(row)?.getCell(p.boundary);return cell?.getWidth?.()===0?p.boundary+(p.cellX<p.boundary?-1:1):p.boundary;}
    location(e,clamp=false){const p=this.geometry(e,clamp);if(!p)return null;const s=this.getState();if(s.format===1016)return {column:p.pixelX,row:p.pixelY};if(s.format===0 && (p.column>223 || p.row>223))return null;return {column:p.column,row:p.row};}
    usable(){const s=this.getState();return s?.ready && !s.blocked && !s.parsing && !this.document.hidden && this.document.hasFocus() && this.term.buffer.active.viewportY===this.term.buffer.active.baseY;}
    down(e){
      if(!this.tracking() && !this.selectionMode)return;
      this.consume(e);this.term.focus();
      if(this.localSelection()){
        if(e.button!==0)return;const p=this.geometry(e);if(!p)return;
        const selectedRow=this.term.buffer.active.viewportY+p.row-1;this.selecting=true;this.selectionMoved=false;this.anchor=selectedRow*this.term.cols+this.boundary(p,selectedRow);this.anchorAtStart=true;this.lineSelection=e.detail>=3;
        this.term.clearSelection();
        if(this.lineSelection){this.anchor=Math.floor(this.anchor/this.term.cols)*this.term.cols;this.term.selectLines(Math.floor(this.anchor/this.term.cols),Math.floor(this.anchor/this.term.cols));}
        else if(e.detail===2){const row=selectedRow,line=this.term.buffer.active.getLine(row),col=p.column-1;let first=col,last=col+1;const space=i=>{const cell=line?.getCell(i);return !cell || cell.getWidth?.()!==0 && !cell.getChars().trim();};while(first>0 && !space(first-1))first--;while(last<this.term.cols && !space(last))last++;this.anchor=row*this.term.cols+first;this.term.select(first,row,last-first);}
        return;
      }
      const p=this.location(e);if(!this.usable() || !p || ![0,1,2].includes(e.button)){this.cancel();this.problem?.('画面正在同步或位置不可用，请稍后重新按下。');return;}
      const bit=1<<e.button;if(this.held&bit)return;
      this.term.clearSelection();if(this.getState().mode!==9)this.held|=bit;
      this.post('press',{...p,button:e.button,modifiers:modifiers(e)});
    }
    selection(e){
      const p=this.geometry(e,true);if(!p)return;
      if(e.clientY<p.rect.top)this.term.scrollLines(-1);else if(e.clientY>=p.rect.bottom)this.term.scrollLines(1);
      const prior=this.term.getSelectionPosition();if(prior){const anchor=this.anchorAtStart?prior.start:prior.end;this.anchor=anchor.y*this.term.cols+anchor.x-(this.lineSelection && !this.anchorAtStart?1:0);}
      const row=this.term.buffer.active.viewportY+p.row-1,end=row*this.term.cols+this.boundary(p,row);
      if(this.lineSelection)this.term.selectLines(Math.floor(Math.min(this.anchor,end)/this.term.cols),Math.floor(Math.max(this.anchor,end)/this.term.cols));
      else{const start=Math.min(this.anchor,end);this.term.select(start%this.term.cols,Math.floor(start/this.term.cols),Math.abs(end-this.anchor));}
      this.anchorAtStart=this.anchor<=end;
    }
    move(e){
      if(this.selecting){this.consume(e);if(!(e.buttons&1)){this.selecting=false;return;}this.selectionMoved=true;this.selection(e);return;}
      if(!this.tracking() || !this.held && !this.element.contains(e.target))return;
      this.consume(e);if(this.localSelection())return;
      if(this.held && buttons(e)!==this.held){this.cancel();return;}
      if(!this.usable()){if(!this.getState().parsing)this.cancel();return;}
      const mode=this.getState().mode;if(mode!==1003 && (mode!==1002 || !this.held))return;
      const p=this.location(e,!!this.held);if(!p){this.cancel();return;}
      const button=this.held?[0,1,2].find(b=>this.held & 1<<b):3;
      this.post('move',{...p,button,modifiers:modifiers(e)});
    }
    up(e){
      if(this.selecting && e.button===0){this.consume(e);if(this.selectionMoved)this.selection(e);this.selecting=false;return;}
      if(!(this.held & 1<<e.button)){if(this.tracking() && this.element.contains(e.target))this.consume(e);return;}
      this.consume(e);const p=this.location(e,true);
      if(!this.usable() || !p){this.cancel();return;}
      this.held&=~(1<<e.button);this.post('release',{...p,button:e.button,modifiers:modifiers(e)});
    }
    wheel(e){
      if(!this.tracking() && !this.selectionMode)return;
      this.consume(e);const geometry=this.geometry(e);if(!geometry)return;
      const factor=e.deltaMode===1?1:e.deltaMode===2?this.term.rows:1/geometry.height;
      if(this.localSelection()){this.wheelY+=e.deltaY*factor;const lines=Math.trunc(this.wheelY);this.wheelY-=lines;if(lines)this.term.scrollLines(lines);return;}
      if(!this.usable() || this.getState().mode===9)return;const p=this.location(e);if(!p)return;
      for(const axis of ['X','Y']){this['wheel'+axis]+=Math.max(-8,Math.min(8,e['delta'+axis]*factor));const steps=Math.max(-8,Math.min(8,Math.trunc(this['wheel'+axis])));this['wheel'+axis]-=steps;for(let i=0;i<Math.abs(steps);i++)this.post('wheel',{...p,button:axis==='X'?(steps>0?3:2):(steps>0?1:0),modifiers:modifiers(e)});}
    }
    description(){const s=this.getState();if(this.selectionMode)return '选择文字：拖动选区，双击选词，三击选行。';if(!s?.supported && this.tracking())return '电脑端需更新才能操作终端鼠标；仍可选择文字。';if(!s?.available)return '程序未请求鼠标输入，可直接选择文字。';if(!s.ready)return '正在同步画面和尺寸，鼠标暂不可用。';if(s.mode===9)return '程序只请求鼠标按下，不报告拖动；选择文字请切换模式。';if(s.mode===1000)return '程序请求点击和滚轮，不报告拖动；选择文字请切换模式。';return '程序鼠标：支持左右中键、修饰键和拖拽；选择文字请切换模式。';}
    dispose(){this.cancel();this.window.clearInterval(this.heartbeat);for(const [target,type,fn,options] of this.listeners)target.removeEventListener(type,fn,options);this.listeners=[];}
  }
  if(typeof module==='object' && module.exports)module.exports={TerminalMouse,modifiers,buttons};else root.ClipRelayTerminalMouse=TerminalMouse;
})(typeof window==='object'?window:globalThis);
