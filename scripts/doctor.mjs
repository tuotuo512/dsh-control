import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--home'))throw Error('Usage: doctor.mjs [--home PATH]');
const home=path.resolve(args[1]||process.env.DSH_CONTROL_HOME||path.join(os.homedir(),'.codex','dsh-control-state'));
try{
  const dir=path.join(home,'install');
  const latest=fs.readdirSync(dir).filter(n=>/^receipt-.*\.json$/.test(n)).sort().at(-1);
  if(!latest)throw Error('No installation receipt found. Run setup and install:plugin first.');
  const receipt=JSON.parse(fs.readFileSync(path.join(dir,latest),'utf8'));
  const cli=path.join(receipt.serverDir,'cli.mjs');
  if(!fs.existsSync(cli))throw Error('Installed CLI is missing; inspect the installation with install:plugin verify.');
  const result=spawnSync(process.execPath,[cli,'doctor'],{stdio:'inherit',windowsHide:true,env:{...process.env,DSH_CONTROL_HOME:home}});
  if(result.error)throw result.error;process.exitCode=result.status??1;
}catch(error){console.error(JSON.stringify({error:error.message}));process.exitCode=1;}
