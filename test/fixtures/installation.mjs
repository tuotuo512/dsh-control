import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Minimal ASAR fixture for the archive reader, never an executable DSH runtime. */
export function fakeInstallation(base){
  const install=path.join(base,'application with space');fs.mkdirSync(path.join(install,'resources'),{recursive:true});
  const executable=path.join(install,'DeepSeek Harness.exe');fs.writeFileSync(executable,'fixture-not-executable');
  const version='0.2.2-rc.3',buildCommit='fixture-commit';
  const entries={
    'package.json':JSON.stringify({version,dshBuildCommit:buildCommit}),
    'dsh/node_modules/@deepseek-ai/dsh-sdk-protocol/package.json':JSON.stringify({version}),
    'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js':'// fixture entry\n',
  };
  const tree={files:{}},bodies=[];let offset=0;
  for(const [name,content]of Object.entries(entries)){
    const body=Buffer.from(content);let cursor=tree;const parts=name.split('/');
    for(const part of parts.slice(0,-1))cursor=cursor.files[part]??=( {files:{}} );
    cursor.files[parts.at(-1)]={size:body.length,offset:String(offset)};offset+=body.length;bodies.push(body);
  }
  const header=Buffer.from(JSON.stringify(tree)),prefix=Buffer.alloc(16);prefix.writeUInt32LE(header.length+8,4);prefix.writeUInt32LE(header.length,12);
  const bytes=Buffer.concat([prefix,header,...bodies]),archive=path.join(install,'resources','app.asar');fs.writeFileSync(archive,bytes);
  const archiveSha256=crypto.createHash('sha256').update(bytes).digest('hex');
  return {executable,archive,version,buildCommit,archiveSha256,config:{schemaVersion:1,executable,archive,
    cliEntry:path.join(archive,'dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js'),verifiedArchiveSha256:archiveSha256,
    defaultBackend:'sdk',provider:'fixture-provider',model:'fixture-model',maxParallel:2}};
}
