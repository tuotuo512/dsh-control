import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const top=['README.md','README.zh-CN.md','LICENSE','NOTICE.md','CHANGELOG.md','AGENTS.md','.gitignore','.gitattributes','package.json','package-lock.json','compatibility.json'];
const scripts=['build.mjs','install.mjs','doctor.mjs','public-release.mjs'];
const docs=['contract.md','INSTALL.md','INSTALL.zh-CN.md','COMPATIBILITY.md','RELEASING.md'];
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function walk(dir,base=dir){
  return fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>{
    if(e.isSymbolicLink())throw Error(`Symlinks are not release inputs: ${path.relative(root,path.join(dir,e.name))}`);
    return e.isDirectory()?walk(path.join(dir,e.name),base):[path.relative(base,path.join(dir,e.name)).split(path.sep).join('/')];
  });
}
export function publicFiles(source=root){
  return [...top,...scripts.map(f=>'scripts/'+f),...docs.map(f=>'docs/'+f),'.github/workflows/ci.yml',
    ...walk(path.join(source,'src')).filter(f=>f.endsWith('.mjs')&&f!=='desktop-setup.mjs').map(f=>'src/'+f),
    ...['packages','skill','test'].flatMap(d=>walk(path.join(source,d)).filter(f=>!f.endsWith('.tmp')).map(f=>d+'/'+f))].sort();
}
function copy(source,target,rel){
  const from=path.join(source,rel),to=path.join(target,rel);fs.mkdirSync(path.dirname(to),{recursive:true});
  if(/\.(?:[cm]?js|json|md|ya?ml|txt)$/.test(rel)||['LICENSE','.gitignore','.gitattributes'].includes(path.basename(rel)))fs.writeFileSync(to,fs.readFileSync(from,'utf8').replace(/\r\n/g,'\n'));
  else fs.copyFileSync(from,to);
}
function checkText(text,file){
  // Report filenames only; never echo matched credential or local-profile content.
  if(/[a-z]:[\\/]+Users[\\/]+(?!Public(?:[\\/]|$)|Example(?:[\\/]|$)|<user>)[^\\/\s"']+/i.test(text))throw Error(`Personal profile path in ${file}`);
  if(/\bsk-(?:proj-)?[a-zA-Z0-9_-]{24,}\b/.test(text))throw Error(`Possible credential in ${file}`);
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw Error(`Unexpected control character in ${file}`);
}
export function checkRelease(source=root){
  const files=publicFiles(source);
  for(const file of files){const stat=fs.lstatSync(path.join(source,file));if(stat.isSymbolicLink()||!stat.isFile())throw Error(`Invalid release file: ${file}`);checkText(fs.readFileSync(path.join(source,file),'utf8'),file);}
  const selected=new Set(files);
  for(const file of files.filter(f=>f.endsWith('.md'))){
    for(const match of fs.readFileSync(path.join(source,file),'utf8').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
      const target=match[1].split('#')[0];if(!target||/^[a-z]+:/i.test(target))continue;
      const relative=path.relative(source,path.resolve(source,path.dirname(file),target)).split(path.sep).join('/');
      if(!selected.has(relative))throw Error(`Markdown link is outside the public source allowlist: ${file}`);
    }
  }
  const pkg=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
  if(pkg.license!=='MIT')throw Error('Release license must match the approved MIT license');
  if(['install','preinstall','postinstall'].some(k=>pkg.scripts[k]))throw Error('Dependency installation must not modify a user application');
  for(const file of ['packages/codex-plugin/package.json','packages/codex-plugin/plugin.json','packages/codex-plugin/.codex-plugin/plugin.json','packages/dsh-plugin/package.json']){
    const p=JSON.parse(fs.readFileSync(path.join(source,file),'utf8'));if(p.version!==pkg.version||p.license!=='MIT')throw Error(`Version/license mismatch: ${file}`);
  }
  return {ok:true,version:pkg.version,files,scope:'Allowlisted public source; development Git history and private evidence are excluded'};
}
function emptyDestination(source,target){
  target=path.resolve(target);source=fs.realpathSync.native(source);
  const inside=(a,b)=>{const r=path.relative(a,b);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
  if(inside(source,target)||inside(target,source)||target===path.parse(target).root)throw Error('Release destination must be outside the source tree and cannot contain it');
  if(fs.existsSync(target)&&(fs.lstatSync(target).isSymbolicLink()||fs.readdirSync(target).length))throw Error('Release destination must be new or empty; existing data is never removed');
  return target;
}
export function exportPublic(target,source=root){
  const checked=checkRelease(source);target=emptyDestination(source,target);fs.mkdirSync(target,{recursive:true});
  for(const file of checked.files)copy(source,target,file);
  const plugin=path.join(target,'plugins','dsh-control');fs.mkdirSync(plugin,{recursive:true});
  for(const file of ['plugin.json','.codex-plugin/plugin.json'])copy(path.join(source,'packages','codex-plugin'),plugin,file);
  for(const rel of walk(path.join(source,'skill')))copy(path.join(source,'skill'),path.join(plugin,'skills','dsh-control'),rel);
  fs.mkdirSync(path.join(target,'.agents','plugins'),{recursive:true});
  fs.writeFileSync(path.join(target,'.agents','plugins','marketplace.json'),JSON.stringify({name:'dsh-control-local',interface:{displayName:'DSH Control'},plugins:[{name:'dsh-control',source:{source:'local',path:'./plugins/dsh-control'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Developer Tools'}]},null,2)+'\n');
  const entries=walk(target).map(file=>({path:file,sha256:sha(path.join(target,file))}));
  fs.writeFileSync(path.join(target,'PUBLIC_EXPORT.json'),JSON.stringify({schemaVersion:1,version:checked.version,files:entries},null,2)+'\n');
  return {ok:true,version:checked.version,target,files:entries.length,includesGitHistory:false};
}
export function archiveRelease(output,source=root){
  output=emptyDestination(source,output);fs.mkdirSync(output,{recursive:true});
  const version=checkRelease(source).version,dist=path.join(source,'dist');
  if(!fs.existsSync(path.join(dist,'manifest.json')))throw Error('Build the plugin before creating release archives');
  const manifest=JSON.parse(fs.readFileSync(path.join(dist,'manifest.json'),'utf8'));
  if(manifest.version!==version||manifest.packages.codex.version!==version)throw Error('Build version does not match source');
  for(const [key,dir]of [['codex','codex-plugin'],['dsh','dsh-plugin']])for(const file of manifest.packages[key].files){
    if(path.isAbsolute(file.path)||file.path.split('/').includes('..')||sha(path.join(dist,dir,file.path))!==file.sha256)throw Error('Built artifact changed; rebuild before archiving');
  }
  for(const file of walk(path.join(source,'src'))){const built=path.join(dist,'codex-plugin','server',file);if(fs.existsSync(built)&&sha(built)!==sha(path.join(source,'src',file)))throw Error('Built server is stale; rebuild before archiving');}
  const stage=path.join(output,'staging');fs.mkdirSync(stage);
  const sourceName=`dsh-control-${version}-source`,bundleName=`dsh-control-${version}-bundle`;
  exportPublic(path.join(stage,sourceName),source);exportPublic(path.join(stage,bundleName),source);
  fs.cpSync(dist,path.join(stage,bundleName,'dist'),{recursive:true});
  const assets=[];
  for(const name of [sourceName,bundleName]){
    const filename=name+'.tar.gz',file=path.join(output,filename);
    execFileSync('tar',['-czf',file,'-C',stage,name],{windowsHide:true,stdio:'pipe'});
    assets.push({file:filename,sha256:sha(file),bytes:fs.statSync(file).size});
  }
  fs.writeFileSync(path.join(output,'SHA256SUMS.txt'),assets.map(a=>`${a.sha256}  ${a.file}`).join('\n')+'\n');
  return {ok:true,version,assets,output,modelRequests:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const [command='check',...args]=process.argv.slice(2);let output;
    if(args.length){if(args.length!==2||args[0]!=='--out')throw Error('Use --out <new directory>');output=args[1];}
    let result;if(command==='check')result=checkRelease();else if(command==='export'&&output)result=exportPublic(output);else if(command==='archive'&&output)result=archiveRelease(output);else throw Error('Usage: public-release.mjs check | export --out DIR | archive --out DIR');
    console.log(JSON.stringify(result,null,2));
  }catch(error){console.error(JSON.stringify({error:error.message}));process.exitCode=1;}
}
