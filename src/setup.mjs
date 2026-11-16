import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readArchive} from './runtime.mjs';

const matrix=JSON.parse(fs.readFileSync(new URL('../compatibility.json',import.meta.url),'utf8'));
const text=(value,name)=>{if(typeof value!=='string'||!value.trim())throw Error(`${name} must be nonempty`);return value;};
const modelScalar=(block,key)=>{
  const value=block.match(new RegExp(`^\\s+${key}:\\s*([^\\r\\n#]+)`, 'm'))?.[1].trim().replace(/^['"]|['"]$/g,'');
  return value&&/^[a-zA-Z0-9._:/+-]+$/.test(value)?value:undefined;
};

/** Inspect an installed application and an existing profile; never read credentials. */
export function setupPlan(options={},dependencies={}){
  const env=dependencies.env||process.env,platform=dependencies.platform||process.platform;
  const userDir=dependencies.userDir||os.homedir();
  if(platform!=='win32')throw Error('This preview supports Windows only; other platforms have not been validated.');
  const home=path.resolve(options.home||env.DSH_CONTROL_HOME||path.join(userDir,'.codex','dsh-control-state'));
  if(home===path.parse(home).root||home===path.resolve(userDir))throw Error('Choose a dedicated bridge state directory, not a drive or user-profile root.');
  const dshHome=path.resolve(options.dshHome||env.DSH_HOME||path.join(userDir,'.dsh'));
  const profile=options.profile||'desktop';
  if(!/^[a-zA-Z0-9._-]+$/.test(profile)||profile==='.'||profile==='..')throw Error('Invalid profile name');
  const provided=options.executable||env.DSH_EXECUTABLE;
  const candidates=provided?[path.resolve(provided)]:[
    path.join(env.LOCALAPPDATA||path.join(userDir,'AppData','Local'),'Programs','DeepSeek Harness','DeepSeek Harness.exe'),
    path.join(env.ProgramFiles||'C:\\Program Files','DeepSeek Harness','DeepSeek Harness.exe'),
  ];
  const found=[...new Set(candidates.filter(f=>fs.existsSync(f)).map(f=>fs.realpathSync.native(f)))];
  if(found.length!==1)throw Error(found.length?'Multiple installations found; select --executable explicitly.':'DeepSeek Harness was not found. Install and open it first, or pass --executable <path>.');
  const executable=found[0],archive=path.join(path.dirname(executable),'resources','app.asar');
  const installed=(dependencies.readArchive||readArchive)(archive);
  const pkg=JSON.parse(installed.read('package.json'));
  const protocol=JSON.parse(installed.read('dsh/node_modules/@deepseek-ai/dsh-sdk-protocol/package.json'));
  installed.read('dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
  const supported=(dependencies.matrix||matrix).artifacts.some(a=>a.platform===platform&&a.version===pkg.version&&a.buildCommit===pkg.dshBuildCommit&&a.archiveSha256===installed.sha256&&a.protocolPackageVersion===protocol.version);
  if(!supported)throw Error(`Unsupported DeepSeek Harness build ${pkg.version}. Its version and archive digest must match compatibility.json; no configuration was written.`);
  const profileDir=path.join(dshHome,'profiles',profile);
  const manifestFile=path.join(profileDir,'package.json'),patchFile=path.join(profileDir,'cordis.patch.yml');
  if(!fs.existsSync(manifestFile)||!fs.existsSync(patchFile))throw Error('Initialize the profile in DeepSeek Harness first; the bridge does not create accounts or profiles.');
  const profileManifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  const backend=options.backend||'desktop';
  if(!['desktop','sdk','acp'].includes(backend))throw Error('backend must be desktop, sdk or acp');
  if(backend==='desktop'&&profileManifest.dsh?.profile?.patchReload!=='live')throw Error('The selected Desktop profile must support live patch reload; no profile was changed.');
  const settings=fs.readFileSync(patchFile,'utf8');
  const block=settings.match(/^- id: agent-default-model\r?\n([\s\S]*?)(?=^- id:|(?![\s\S]))/m)?.[1]||'';
  const provider=options.provider||modelScalar(block,'provider'),model=options.model||modelScalar(block,'model');
  if(!provider||!model)throw Error('No explicit provider/model was found. Configure them in DeepSeek Harness or pass --provider and --model.');
  text(provider,'provider');text(model,'model');
  const reasoningEffort=options.reasoningEffort||modelScalar(block,'reasoningEffort');
  const maxParallel=options.maxParallel===undefined?2:Number(options.maxParallel);
  if(!Number.isInteger(maxParallel)||maxParallel<1||maxParallel>8)throw Error('max-parallel must be 1..8');
  const config={schemaVersion:1,executable,archive,cliEntry:path.join(archive,'dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js'),
    verifiedVersion:pkg.version,verifiedArchiveSha256:installed.sha256,provider,model,...(reasoningEffort?{reasoningEffort}:{}),
    defaultBackend:backend,maxParallel,dshHome,desktopProfile:profile,verifiedAt:new Date().toISOString()};
  const configPath=path.join(home,'config.json');
  return {mode:'plan',configPath,alreadyConfigured:fs.existsSync(configPath),supported:true,config};
}
export function initialize(options={},dependencies={}){
  const result=setupPlan(options,dependencies);
  if(result.alreadyConfigured)throw Error('Configuration already exists. Use doctor and inspect the current pin; setup never overwrites it.');
  fs.mkdirSync(path.dirname(result.configPath),{recursive:true});
  fs.writeFileSync(result.configPath,JSON.stringify(result.config,null,2)+'\n',{flag:'wx',mode:0o600});
  return {...result,mode:'written',alreadyConfigured:true};
}
export function setupArgs(args){
  const options={},names={home:'home','dsh-home':'dshHome',profile:'profile',executable:'executable',provider:'provider',model:'model','reasoning-effort':'reasoningEffort',backend:'backend','max-parallel':'maxParallel'};
  let mode='plan';
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--plan'||arg==='--write'){if(options.modeChosen&&mode!==arg.slice(2))throw Error('Choose either --plan or --write');mode=arg.slice(2);options.modeChosen=true;continue;}
    const equal=arg.indexOf('=');const key=arg.slice(2,equal<0?undefined:equal),inline=equal<0?undefined:arg.slice(equal+1);
    if(!arg.startsWith('--')||!names[key])throw Error(`Unknown option ${arg}`);
    const value=inline??args[++i];if(!value||value.startsWith('--'))throw Error(`Missing value for --${key}`);options[names[key]]=value;
  }
  delete options.modeChosen;return {mode,options};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    if(process.argv.includes('--help'))console.log('Usage: node src/setup.mjs [--plan|--write] [--executable PATH] [--home PATH] [--dsh-home PATH] [--profile desktop] [--provider ID --model ID] [--reasoning-effort VALUE] [--backend desktop|sdk|acp] [--max-parallel 2]\nThe default is read-only --plan. --write creates a new configuration and never overwrites an existing one.');
    else{const {mode,options}=setupArgs(process.argv.slice(2));console.log(JSON.stringify(mode==='write'?initialize(options):setupPlan(options),null,2));}
  }catch(error){console.error(JSON.stringify({error:error.message}));process.exitCode=1;}
}
