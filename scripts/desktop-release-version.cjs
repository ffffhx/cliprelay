'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
function versionFor(current,count){
  if(!/^\d+\.\d+\.\d+$/.test(current.versionName)||!Number.isSafeInteger(count)||count<1)throw new Error('Invalid desktop version inputs');
  const [major,minor,patch]=current.versionName.split('.').map(Number);
  return {versionName:`${major}.${minor}.${patch+count}`,versionCode:current.versionCode+count};
}
function main(){
  const root=path.resolve(__dirname,'..'),file=path.join(root,'windows/version.json');
  const current=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  const count=Number(execFileSync('git',['rev-list','--count','HEAD'],{cwd:root,encoding:'utf8'}).trim());
  const version=versionFor(current,count);
  fs.writeFileSync(file,JSON.stringify(version,null,2)+'\n');
  if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`version=${version.versionName}\ncode=${version.versionCode}\n`);
  console.log(JSON.stringify(version));
}
if(require.main===module)main();
module.exports={versionFor};
