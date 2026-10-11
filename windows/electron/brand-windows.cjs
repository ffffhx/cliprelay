'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
async function brand(){
  const root=path.resolve(__dirname,'..');
  const version=JSON.parse(fs.readFileSync(path.join(root,'version.json'),'utf8').replace(/^\uFEFF/,'')).versionName;
  const {resedit}=await import(pathToFileURL(path.join(path.dirname(require.resolve('@electron/packager')),'resedit.js')).href);
  await resedit(path.resolve(process.argv[2]),{iconPath:path.join(root,'cliprelay.ico'),fileVersion:version,productVersion:version,productName:'ClipRelay',win32Metadata:{CompanyName:'ClipRelay',FileDescription:'ClipRelay',InternalName:'ClipRelay',OriginalFilename:'ClipRelay.exe'}});
}
brand().catch(error=>{console.error(error);process.exitCode=1;});
