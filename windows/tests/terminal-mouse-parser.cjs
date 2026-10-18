'use strict';
// The independent oracle is the exact xterm bundle shipped in the desktop app.
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {Terminal}=require('../electron/mac/vendor/terminal/xterm.js');
const cases=[];
for(const opening of ['\x1b]title','\x1bP1;2|','\x1b_','\x1b^','\x1bX']){
  for(const ending of ['[?1002h\x1b\\','\x1b[?1002l','\x9b?1003h','\x18[?1000h','\x1bc','\x9c\x1b[?1000h','\x85\x1b[?1000h'])cases.push('\x1b[?1002;1006h'+opening+ending);
}
for(const middle of ['é','\u061b','😀','\x9c','\x85','\x18','\x1a'])cases.push('\x1b[?1000;1006h\x1b[?1002'+middle+'h');
cases.push('\x1b[?1002;1006h\x1b[!p','\x1b[?1002h\x1b[?1000l','\x1b[?1000;h','\x1b[?1003;1016h','\x1b[?1006h\x1b[?1006l');
(async()=>{
  const process=spawnSync(global.process.argv[2],['--mouse-modes'],{input:cases.map(s=>Buffer.from(s).toString('base64')).join('\n')+'\n',encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(process.status,0,process.stderr);
  const observed=process.stdout.trim().split(/\r?\n/).map(row=>row.split(',').map(Number));assert.equal(observed.length,cases.length);
  for(let i=0;i<cases.length;i++){
    const term=new Terminal({logLevel:'off'});
    await new Promise(resolve=>term.write(Buffer.from(cases[i]),resolve));
    const mouse=term._core.coreMouseService;
    assert.deepEqual(observed[i],[{NONE:0,X10:9,VT200:1000,DRAG:1002,ANY:1003}[mouse.activeProtocol],{DEFAULT:0,SGR:1006,SGR_PIXELS:1016}[mouse.activeEncoding]],JSON.stringify(cases[i]));
    term.dispose();
  }
  console.log('PASS terminal mouse parser: '+cases.length+' cases agree with the shipped xterm parser, including byte-at-a-time host decoding');
})().catch(error=>{console.error(error);global.process.exitCode=1;});
