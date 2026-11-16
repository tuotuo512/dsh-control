import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkRelease,exportPublic} from '../scripts/public-release.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function fixture(){const parent=fs.realpathSync.native(os.tmpdir()),base=fs.mkdtempSync(path.join(parent,'dsh-public-'));return{base,close(){assert.equal(path.dirname(base),parent);assert.ok(path.basename(base).startsWith('dsh-public-'));fs.rmSync(base,{recursive:true,force:true});}};}
test('public source export includes current implementation and marketplace but excludes history, runtime notes and private records',()=>{
  const f=fixture();try{
    const source=path.join(f.base,'source'),out=path.join(f.base,'public');exportPublic(source);
    for(const rel of ['.git/private-history','docs/verification-private.json','exports/chat.txt','config.json','conversation-bindings.json']){fs.mkdirSync(path.dirname(path.join(source,rel)),{recursive:true});fs.writeFileSync(path.join(source,rel),'PRIVATE_FIXTURE');}
    const result=exportPublic(out,source);assert.equal(result.includesGitHistory,false);
    assert.ok(fs.existsSync(path.join(out,'src','bindings.mjs')));assert.ok(fs.existsSync(path.join(out,'README.zh-CN.md')));
    assert.ok(fs.existsSync(path.join(out,'plugins','dsh-control','skills','dsh-control','SKILL.md')));
    assert.ok(fs.existsSync(path.join(out,'.agents','plugins','marketplace.json')));
    assert.ok(!fs.existsSync(path.join(out,'.git')));assert.ok(!fs.existsSync(path.join(out,'config.json')));assert.ok(!fs.existsSync(path.join(out,'docs','verification-private.json')));assert.ok(!fs.existsSync(path.join(out,'exports')));
    const files=JSON.parse(fs.readFileSync(path.join(out,'PUBLIC_EXPORT.json'),'utf8')).files;assert.ok(files.every(f=>!path.isAbsolute(f.path)&&!f.path.includes('..')));
  }finally{f.close();}
});
test('export refuses an existing destination or a source descendant and preserves existing files',()=>{
  const f=fixture();try{
    const target=path.join(f.base,'occupied');fs.mkdirSync(target);fs.writeFileSync(path.join(target,'keep.txt'),'keep');
    assert.throws(()=>exportPublic(target),/new or empty/);assert.equal(fs.readFileSync(path.join(target,'keep.txt'),'utf8'),'keep');
    assert.throws(()=>exportPublic(path.join(root,'unexpected-export')),/outside/);assert.ok(!fs.existsSync(path.join(root,'unexpected-export')));
  }finally{f.close();}
});
test('release entry points have no automatic npm install lifecycle and versions/licenses agree',()=>{
  const result=checkRelease();assert.equal(result.ok,true);assert.equal(result.version,'0.6.0');
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));assert.equal(pkg.scripts.install,undefined);assert.equal(pkg.license,'MIT');
});
test('release check rejects corrupted documentation and links to excluded private files',()=>{
  const f=fixture();try{
    const source=path.join(f.base,'source');exportPublic(source);
    const readme=path.join(source,'README.md'),before=fs.readFileSync(readme,'utf8');
    fs.appendFileSync(readme,'\u0007');assert.throws(()=>checkRelease(source),/control character/);
    fs.writeFileSync(readme,before+'\n[private](docs/verification-private.json)\n');fs.writeFileSync(path.join(source,'docs','verification-private.json'),'{}');
    assert.throws(()=>checkRelease(source),/outside the public source allowlist/);
  }finally{f.close();}
});
