'use strict';
const http=require('node:http');
const net=require('node:net');

// Behavioral contract is init.lua: one peer, Ctrl+Alt+G, restore previous
// plain text, suppress empty/unchanged selections, POST /push and probes.
async function sendSelection({clipboard,copySelection,config,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),post=postText}){
  const old=clipboard.availableFormats().includes('text/plain')?clipboard.readText():null;
  await copySelection();
  await delay(200);
  const text=clipboard.readText();
  if(old!==null)clipboard.writeText(old);
  if(!text || text===old)return false;
  await post(config,text).catch(()=>{}); // Sender remains silent on failures.
  return true;
}
function postText(config,text){
  return new Promise((resolve,reject)=>{
    const body=Buffer.from(JSON.stringify({text}));
    const headers={'Content-Type':'application/json','Content-Length':body.length};
    if(config.peerToken)headers['X-ClipRelay-Token']=config.peerToken;
    // node:http makes a direct LAN connection, ignoring system proxy settings.
    const request=http.request({hostname:config.peer,port:config.peerPort,path:'/push',method:'POST',headers},response=>{
      response.resume();if(response.statusCode>=200 && response.statusCode<400)resolve();else reject(new Error('Peer returned HTTP '+response.statusCode));
    });
    const deadline=setTimeout(()=>request.destroy(new Error('timeout')),5000);
    request.on('error',reject);request.on('close',()=>clearTimeout(deadline));request.end(body);
  });
}
function receive(method,path,body,{clipboard,notify}){
  if(method==='POST' && path==='/push'){
    try{
      const data=JSON.parse(body);
      if(data && typeof data.text==='string' && data.text!==''){
        if(data.probe!==true){clipboard.writeText(data.text);notify('ClipRelay 收到文本',Buffer.from(data.text,'utf8').subarray(0,80).toString('utf8'));}
        return {status:200,body:'ok'};
      }
    }catch{}
  }
  return {status:400,body:'bad request'};
}
function createReceiver(adapters){
  return http.createServer(async(request,response)=>{
    try{
      const chunks=[];for await(const chunk of request)chunks.push(chunk);
      const result=receive(request.method,request.url,Buffer.concat(chunks).toString('utf8'),adapters);
      response.writeHead(result.status);response.end(result.body);
    }catch{response.destroy();} // A disconnected sender must not stop the tray app.
  });
}
function preferredIPv4(addresses){
  const ipv4=(addresses || []).filter(address=>net.isIP(address)===4);
  return ipv4.find(address=>/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(address)) || ipv4[0];
}
function discoveredPeer(service,deviceId){
  const txt=service.txt || {};const id=txt.id || `${service.name}:${service.port}`;const address=preferredIPv4(service.addresses);
  if(id===deviceId || !address || !Number.isInteger(service.port) || service.port<1)return null;
  return {id,text:service.name,address,port:service.port,requiresAuth:txt.auth==='required',subText:`${address}:${service.port}${txt.auth==='required'?' · 需要访问密钥':''}`};
}
module.exports={sendSelection,postText,receive,createReceiver,preferredIPv4,discoveredPeer};
