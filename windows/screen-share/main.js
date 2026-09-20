'use strict';
const {app, BrowserWindow, desktopCapturer, screen, ipcMain, session:electronSession} = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');
const net = require('node:net');
const sessions = new Map();
const localSecret = crypto.randomBytes(32).toString('hex');
const pageURL = pathToFileURL(path.join(__dirname,'share.html')).href;
let server;
let idleSince=Date.now();
app.setName('ClipRelay Screen Share');
app.setPath('userData',path.join(app.getPath('appData'),'ClipRelay','ScreenShare'));
// App-local authenticated IPC only. Remote signaling still uses the tray's normal LAN port.
const endpointFile = path.join(app.getPath('userData'),'control.json');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('window-all-closed', () => {});
  app.whenReady().then(initialize).catch(error => { console.error(error); app.quit(); });
}
function equal(a,b) {
  if(typeof a!=='string' || typeof b!=='string')return false;
  const aa=Buffer.from(a),bb=Buffer.from(b);
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}
function transmit(s,message) { if (!s.window.isDestroyed()) s.window.webContents.send('share-message',message); }
function post(s,route,body,invite=false) {
  return new Promise((resolve,reject) => {
    const data=Buffer.from(JSON.stringify(body));
    const headers={'Content-Type':'application/json','Content-Length':data.length};
    if(invite && s.accessToken) headers['X-ClipRelay-Token']=s.accessToken;
    const request=http.request({hostname:s.address,port:s.port,path:route,method:'POST',headers,timeout:8000},response=>{
      response.resume();
      if(response.statusCode>=200 && response.statusCode<300) resolve();
      else reject(new Error(response.statusCode===404 ? '对方尚未支持视频共享，请先更新 ClipRelay。' : `对方返回 HTTP ${response.statusCode}，请检查设备设置和访问令牌。`));
    });
    request.on('timeout',()=>request.destroy(new Error('连接超时，请确认对方在线且网络互通。')));
    request.on('error',reject);request.end(data);
  });
}
async function end(s,notify=true) {
  if(s.ended) return;
  s.ended=true;s.captureAllowed=false;clearTimeout(s.expiry);
  if(notify) await post(s,'/screen/message',{id:s.id,secret:s.secret,type:'stop'}).catch(()=>{});
}
function open(s) {
  if(sessions.size>=4) throw new Error('请先关闭已有的共享窗口。');
  s.window=new BrowserWindow({width:1100,height:760,minWidth:620,minHeight:440,title:'ClipRelay 屏幕共享',backgroundColor:'#111318',titleBarStyle:'hidden',titleBarOverlay:{color:'#111318',symbolColor:'#94a3b8',height:36},autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  s.window.setMenu(null);sessions.set(s.id,s);
  s.window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  s.window.webContents.on('will-navigate',(event,url)=>{if(url!==pageURL)event.preventDefault();});
  s.window.webContents.on('render-process-gone',()=>end(s));
  s.window.on('closed',()=>{end(s);sessions.delete(s.id);});
  if(s.role==='receiver') s.expiry=setTimeout(()=>{transmit(s,{type:'stop',reason:'观看邀请已过期。'});end(s);},90000);
  s.window.loadFile(path.join(__dirname,'share.html'));
  return s;
}
function owner(event) {
  return [...sessions.values()].find(s=>s.window.webContents===event.sender && event.senderFrame?.url===pageURL);
}
function primaryScreenSource(sources,displayId) {
  const screens=sources.filter(source=>source.id.startsWith('screen:'));
  return screens.find(source=>source.display_id===String(displayId)) ||
    (screens.length===1 && !screens[0].display_id ? screens[0] : undefined);
}
async function initialize() {
  electronSession.defaultSession.setPermissionRequestHandler((contents,permission,callback)=>{
    const s=[...sessions.values()].find(item=>item.window.webContents===contents && !item.ended);
    callback(Boolean(s && (permission==='fullscreen' ||
      (s.role==='sender' && s.captureAllowed && ['media','display-capture'].includes(permission)))));
  });
  electronSession.defaultSession.setDisplayMediaRequestHandler(async(request,callback)=>{
    const s=[...sessions.values()].find(item=>!item.ended && item.role==='sender' && item.window.webContents.mainFrame.routingId===request.frame?.routingId && item.window.webContents.mainFrame.processId===request.frame?.processId);
    if(!s?.captureAllowed || s.captureStarted) {callback({});return;}
    s.captureStarted=true;
    try {
      const primary=screen.getPrimaryDisplay();
      const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:0,height:0}});
      const source=primaryScreenSource(sources,primary.id);
      if(s.ended) {callback({});return;}
      s.captureDisplayId=source?.display_id;
      callback(source?{video:source}:{});
    } catch {callback({});}
  });
  ipcMain.on('share-message',async(event,message)=>{
    const s=owner(event);if(!s || !message || typeof message.type!=='string')return;
    try {
      if(message.type==='ready') {transmit(s,{type:'init',role:s.role,peer:s.peerName,sdp:s.offer});if(s.ended)transmit(s,{type:'stop',reason:'共享已结束。'});}
      else if(message.type==='offer' && s.role==='sender' && !s.ended) await post(s,'/screen/invite',{id:s.id,secret:s.secret,name:s.localName,port:s.localPort,sdp:message.sdp},true);
      else if(message.type==='answer' && s.role==='receiver' && !s.ended) {clearTimeout(s.expiry);await post(s,'/screen/message',{id:s.id,secret:s.secret,type:'answer',sdp:message.sdp});}
      else if(message.type==='stop') await end(s);
      else if(message.type==='close') s.window.close();
      else if(message.type==='stats') s.stats=message.value;
    } catch(error) {transmit(s,{type:'error',reason:error.message});await end(s);}
  });
  server=http.createServer(async(request,response)=>{
    const reply=(status,body)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(body));};
    if(request.method!=='POST' || request.url!=='/command' || !equal(request.headers['x-cliprelay-control'],localSecret)) {reply(401,{error:'Unauthorized'});return;}
    let size=0;const chunks=[];
    try {
      for await(const chunk of request) {size+=chunk.length;if(size>524288){reply(413,{});return;}chunks.push(chunk);}
      const command=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result=handleCommand(command);reply(result.status,result);
    } catch(error) {reply(400,{error:error.message});}
  });
  server.requestTimeout=5000;server.headersTimeout=5000;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  fs.mkdirSync(path.dirname(endpointFile),{recursive:true});
  fs.writeFileSync(endpointFile,JSON.stringify({pid:process.pid,port:server.address().port,secret:localSecret}));
  // Exit with the tray or after inactivity; no hidden orphan capturing the screen.
  setInterval(()=>{
    const parent=Number(process.argv.find(arg=>arg.startsWith('--tray-pid='))?.split('=')[1]);
    if(parent) {try{process.kill(parent,0);}catch{app.quit();}}
    if(sessions.size)idleSince=Date.now();
    else if(Date.now()-idleSince>30000)app.quit();
  },3000).unref();
}
function handleCommand(command) {
  if(command.action==='ping')return {status:200};
  if(command.action==='stop-all') {for(const s of sessions.values()){end(s);s.window.close();}return {status:200};}
  if(command.action==='start') {
    const peer=command.peer;
    if(!peer || typeof peer.address!=='string' || !peer.address || peer.address.length>253 || typeof peer.name!=='string' || !Number.isInteger(peer.port) || peer.port<1 || peer.port>65535 || !Number.isInteger(command.localPort) || command.localPort<1 || command.localPort>65535 || typeof command.localName!=='string')return {status:400};
    const s=open({id:crypto.randomUUID().replaceAll('-',''),secret:crypto.randomBytes(32).toString('hex'),role:'sender',captureAllowed:true,peerName:peer.name,address:peer.address,port:peer.port,accessToken:peer.accessToken,localName:command.localName,localPort:command.localPort});
    return {status:200,id:s.id};
  }
  if(command.action==='signal') {
    const data=command.data;
    if(!data || !/^[a-f0-9]{32}$/.test(data.id) || !/^[a-f0-9]{64}$/.test(data.secret))return {status:400};
    if(command.path==='/screen/invite') {
      if(!net.isIP(command.remoteAddress) || !Number.isInteger(data.port) || data.port<1 || data.port>65535 || typeof data.name!=='string' || data.name.length>128 || typeof data.sdp!=='string' || !data.sdp.startsWith('v=0') || data.sdp.length>240000)return {status:400};
      if(sessions.has(data.id))return {status:409};
      if(sessions.size>=4)return {status:429};
      open({id:data.id,secret:data.secret,role:'receiver',peerName:`${data.name} (${command.remoteAddress})`,address:command.remoteAddress,port:data.port,offer:data.sdp});return {status:202};
    }
    if(command.path!=='/screen/message')return {status:404};
    const s=sessions.get(data.id);
    if(!s || !equal(s.secret,data.secret))return {status:401};
    if(s.ended)return {status:410};
    if(data.type==='stop'){end(s,false);transmit(s,{type:'stop',reason:'对方已结束共享。'});return {status:200};}
    if(data.type==='answer' && s.role==='sender' && typeof data.sdp==='string' && data.sdp.startsWith('v=0') && data.sdp.length<=240000){transmit(s,{type:'answer',sdp:data.sdp});return {status:200};}
    return {status:400};
  }
  return {status:400};
}
app.on('before-quit',()=>{for(const s of sessions.values())end(s);try{const record=JSON.parse(fs.readFileSync(endpointFile));if(record.pid===process.pid)fs.unlinkSync(endpointFile);}catch{}});
module.exports={handleCommand,equal,sessions,primaryScreenSource};
