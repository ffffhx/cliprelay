'use strict';
const http=require('node:http');
const {endpoint,fault}=require('./mac/paired-transport.cjs');
const {xmlValue}=require('./mac/paired-crypto.cjs');
const {message}=require('./mac/paired-controller.cjs');

// Read the remote-control protocol, not the clipboard receiver or just an open port.
function probeComputer(peer,{timeout=4000}={}){
  return new Promise(resolve=>{
    let request,timer,done=false;
    const finish=(ok,detail)=>{if(done)return;done=true;clearTimeout(timer);request?.destroy();resolve({id:peer.id,ok,detail});};
    try{
      const target=endpoint(peer.address,Number(peer.port||48789));
      request=http.get({host:target.address,port:target.port,path:'/serverinfo',agent:false,maxHeaderSize:16384,headers:{Connection:'close'}},response=>{
        if(response.statusCode!==200){response.resume();finish(false,'远控服务未就绪');return;}
        let size=0;const chunks=[];
        response.on('data',chunk=>{size+=chunk.length;if(size>65536)finish(false,'远控服务返回异常');else chunks.push(chunk);});
        response.on('error',()=>finish(false,'远控连接中断'));
        response.on('end',()=>{try{
          const xml=Buffer.concat(chunks).toString('utf8');
          if(!xmlValue(xml,'appversion')||!xmlValue(xml,'uniqueid')||!xmlValue(xml,'state'))throw fault('BAD_REPLY');
          finish(true,'远控服务可连接');
        }catch{finish(false,'未检测到兼容的远控服务');}});
      });
      request.on('error',()=>finish(false,'无法连接远控服务'));
      timer=setTimeout(()=>finish(false,'远控连接超时'),timeout);
    }catch{finish(false,'电脑地址或端口无效');}
  });
}

class DirectConnection{
  constructor(paired,viewer,network){this.paired=paired;this.viewer=viewer;this.network=network;this.generation=0;this.busy=false;this.error='';this.target=null;}
  status(){
    const viewer=this.viewer.snapshot();
    const ended=viewer.error==='VIEWER_STOPPED';
    return {peerId:this.target?.id||'',address:this.target?.address||'',phase:this.busy?'connecting':ended?'idle':viewer.phase,
      available:viewer.available,errorCode:this.errorCode||'',error:this.error||(!this.busy&&!ended&&viewer.error?message({code:viewer.error}):'')};
  }
  start(peer){
    const remote=peer?.networkId||peer?.directoryId;
    if(remote&&(!this.network||!/^[a-f0-9]{24}$/.test(remote)))throw new Error('设备信息无效，请刷新列表');
    const target={...(remote?peer.networkId?{networkId:remote}:{directoryId:remote}:endpoint(peer?.address,Number(peer?.port||48789))),id:String(peer?.id||''),label:String(peer?.name||'').slice(0,128)};
    if(peer?.deviceCode!==undefined&&!/^[0-9]{8}$/.test(peer.deviceCode))throw fault('INVALID_PAIRING_CODE');
    if(this.busy||this.paired.pairController||this.network?.pairAbort||['starting','running','recovering','closing'].includes(this.viewer.snapshot().phase))throw new Error('已有远控连接正在进行，请先结束当前连接');
    if(!this.viewer.snapshot().available)throw new Error('远程控制组件不可用，请重新安装 ClipRelay');
    this.target=target;this.busy=true;this.error='';this.errorCode='';const generation=++this.generation;
    this.task=(async()=>{
      try{
        if(target.directoryId||target.networkId){
          if(target.networkId)this.network.connectSaved(target.networkId);else this.network.connectDiscovered(target.directoryId);await this.network.pairTask;
          if(generation!==this.generation)return;
          if(this.network.pairing.state!=='paired')throw fault(this.network.pairing.error||'NETWORK_CONNECTION_FAILED');
        }else{
        const existing=this.paired.store.hosts().find(h=>h.address===target.address&&h.port===target.port);
        if(existing){if(!existing.enabled)this.paired.enable(existing.id,true);this.paired.select(existing.id);}
        else{
          this.paired.startPair({...target,...(peer.deviceCode?{deviceCode:peer.deviceCode}:{})});await this.paired.pairTask;
          if(generation!==this.generation)return;
          if(this.paired.pairing.state!=='paired')throw Object.assign(new Error(this.paired.pairing.message||'连接未完成，请重试'),{code:this.paired.pairing.code});
        }
        }
        if(generation!==this.generation)return;
        await this.viewer.open({width:1920,height:1080,fps:60,bitrate:12000});
      }catch(error){if(generation===this.generation){this.errorCode=error.code||'';this.error=error.code?message(error):error.message;}}
      finally{if(generation===this.generation)this.busy=false;}
    })();
    return this.status();
  }
  stop(){++this.generation;this.busy=false;this.error='';this.errorCode='';this.paired.cancelPair();if(this.target?.directoryId||this.target?.networkId)this.network?.cancelPair();this.viewer.stop();return this.status();}
}
module.exports={probeComputer,DirectConnection};
