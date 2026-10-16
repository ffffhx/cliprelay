'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');

function importHammerspoon(exec=execFileSync){
  // Read only ClipRelay's existing hs.settings keys; do not dump unrelated
  // Hammerspoon settings or run the user's init.lua in another interpreter.
  const result={};
  for(const key of ['peer','peerPort','peerToken','deviceId','discoveryEnabled']){
    try{result[key]=exec('/usr/bin/defaults',['read','org.hammerspoon.Hammerspoon','cliprelay.'+key],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).replace(/\r?\n$/,'');}catch{}
  }
  return result;
}
function importLuaDefaults(file=path.join(os.homedir(),'.hammerspoon','init.lua')){
  let source;try{source=fs.readFileSync(file,'utf8');}catch{return {};}
  // Read the documented literal configuration only. Never execute init.lua,
  // which can contain unrelated user automations.
  const result={};
  const peer=source.match(/^\s*local\s+DEFAULT_PEER\s*=\s*(["'])([^"'\r\n]*)\1/m);
  if(peer)result.defaultPeer=peer[2];
  const port=source.match(/^\s*local\s+LOCAL_PORT\s*=\s*(\d+)\s*(?:--[^\r\n]*)?$/m);
  if(port && Number(port[1])>0 && Number(port[1])<=65535)result.localPort=Number(port[1]);
  const mods=source.match(/^\s*local\s+HOTKEY_MODS\s*=\s*\{([^}]*)\}/m);
  const key=source.match(/^\s*local\s+HOTKEY_KEY\s*=\s*(["'])([a-z0-9])\1/im);
  const mapping={ctrl:'Control',alt:'Alt',cmd:'Command',shift:'Shift'};
  if(mods && key){const values=[...mods[1].matchAll(/["']([^"']+)["']/g)].map(match=>mapping[match[1]]);if(values.length && values.every(Boolean))result.hotkey=[...values,key[2].toUpperCase()].join('+');}
  return result;
}
function loadConfig(directory,{legacy=importHammerspoon,defaults=importLuaDefaults,hostname=os.hostname}={}){
  const file=path.join(directory,'config.json');
  if(fs.existsSync(file)){
    const config=JSON.parse(fs.readFileSync(file,'utf8'));
    let changed=false;
    for(const key of ['legacyEnabled','hostAutoStart'])if(typeof config[key]!=='boolean'){config[key]=false;changed=true;}
    if(changed)saveConfig(directory,config);
    return config;
  }
  const old=legacy();
  const initial=defaults();
  const config={peer:old.peer || initial.defaultPeer || 'peer-mac.local',peerPort:Number(old.peerPort) || 47632,localPort:initial.localPort || 47632,hotkey:initial.hotkey || 'Control+Alt+G',peerToken:old.peerToken || '',deviceId:old.deviceId || crypto.randomUUID(),deviceName:hostname(),discoveryEnabled:old.discoveryEnabled===undefined || !['0','false'].includes(String(old.discoveryEnabled))};
  config.legacyEnabled=false;config.hostAutoStart=false;config.accessToken='';
  saveConfig(directory,config);return config;
}
function saveConfig(directory,config){
  fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'config.json');
  fs.writeFileSync(file+'.tmp',JSON.stringify(config,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.tmp',file);
}
module.exports={importHammerspoon,importLuaDefaults,loadConfig,saveConfig};
