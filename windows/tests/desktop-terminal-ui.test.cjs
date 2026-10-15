'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const {Terminal}=require('../electron/mac/vendor/terminal/xterm.js');
const next=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('UI did not settle');}
async function fixture(t){
  class Element{constructor(id){this.id=id;this.value='';this.children=[];}append(...nodes){this.children.push(...nodes);}replaceChildren(){this.children=[];}showModal(){this.open=true;}close(){this.open=false;}}
  const elements=new Map(),document={getElementById:id=>{if(!elements.has(id))elements.set(id,new Element(id));return elements.get(id);},createElement:tag=>new Element(tag)};
  let term,pendingPoll,pendingPaste,state={phase:'ready',hostName:'PC',hostId:'h',view:'v1',screen:'s1',selected:'one',sessions:[{id:'one',shell:'cmd',state:'running',openSequence:1}],accepted:0,written:0};const calls=[],timers=[],events={};
  class TestTerminal extends Terminal{constructor(options){super(options);term=this;}open(){}focus(){}blur(){}loadAddon(){}paste(text){this.input(text,true);}attachCustomKeyEventHandler(fn){this.keyHandler=fn;}}
  const api={request:async(action,data)=>{calls.push({action,data});if(action==='poll')return new Promise(resolve=>{pendingPoll=resolve;});if(action==='paste')return new Promise(resolve=>{pendingPaste=resolve;});if(action==='select')state={...state,selected:data.id,view:'v2',screen:'s2',sessions:[...state.sessions,{id:data.id,shell:'cmd',state:'running',openSequence:2}]};return {...state};}};
  const context={window:{cliprelayTerminal:api,Terminal:TestTerminal,FitAddon:{FitAddon:class{fit(){}}},addEventListener:(event,fn)=>events[event]=fn},document,ResizeObserver:class{observe(){}},setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout(){},Uint8Array,atob:value=>Buffer.from(value,'base64').toString('binary'),btoa:value=>Buffer.from(value,'binary').toString('base64')};
  const filename=path.join(__dirname,'../electron/mac/terminal-ui.js');await vm.runInNewContext('(async()=>{'+fs.readFileSync(filename,'utf8')+'})()',context,{filename});await until(()=>pendingPoll);
  t.after(()=>events.beforeunload());
  async function frame(text,replay=false){const resolve=pendingPoll;pendingPoll=null;resolve({state:{...state},frame:{view:state.view,data:Buffer.from(text).toString('base64'),gap:false,replay,columns:100,rows:30}});await until(()=>timers.some(item=>item.ms===75));}
  async function more(){const index=timers.findIndex(item=>item.ms===75),timer=timers.splice(index,1)[0];timer.fn();await until(()=>pendingPoll);}
  return {elements,term,calls,frame,more,get state(){return state;},resolvePaste:text=>pendingPaste({text}),hasPaste:()=>!!pendingPaste};
}
test('the shipped xterm bundle renders UTF-8 and ANSI while historical queries and OSC clipboard requests have no effects',async t=>{
  const f=await fixture(t);await f.frame('中文 \x1b[31mred\x1b[0m\x1b[6n\x1b]52;c;c2VjcmV0\x07',true);assert.equal(f.term.buffer.active.getLine(0).translateToString(true),'中文 red');assert.equal(f.calls.filter(c=>['input','copy','paste'].includes(c.action)).length,0);
  await f.more();await f.frame('\x1b[6n',false);await until(()=>f.calls.some(c=>c.action==='input'));assert.match(f.calls.find(c=>c.action==='input').data.text,/^\x1b\[1;9R$/);
});
test('a clipboard response from the old session is discarded after switching sessions',async t=>{
  const f=await fixture(t),promise=f.elements.get('paste').onclick();await until(()=>f.hasPaste());const sessions=f.elements.get('sessions');sessions.value='two';sessions.onchange();await next();f.resolvePaste('must not enter other session');await promise;assert.equal(f.calls.filter(c=>c.action==='input').length,0);
});
test('end-session confirmation stays bound to the session shown when it was opened',async t=>{
  const f=await fixture(t);f.elements.get('end').onclick();const sessions=f.elements.get('sessions');sessions.value='two';sessions.onchange();await next();f.elements.get('end-confirm').onclick();await next();const command=f.calls.find(c=>c.action==='end');assert.equal(command.data.id,'one');assert.equal(command.data.view,'v1');
});
test('terminal third-party bundles match pinned manifests and are included in Windows packaging',()=>{
  const directory=path.join(__dirname,'../electron/mac/vendor/terminal'),manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'))),packaged=JSON.parse(fs.readFileSync(path.join(__dirname,'../electron/windows-files.json')));
  for(const dependency of manifest.packages){assert.match(dependency.url,/^https:\/\/registry\.npmjs\.org\/@xterm\//);for(const [name,expected] of Object.entries(dependency.files)){assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,name))).digest('hex'),expected);assert.ok(packaged.includes('mac/vendor/terminal/'+name));}}
});
