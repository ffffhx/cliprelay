'use strict';
const {fault}=require('./paired-transport.cjs');
const TEXT_LIMIT=1024*1024,PNG_LIMIT=8*1024*1024;
const check=active=>{if(!active())throw fault('CANCELLED');};
function pngSize(bytes){
  if(!Buffer.isBuffer(bytes) || bytes.length<33 || bytes.length>PNG_LIMIT || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii',12,16)!=='IHDR')throw fault('INVALID_IMAGE');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if(!width || !height || width>4096 || height>4096 || width*height>6000000)throw fault('IMAGE_TOO_LARGE');
  return {width,height};
}
// Electron 44 uses asynchronous ClipboardItem/Blob operations. Keep the legacy
// adapter for older runtimes; callers always await both paths. Only request the
// two supported MIME types, never file URLs or arbitrary native formats.
function clipboardAccess({clipboard,nativeImage,ClipboardItem}){
  const modern=typeof clipboard.read==='function' && typeof clipboard.has==='function';
  const access={
    async hasText(active=()=>true){check(active);const result=modern?await clipboard.has('text/plain'):clipboard.availableFormats().includes('text/plain');check(active);return result;},
    async readText(active=()=>true){check(active);const text=await clipboard.readText();check(active);if(typeof text!=='string' || Buffer.byteLength(text)>TEXT_LIMIT)throw fault('INVALID_TEXT');return text;},
    async writeText(text,active=()=>true){if(typeof text!=='string' || Buffer.byteLength(text)>TEXT_LIMIT)throw fault('INVALID_TEXT');check(active);await clipboard.writeText(text);check(active);},
    async readPayload(active=()=>true){
      check(active);
      if(modern){
        const items=await clipboard.read();check(active);
        if(!Array.isArray(items) || items.length>64)throw fault('INVALID_CLIPBOARD');
        for(const type of ['image/png','text/plain']){
          const item=items.find(item=>item.types.includes(type));if(!item)continue;
          const blob=await item.getType(type);check(active);
          if(!Number.isSafeInteger(blob?.size) || blob.size<0 || blob.size>(type==='image/png'?PNG_LIMIT:TEXT_LIMIT))throw fault(type==='image/png'?'IMAGE_TOO_LARGE':'INVALID_TEXT');
          const bytes=Buffer.from(await blob.arrayBuffer());check(active);
          if(bytes.length!==blob.size)throw fault('INVALID_CLIPBOARD');
          if(type==='image/png'){const expected=pngSize(bytes),image=nativeImage.createFromBuffer(bytes),size=image.getSize();if(image.isEmpty() || size.width!==expected.width || size.height!==expected.height)throw fault('INVALID_IMAGE');return {kind:'png',bytes};}
          const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);return text?{kind:'text',text}:{kind:'empty'};
        }
        return {kind:'empty'};
      }
      const image=clipboard.readImage();
      if(!image.isEmpty()){const bytes=image.toPNG();pngSize(bytes);return {kind:'png',bytes};}
      const text=await access.readText(active);return text?{kind:'text',text}:{kind:'empty'};
    },
    async writePayload(value,active=()=>true){
      if(value.kind==='text')return access.writeText(value.text,active);
      if(value.kind!=='png')throw fault('INVALID_CLIPBOARD');
      const expected=pngSize(value.bytes),image=nativeImage.createFromBuffer(value.bytes),size=image.getSize();
      if(image.isEmpty() || size.width!==expected.width || size.height!==expected.height)throw fault('INVALID_IMAGE');
      return access.writeImage(image,active);
    },
    async writeImage(image,active=()=>true){
      if(image.isEmpty())throw fault('INVALID_IMAGE');check(active);
      if(modern){
        if(typeof ClipboardItem!=='function')throw fault('INVALID_CLIPBOARD');
        const item=new ClipboardItem({'image/png':new Blob([image.toPNG()],{type:'image/png'})});
        check(active);await clipboard.write([item]);
      }else await clipboard.writeImage(image);
      check(active);
    }
  };
  return access;
}
async function captureSelection(access,copySelection,{active=()=>true,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const old=await access.hasText(active)?await access.readText(active):null;
  check(active);await copySelection();check(active);await delay(200);check(active);
  const text=await access.readText(active);
  // Do not restore over a different copy made while an asynchronous read was
  // pending. OS-level concurrent writes cannot be atomically compared by Electron.
  if(old!==null && await access.readText(active)===text)await access.writeText(old,active);
  check(active);return !text || text===old?null:{kind:'text',text};
}
module.exports={clipboardAccess,captureSelection,pngSize};
