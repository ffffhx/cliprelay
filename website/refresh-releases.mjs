import {readFile,writeFile} from 'node:fs/promises';

const page=new URL('./dist/index.html',import.meta.url);
const base='https://124-221-36-36.anyip.dev:8443/cliprelay';
const channels={windows:{tag:/^windows-v\d+\.\d+\.\d+$/,asset:/^ClipRelay-Windows-\d+\.\d+\.\d+\.zip$/,manifest:`${base}/windows/update.json`,downloadKey:'downloadUrl'},android:{tag:/^android-v\d+\.\d+\.\d+$/,asset:/^ClipRelay-\d+\.\d+\.\d+\.apk$/,manifest:`${base}/update.json`,downloadKey:'apkUrl'}};
async function json(url) {
  const response=await fetch(url,{headers:{'User-Agent':'ClipRelay-Website','Accept':'application/json'},signal:AbortSignal.timeout(20000)});
  if(!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}`);
  return response.json();
}
function versionParts(tag){return tag.split('-v')[1].split('.').map(Number);}
function newer(a,b){const av=versionParts(a.tag_name),bv=versionParts(b.tag_name);for(let i=0;i<3;i++)if(av[i]!==bv[i])return av[i]>bv[i];return false;}
const latest={};
for(let number=1;number<=5;number++){
  const releases=await json(`https://api.github.com/repos/ffffhx/cliprelay/releases?per_page=100&page=${number}`);
  if(!Array.isArray(releases))throw new Error('Invalid GitHub release response');
  for(const [platform,channel] of Object.entries(channels))for(const release of releases){
    if(!release.draft&&!release.prerelease&&channel.tag.test(release.tag_name)&&(!latest[platform]||newer(release,latest[platform])))latest[platform]=release;
  }
  if(releases.length<100)break;
  if(number===5)throw new Error('Release list exceeds refresh limit; inspect GitHub before changing downloads');
}
let html=await readFile(page,'utf8');
function replaceOne(pattern,value){if(!pattern.test(html))throw new Error('Expected download field missing');html=html.replace(pattern,()=>value);}
const report=[];
for(const [platform,channel] of Object.entries(channels)){
  const release=latest[platform];if(!release)throw new Error(`No published ${platform} release found`);
  const version=release.tag_name.split('-v')[1];
  const asset=release.assets.find(item=>channel.asset.test(item.name)&&item.name.includes(version));
  if(!asset)throw new Error(`No ${platform} installer in release`);
  const prefix='https://github.com/ffffhx/cliprelay/releases/';
  if(!asset.browser_download_url.startsWith(`${prefix}download/`)||release.html_url!==`${prefix}tag/${release.tag_name}`)throw new Error('Unexpected release destination');
  let download=asset.browser_download_url;
  try{
    const manifest=await json(channel.manifest);
    const candidate=manifest[channel.downloadKey];
    const expected=`${base}/${platform==='windows'?'windows/':''}${asset.name}`;
    if(manifest.versionName===version&&candidate===expected){
      const response=await fetch(candidate,{method:'HEAD',signal:AbortSignal.timeout(20000)});
      if(response.ok&&Number(response.headers.get('content-length'))===asset.size)download=candidate;
    }
  }catch{console.warn(`${platform}: cloud source unavailable; using the published GitHub asset`);}
  replaceOne(new RegExp(`data-version="${platform}">[^<]+`),`data-version="${platform}">v${version}`);
  replaceOne(new RegExp(`data-size="${platform}">[^<]+`),`data-size="${platform}">${(asset.size/1048576).toFixed(1)} MB`);
  replaceOne(new RegExp(`data-download="${platform}" href="[^"]+"`),`data-download="${platform}" href="${download}"`);
  replaceOne(new RegExp(`data-release="${platform}" href="[^"]+"`),`data-release="${platform}" href="${release.html_url}"`);
  report.push({platform,version,download,size:asset.size});
}
const date=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',timeZone:'Asia/Shanghai'}).format(new Date());
replaceOne(/正式版信息核对于 [^<]+/,`正式版信息核对于 ${date}`);
await writeFile(page,html,'utf8');
console.log(JSON.stringify({updated:report,reminder:'Review development-feature notices before publishing.'},null,2));
