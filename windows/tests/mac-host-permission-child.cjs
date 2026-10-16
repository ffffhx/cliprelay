'use strict';
// Disposable process fixture. This file never calls native permission APIs.
const mode=process.env.CLIPRELAY_PERMISSION_FIXTURE;
const action=process.argv[3];
if(process.argv[2]!=='--cliprelay-permissions' || !['status','request-screen','request-input'].includes(action))process.exit(2);
if(mode==='hang'){
  process.on('SIGTERM',()=>{});
  setInterval(()=>{},1000);
}else if(mode==='reply'){
  process.stdout.write(JSON.stringify({protocol:1,screenRecording:false,inputControl:true,
    requested:action==='status'?'none':action==='request-screen'?'screenRecording':'inputControl'})+'\n');
}else process.exit(2);
