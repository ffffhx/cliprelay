'use strict';

// Rates use the native monotonic clock, so delayed/batched pipe reads cannot
// turn several seconds of video into an artificial burst. Counters are actual
// frames/encoded bytes, never sequence numbers or the configured bitrate.
class StreamStatistics {
  constructor(){this.latest=null;this.anchor=null;this.rates=null;this.updatedAt=0;}
  update(event,now){
    const keys=['elapsedMs','receivedFrames','renderedFrames','videoBytes'];
    if(keys.some(key=>!Number.isSafeInteger(event[key])||event[key]<0)||event.renderedFrames>event.receivedFrames)return false;
    const previous=this.latest;
    if(previous&&(event.elapsedMs<=previous.elapsedMs||keys.slice(1).some(key=>event[key]<previous[key])))return false;
    this.latest={...event};this.updatedAt=now;
    if(!this.anchor){this.anchor=this.latest;return true;}
    const elapsed=event.elapsedMs-this.anchor.elapsedMs;
    if(elapsed>=1000){
      // Long gaps are not a live measurement; resume with a fresh sample.
      this.rates=elapsed<=4000?{
        bitrateMbps:(event.videoBytes-this.anchor.videoBytes)*8/elapsed/1000,
        fps:(event.renderedFrames-this.anchor.renderedFrames)*1000/elapsed
      }:null;
      this.anchor=this.latest;
    }
    return true;
  }
  snapshot(now){
    if(!this.latest)return {phase:'loading',bitrateMbps:null,fps:null};
    if(now-this.updatedAt>=3000)return {phase:'stale',bitrateMbps:null,fps:null};
    return this.rates?{phase:'live',...this.rates}:{phase:'loading',bitrateMbps:null,fps:null};
  }
}
module.exports={StreamStatistics};
