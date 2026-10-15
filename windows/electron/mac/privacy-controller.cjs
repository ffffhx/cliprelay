'use strict';
const {ForegroundLeaseController}=require('./foreground-lease.cjs');
const protocol=require('./privacy-protocol.cjs');
function message(error){return ({PRIVACY_STALE:'连接已改变，请重新操作隐私屏',PRIVACY_BAD_REQUEST:'隐私屏操作无效',PRIVACY_NOT_READY:'请等远程画面恢复后再开启隐私屏',PRIVACY_BUSY:'隐私屏正在使用或处理中',PRIVACY_UNSUPPORTED:'当前电脑不支持隐私屏，请检查电脑端版本',PRIVACY_DESKTOP_UNAVAILABLE:'电脑桌面暂时无法开启隐私屏',PRIVACY_NO_EXCLUSIVE_STREAM:'隐私屏需要这台电脑只有一个远控连接',PRIVACY_INVALID_RESPONSE:'电脑返回的隐私屏状态无效',PRIVACY_EXPIRED:'隐私屏已到期，请确认画面后重新开启'})[error?.code]||'隐私屏状态未确认，请检查远程连接';}
class PrivacyController extends ForegroundLeaseController{
  constructor(options){super({...options,protocol,prefix:'PRIVACY'});}
}
module.exports={PrivacyController,message};
