'use strict';
// Disposable child process only; no capture, network or user state.
const mode=process.argv[2];
process.on('SIGTERM',()=>{if(mode!=='ignore')process.exit(0);});
process.stdin.on('end',()=>{if(mode!=='ignore')process.exit(0);});
process.stdin.resume();
process.send?.({ready:true});
if(mode==='exit')setTimeout(()=>process.exit(7),100);
setInterval(()=>{},1000);
