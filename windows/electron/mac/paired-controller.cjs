'use strict';
const {pairHost}=require('./pairing.cjs');
const {PairedReceiver,sendClipboard,jpegSize}=require('./paired-relay.cjs');
const {endpoint,fault}=require('./paired-transport.cjs');
const {sameRoute}=require('./routed-store.cjs');
const {clipboardAccess,captureSelection}=require('./clipboard-access.cjs');
function message(error){
  const network={NETWORK_NOT_READY:'正在连接电脑，请稍后重试',NETWORK_UNAVAILABLE:'请更新 ClipRelay 以使用外网配对',NETWORK_REVOKED:'电脑已撤销外网授权，请重新配对',NETWORK_PEER_CHANGED:'电脑的配对身份已改变，连接已停止',BROKER_UNAVAILABLE:'暂时无法连接配对服务，请稍后重试',BROKER_BAD_REPLY:'配对服务返回了无效信息，连接已停止',BROKER_REDIRECT:'配对服务地址发生变化，连接已停止',BROKER_RATE_LIMIT:'配对请求过于频繁，请稍后重试',BROKER_CONFLICT:'配对请求已存在，请重新生成配对码',NETWORK_NOT_APPROVED:'请先在电脑确认配对请求',PAIRING_CODE_EXPIRED:'配对码已过期或不正确，请重新生成',INVALID_PAIRING_CODE:'请输入电脑显示的 8 位数字配对码',UNKNOWN_NETWORK:'未找到这台电脑的外网配对',INVALID_NETWORK_CREDENTIAL:'配对凭据无法读取，请重新配对',NETWORK_CONNECTION_FAILED:'网络连接暂时不可用，正在重试'};
  if(network[error?.code])return network[error.code];
  const pairing={PAIRING_REJECTED:'电脑已拒绝本次配对，可重新发起请求',PAIRING_EXPIRED:'配对请求已过期，请重新发起',PAIRING_CANCELLED_REMOTE:'电脑已结束本次配对，请重新发起',PAIRING_STATUS_UNAVAILABLE:'无法确认电脑的配对状态，请检查连接后重试',PAIRING_STATUS_INVALID:'电脑返回的配对状态无效，已停止配对'};
  if(pairing[error?.code])return pairing[error.code];
  if(error?.code==='VIEWER_UPDATE_REQUIRED')return '请更新 ClipRelay 的桌面控制组件后重试';
  if(error?.code==='NETWORK_PAUSED')return '这台电脑的连接已暂停，请启用后重试';
  return ({VIEWER_BUSY:'已有远控窗口正在运行',VIEWER_UNAVAILABLE:'桌面控制组件不可用，请安装包含此组件的 ClipRelay',VIEWER_INVALID:'桌面控制组件校验失败，请重新安装',INVALID_STREAM_TARGET:'远控目标无效，请重新配对',INVALID_STREAM_OPTIONS:'画面设置无效',INVALID_ADDRESS:'请输入电脑的 IP 或主机名',INVALID_PORT:'端口必须是 6–65532 的整数',INVALID_NAME:'设备名称无效',HOST_CERT_CHANGED:'电脑证书已改变，连接已停止；请核实电脑身份后重新配对',UNPAIRED:'电脑已撤销配对，请重新配对',RELAY_UNPAIRED:'电脑已撤销配对，请重新配对',KEYCHAIN_UNAVAILABLE:'系统钥匙串不可用，无法解锁配对身份',UPDATE_HOST:'请先更新电脑端 ClipRelay',PAIRING_CODE_MISMATCH:'两端配对标识不一致，已取消',PAIRING_SIGNATURE_INVALID:'电脑配对证明无效，已取消',PAIRING_PIN_MISMATCH:'配对校验失败，请重新发起',CANCELLED:'已取消',TIMEOUT:'连接超时，请检查电脑是否在线',PAIRING_REQUIRED:'请先选择已配对的电脑',INVALID_TEXT:'文本为空、过大或包含不支持的字符',IMAGE_TOO_LARGE:'图片过大，最多 4096 × 4096 且不超过 600 万像素',INVALID_IMAGE:'无法读取该图片',PAIRING_BUSY:'已有配对正在进行',SEND_BUSY:'正在发送，请稍后重试',TOO_MANY_HOSTS:'最多保存 16 台电脑'})[error?.code] || '操作失败，请检查连接后重试';
}
class PairedController{
  constructor({store,clipboard,nativeImage,ClipboardItem,copySelection,localName,notify=()=>{},onClipboardApplied=()=>{},onUpdate=()=>{},pair=pairHost,send=sendClipboard,Receiver=PairedReceiver}){
    Object.assign(this,{store,clipboard,nativeImage,copySelection,localName,notify,onUpdate,pair,send});
    this.clipboard=clipboardAccess({clipboard,nativeImage,ClipboardItem});
    this.pairing={state:'idle',message:''};this.status='paused';this.transfers=new Set();this.clipboardQueue=Promise.resolve();
    this.receiver=new Receiver({store,apply:(value,active)=>this.withClipboard(async()=>{
      if(!active())throw fault('CANCELLED');
      if(value.kind==='json')await this.clipboard.writeText(value.text,active);
      else{
        const dimensions=jpegSize(value.body),image=nativeImage.createFromBuffer(value.body),size=image.getSize();
        if(image.isEmpty() || size.width!==dimensions.width || size.height!==dimensions.height)throw fault('INVALID_IMAGE');
        if(!active())throw fault('CANCELLED');await this.clipboard.writeImage(image,active);
      }
      onClipboardApplied();
      try{notify('ClipRelay 配对接收',value.kind==='json'?'已接收文本':'已接收图片');}catch{}
    }),onStatus:status=>{this.status=status;onUpdate();}});
  }
  withClipboard(operation){const result=this.clipboardQueue.catch(()=>{}).then(operation);this.clipboardQueue=result;return result;}
  snapshot(){return {hosts:this.store.hosts().map(({id,name,address,port,enabled,networkId,routeReady,overlay})=>({id,name,address,port,enabled,networkId,routeReady,overlay,selected:id===this.store.data.selected})),status:this.status,legacySelected:this.store.data.legacySelected,pairing:{...this.pairing}};}
  start(){this.lastRoute=this.store.selected();this.receiver.refresh();}
  reconcileRoutes(){if(this.closed)return;const selected=this.store.selected();if((!selected && !this.lastRoute) || sameRoute(selected,this.lastRoute))return;this.lastRoute=selected?{...selected}:null;this.cancelTransfers();this.receiver.refresh();this.onUpdate();}
  cancelTransfers(){for(const transfer of this.transfers)transfer.abort();}
  select(id){this.cancelTransfers();this.store.select(id);this.receiver.refresh();this.onUpdate();}
  selectLegacy(){this.cancelTransfers();this.store.selectLegacy();this.receiver.refresh();this.onUpdate();}
  enable(id,enabled){this.cancelTransfers();this.store.enable(id,enabled);this.receiver.refresh();this.onUpdate();}
  remove(id){this.cancelTransfers();this.store.remove(id);this.receiver.refresh();this.onUpdate();}
  cancelPair(){this.pairController?.abort();}
  startPair(data){
    if(this.pairController)throw fault('PAIRING_BUSY');
    const target=endpoint(data?.address,Number(data?.port));
    const label=typeof data?.label==='string'?data.label.trim():'';if(label.length>128 || /[\r\n\0]/.test(label))throw fault('INVALID_NAME');
    const controller=new AbortController();this.pairController=controller;
    this.pairing={state:'preparing',message:'正在准备安全配对…'};this.onUpdate();
    let expired=false;const timer=setTimeout(()=>{expired=true;controller.abort();},150000);
    this.pairTask=(async()=>{
      try{
        const identity=await this.store.identity();if(controller.signal.aborted)throw fault('CANCELLED');
        const existing=this.store.hosts().find(host=>host.address===target.address && host.port===target.port);
        const host=await this.pair({...target,identity,name:this.localName,expectedCert:existing?.certificate,signal:controller.signal,onVerification:({verification,expires})=>{
          this.pairing={state:'waiting',verification,expires,message:'请在电脑端核对相同验证码，然后确认配对。'};this.onUpdate();
        }});
        if(controller.signal.aborted)throw fault('CANCELLED');
        this.cancelTransfers();this.store.add({...host,name:label || host.name});this.receiver.refresh();this.pairing={state:'paired',message:'配对成功。电脑端添加此设备为配对广播目标后即可自动接收。'};
      }catch(error){this.pairing={state:'error',message:expired?'配对已超时，请重新发起':message(error)};}
      finally{clearTimeout(timer);this.pairController=null;this.onUpdate();}
    })();
    return this.snapshot();
  }
  async sendCurrent(selection=false){
    if(this.transfers.size)throw fault('SEND_BUSY');
    const host=this.store.selected();if(!host?.enabled || this.store.data.legacySelected)throw fault('PAIRING_REQUIRED');
    if(host.routeReady===false)throw fault('NETWORK_NOT_READY');
    const controller=new AbortController();this.transfers.add(controller);
    const active=()=>!controller.signal.aborted && !this.store.data.legacySelected && sameRoute(this.store.selected(),host);
    try{
      const identity=await this.store.identity();if(!active())throw fault('CANCELLED');
      const payload=await this.withClipboard(async()=>{
        if(!active())throw fault('CANCELLED');
        if(selection){
          return captureSelection(this.clipboard,this.copySelection,{active});
        }
        const payload=await this.clipboard.readPayload(active);return payload.kind==='empty'?null:payload;
      });
      if(!payload)return false;if(!active())throw fault('CANCELLED');
      await this.send(host,identity,payload,controller.signal);return true;
    }finally{this.transfers.delete(controller);}
  }
  close(){this.closed=true;this.cancelPair();this.cancelTransfers();this.receiver.close();}
}
module.exports={PairedController,message};
