'use strict';
const {pairHost}=require('./pairing.cjs');
const {PairedReceiver,sendClipboard,jpegSize}=require('./paired-relay.cjs');
const {endpoint,fault}=require('./paired-transport.cjs');
function message(error){
  if(error?.code==='VIEWER_UPDATE_REQUIRED')return '请更新 ClipRelay 后使用外网远控';
  return ({VIEWER_BUSY:'已有远控窗口正在运行',VIEWER_UNAVAILABLE:'桌面控制组件不可用，请安装包含此组件的 ClipRelay',VIEWER_INVALID:'桌面控制组件校验失败，请重新安装',INVALID_STREAM_TARGET:'远控目标无效，请重新配对',INVALID_STREAM_OPTIONS:'画面设置无效',INVALID_ADDRESS:'请输入电脑的 IP 或主机名',INVALID_PORT:'端口必须是 6–65532 的整数',INVALID_NAME:'设备名称无效',HOST_CERT_CHANGED:'电脑证书已改变，连接已停止；请核实电脑身份后重新配对',UNPAIRED:'电脑已撤销配对，请重新配对',RELAY_UNPAIRED:'电脑已撤销配对，请重新配对',KEYCHAIN_UNAVAILABLE:'系统钥匙串不可用，无法解锁配对身份',UPDATE_HOST:'请先更新电脑端 ClipRelay',PAIRING_CODE_MISMATCH:'两端配对标识不一致，已取消',PAIRING_SIGNATURE_INVALID:'电脑配对证明无效，已取消',PAIRING_PIN_MISMATCH:'配对校验失败，请重新发起',CANCELLED:'已取消',TIMEOUT:'连接超时，请检查电脑是否在线',PAIRING_REQUIRED:'请先选择已配对的电脑',INVALID_TEXT:'文本为空、过大或包含不支持的字符',IMAGE_TOO_LARGE:'图片过大，最多 4096 × 4096 且不超过 600 万像素',INVALID_IMAGE:'无法读取该图片',PAIRING_BUSY:'已有配对正在进行',SEND_BUSY:'正在发送，请稍后重试',TOO_MANY_HOSTS:'最多保存 16 台电脑'})[error?.code] || '操作失败，请检查连接后重试';
}
class PairedController{
  constructor({store,clipboard,nativeImage,copySelection,localName,notify=()=>{},onUpdate=()=>{},pair=pairHost,send=sendClipboard,Receiver=PairedReceiver}){
    Object.assign(this,{store,clipboard,nativeImage,copySelection,localName,notify,onUpdate,pair,send});
    this.pairing={state:'idle',message:''};this.status='paused';this.transfers=new Set();this.clipboardQueue=Promise.resolve();
    this.receiver=new Receiver({store,apply:(value,active)=>this.withClipboard(async()=>{
      if(!active())throw fault('CANCELLED');
      if(value.kind==='json')clipboard.writeText(value.text);
      else{
        const dimensions=jpegSize(value.body),image=nativeImage.createFromBuffer(value.body),size=image.getSize();
        if(image.isEmpty() || size.width!==dimensions.width || size.height!==dimensions.height)throw fault('INVALID_IMAGE');
        if(!active())throw fault('CANCELLED');clipboard.writeImage(image);
      }
      try{notify('ClipRelay 配对接收',value.kind==='json'?'已接收文本':'已接收图片');}catch{}
    }),onStatus:status=>{this.status=status;onUpdate();}});
  }
  withClipboard(operation){const result=this.clipboardQueue.catch(()=>{}).then(operation);this.clipboardQueue=result;return result;}
  snapshot(){return {hosts:this.store.hosts().map(({id,name,address,port,enabled})=>({id,name,address,port,enabled,selected:id===this.store.data.selected})),status:this.status,legacySelected:this.store.data.legacySelected,pairing:{...this.pairing}};}
  start(){this.receiver.refresh();}
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
    const controller=new AbortController();this.transfers.add(controller);
    const active=()=>!controller.signal.aborted && this.store.selected()?.id===host.id && this.store.selected()?.enabled===true;
    try{
      const identity=await this.store.identity();if(!active())throw fault('CANCELLED');
      const payload=await this.withClipboard(async()=>{
        if(!active())throw fault('CANCELLED');
        if(selection){
          const old=this.clipboard.availableFormats().includes('text/plain')?this.clipboard.readText():null;
          await this.copySelection();await new Promise(resolve=>setTimeout(resolve,200));
          const text=this.clipboard.readText();
          if(old!==null)this.clipboard.writeText(old);
          if(!active())throw fault('CANCELLED');if(!text || text===old)return null;return {kind:'text',text};
        }
        const image=this.clipboard.readImage();
        if(!image.isEmpty()){
          const {width,height}=image.getSize();if(!width || !height || width>4096 || height>4096 || width*height>6000000)throw fault('IMAGE_TOO_LARGE');
          return {kind:'png',bytes:image.toPNG()};
        }
        return {kind:'text',text:this.clipboard.readText()};
      });
      if(!payload)return false;if(!active())throw fault('CANCELLED');
      await this.send(host,identity,payload,controller.signal);return true;
    }finally{this.transfers.delete(controller);}
  }
  close(){this.cancelPair();this.cancelTransfers();this.receiver.close();}
}
module.exports={PairedController,message};
