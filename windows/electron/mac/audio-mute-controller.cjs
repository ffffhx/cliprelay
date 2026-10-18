'use strict';
const {ForegroundLeaseController}=require('./foreground-lease.cjs');
const protocol=require('./audio-mute-protocol.cjs');
function message(error){return ({AUDIO_STALE:'音频连接已改变，请重新操作静音',AUDIO_BAD_REQUEST:'静音操作无效',AUDIO_NOT_READY:'请等远程画面恢复后再开启静音',AUDIO_BUSY:'静音正在使用或处理中',AUDIO_UNSUPPORTED:'当前连接无法在保留远程声音的同时静音电脑扬声器',AUDIO_NO_SAFE_STREAM:'当前连接不具备保留远程声音的静音条件',AUDIO_NO_EXCLUSIVE_STREAM:'静音需要这台电脑只有一个远控连接',AUDIO_RECOVERY_PENDING:'电脑仍在恢复原静音状态，请稍候',AUDIO_INVALID_RESPONSE:'电脑返回的静音状态无效',AUDIO_EXPIRED:'远程静音已到期，请确认连接后重新开启'})[error?.code]||'电脑静音状态未确认，请检查远程连接';}
class AudioMuteController extends ForegroundLeaseController{
  constructor(options){super({...options,protocol,prefix:'AUDIO'});}
  viewIdentity(d){return super.viewIdentity(d)+':'+(d?.stream?.audio?.generation??0);}
  streamBinding(d){
    if(!protocol.safeAudio(d))throw this.fault('NO_SAFE_STREAM');
    return {...super.streamBinding(d),audioGeneration:d.stream.audio.generation};
  }
}
module.exports={AudioMuteController,message};
