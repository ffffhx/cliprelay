'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fault=code=>Object.assign(new Error(code),{code});
const marker='.cliprelay-host.json';
function name(value){
  if(typeof value!=='string')throw fault('HOST_NAME_INVALID');
  return Array.from(value.replace(/[\x00-\x1f\x7f#=]/g,' ').trim()).slice(0,96).join('') || 'Mac';
}
function configuration(hostName){
  // Relative filenames are resolved by the validated native app-data root.
  // A user's home directory may contain spaces, Unicode or '#'.
  return [`sunshine_name = ClipRelay - ${name(hostName)}`,'port = 48789','origin_web_ui_allowed = pc',
    'system_tray = disabled','upnp = disabled','controller = disabled','min_log_level = 2',
    'lan_encryption_mode = 0','wan_encryption_mode = 0','file_apps = apps.json','file_state = clients.json',
    'credentials_file = credentials.json','pkey = cakey.pem','cert = cacert.pem','log_path = engine.log',''].join('\n');
}
function credentials(secret,salt=crypto.randomBytes(8).toString('hex')){
  if(typeof secret!=='string' || !secret || typeof salt!=='string' || !/^[a-f0-9]{16}$/.test(salt))throw fault('HOST_STATE_INVALID');
  // Sunshine's util::hex fixed-size hash representation reverses the bytes.
  return {username:'cliprelay',salt,password:Buffer.from(crypto.createHash('sha256').update(secret+salt,'utf8').digest()).reverse().toString('hex').toUpperCase()};
}
class HostState{
  #secret=null;
  constructor({directory,safeStorage}){
    if(typeof directory!=='string' || !path.isAbsolute(directory) || /[\x00-\x1f\x7f]/.test(directory))throw fault('HOST_STATE_INVALID');
    this.directory=path.resolve(directory);this.safeStorage=safeStorage;this.id=null;this.closed=false;
  }
  directoryInfo(){
    const info=fs.lstatSync(this.directory);
    if(!info.isDirectory() || info.isSymbolicLink() || info.uid!==process.getuid() || (info.mode&0o7777)!==0o700 ||
        fs.realpathSync(this.directory)!==this.directory)throw fault('HOST_STATE_INVALID');
    return info;
  }
  check(){
    const current=this.directoryInfo();
    if(this.anchor && (current.dev!==this.anchor.dev || current.ino!==this.anchor.ino))throw fault('HOST_STATE_CHANGED');
  }
  checkFiles(){
    this.check();let count=0;
    const visit=(directory,depth)=>{
      if(depth>16)throw fault('HOST_STATE_INVALID');
      for(const entry of fs.readdirSync(directory)){
        if(++count>10000)throw fault('HOST_STATE_INVALID');
        const file=path.join(directory,entry),info=fs.lstatSync(file);
        if(info.uid!==process.getuid() || info.isSymbolicLink() ||
            (!info.isDirectory() && !info.isFile()) ||
            (info.mode&0o7777)!==(info.isDirectory()?0o700:0o600) ||
            (info.isFile() && info.nlink!==1))throw fault('HOST_STATE_INVALID');
        if(info.isDirectory())visit(file,depth+1);
      }
    };
    visit(this.directory,0);this.check();
  }
  read(file,limit){
    this.check();let fd;
    try{
      fd=fs.openSync(path.join(this.directory,file),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      const info=fs.fstatSync(fd);
      if(!info.isFile() || info.nlink!==1 || info.uid!==process.getuid() || (info.mode&0o7777)!==0o600 || info.size>limit)throw fault('HOST_STATE_INVALID');
      const data=fs.readFileSync(fd);if(data.length>limit)throw fault('HOST_STATE_INVALID');this.check();return data;
    }finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  write(file,data){
    this.check();const target=path.join(this.directory,file),temporary=path.join(this.directory,'.'+crypto.randomUUID()+'.tmp');let fd;
    try{
      // Refuse links or unexpected files instead of adopting their ownership.
      try{this.read(file,1024*1024);}catch(error){if(error.code!=='ENOENT')throw error;}
      fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      fs.writeFileSync(fd,data);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      this.check();fs.renameSync(temporary,target);
      const parent=fs.openSync(this.directory,fs.constants.O_RDONLY);try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
    }finally{
      if(fd!==undefined)fs.closeSync(fd);
      try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
    }
  }
  prepare(hostName){
    if(this.closed)throw fault('HOST_STATE_CLOSED');
    this.#secret=null;
    if(process.platform!=='darwin')throw fault('HOST_PLATFORM_UNSUPPORTED');
    const config=configuration(hostName);
    if(!this.safeStorage?.isEncryptionAvailable())throw fault('HOST_KEYCHAIN_UNAVAILABLE');
    try{
      try{fs.mkdirSync(this.directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
      const info=this.directoryInfo();
      if(this.anchor && (info.ino!==this.anchor.ino || info.dev!==this.anchor.dev))throw fault('HOST_STATE_CHANGED');
      this.anchor=info;
      let owner;
      try{owner=JSON.parse(this.read(marker,128*1024));}catch(error){
        if(error.code!=='ENOENT')throw error;
        if(fs.readdirSync(this.directory).length)throw fault('HOST_STATE_UNOWNED');
        const secret=crypto.randomBytes(32).toString('base64'),encrypted=this.safeStorage.encryptString(secret);
        if(!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length>65536)throw fault('HOST_KEYCHAIN_UNAVAILABLE');
        owner={protocol:1,id:crypto.randomBytes(16).toString('hex'),secretEncrypted:encrypted.toString('base64')};
        this.write(marker,JSON.stringify(owner)+'\n');
      }
      if(!owner || Object.keys(owner).sort().join(',')!=='id,protocol,secretEncrypted' || owner.protocol!==1 ||
          typeof owner.id!=='string' || !/^[a-f0-9]{32}$/.test(owner.id) || typeof owner.secretEncrypted!=='string')throw fault('HOST_STATE_INVALID');
      const encrypted=Buffer.from(owner.secretEncrypted,'base64');
      if(!encrypted.length || encrypted.length>65536 || encrypted.toString('base64')!==owner.secretEncrypted)throw fault('HOST_STATE_INVALID');
      const secret=this.safeStorage.decryptString(encrypted);
      if(typeof secret!=='string' || !/^[A-Za-z0-9+/]{43}=$/.test(secret) || Buffer.from(secret,'base64').toString('base64')!==secret)throw fault('HOST_STATE_INVALID');
      // Native-managed keys, clients and logs must not redirect the next engine
      // launch through a link, or expose state through broader permissions.
      this.checkFiles();
      // The application owns these three settings files. Certificates and paired
      // clients are native-engine state and are never replaced by preparation.
      this.write('apps.json',JSON.stringify({env:{},apps:[{name:'Desktop'}]},null,2)+'\n');
      this.write('credentials.json',JSON.stringify(credentials(secret))+'\n');
      this.write('sunshine.conf',config);
      this.id=owner.id;this.#secret=secret;
      return {protocol:1,id:this.id,prepared:true};
    }catch(error){
      this.#secret=null;
      const allowed=['HOST_STATE_INVALID','HOST_STATE_CHANGED','HOST_STATE_UNOWNED','HOST_KEYCHAIN_UNAVAILABLE'];
      throw fault(allowed.includes(error.code)?error.code:'HOST_STATE_UNAVAILABLE');
    }
  }
  environment(parent=process.env){
    if(this.closed || !this.#secret)throw fault('HOST_STATE_NOT_PREPARED');
    this.checkFiles();return {...parent,CLIPRELAY_HOST_STATE_DIR:this.directory};
  }
  authorization(){
    if(this.closed || !this.#secret)throw fault('HOST_STATE_NOT_PREPARED');
    this.check();return 'Basic '+Buffer.from('cliprelay:'+this.#secret,'utf8').toString('base64');
  }
  companionInitialization(){
    if(this.closed || !this.#secret)throw fault('HOST_STATE_NOT_PREPARED');
    let certificate;
    try{certificate=new crypto.X509Certificate(this.read('cacert.pem',16384)).raw;}
    catch{throw fault('HOST_CERT_UNAVAILABLE');}
    // Main-process pipe input only. No plaintext credential file, environment
    // variable, command argument or renderer snapshot contains this frame.
    const frame=Buffer.from(JSON.stringify({protocol:1,password:this.#secret,certificate:certificate.toString('base64')})+'\n');
    if(frame.length>96*1024){frame.fill(0);throw fault('HOST_STATE_INVALID');}
    return frame;
  }
  close(){this.closed=true;this.#secret=null;}
}
module.exports={HostState,configuration,credentials};
