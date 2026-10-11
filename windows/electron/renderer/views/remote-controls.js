import {element,listOptions} from './elements.js';
export function lightWindow({root,title,brand,status}){
  title.remove();brand.remove();root.querySelector('.dialog-close')?.remove();status.remove();
  document.documentElement.style.colorScheme='light';document.body.style.background='#f5f7fa';document.body.style.color='#000';root.style.fontSize='13.33px';
  const label=(text,x,y,w,h=26,style='')=>element(root,'div',text,x,y,w,h,style);
  const button=(text,id,x,y,w,action)=>{
    const node=element(root,'button',text,x,y,w,id.startsWith('RemoteNetwork')?34:36,'font:13.33px "Microsoft YaHei UI";background:#e1e1e1;border:1px solid #adadad;color:#000');node.id=id;
    node.onclick=()=>action();return node;
  };
  const list=(id,x,y,w,h)=>{const node=element(root,'select','',x,y,w,h,'background:#fff;color:#000;font:13.33px "Microsoft YaHei UI";border:1px solid #7a7a7a');node.id=id;node.size=4;return node;};
  const input=(id,x,y,w,h)=>{const node=element(root,id==='RemoteDesktopAddresses'?'textarea':'input',null,x,y,w,h,'background:#fff;color:#000;font:13.33px "Microsoft YaHei UI";border:1px solid #7a7a7a;padding:2px;resize:none');node.id=id;return node;};
  return {label,button,list,input};
}
export function remoteQueue(api,onResult,onError,onBusy){
  let busy=false,alive=true,next=0;
  return {
    get due(){return alive && !busy && Date.now()>=next;},
    async submit(request){
      if(busy || !alive)return;busy=true;next=Date.now()+2000;onBusy(true);
      try{const result=await api.request('remote',request);if(!result.ok)throw new Error(result.error);if(alive)onResult(request.action,result.data);}
      catch(error){if(alive)onError(error,request.action);}
      finally{busy=false;if(alive)onBusy(false);}
    },
    dispose(){alive=false;}
  };
}
export {listOptions};
