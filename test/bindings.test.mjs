import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readBindings,recordBinding,refreshBinding,bindingsPath} from '../src/bindings.mjs';

function fixture(){
  const parent=fs.realpathSync.native(os.tmpdir()),home=fs.mkdtempSync(path.join(parent,'dsh-bindings-'));
  return {home,close(){assert.equal(path.dirname(home),parent);assert.ok(path.basename(home).startsWith('dsh-bindings-'));fs.rmSync(home,{recursive:true,force:true});}};
}
const link=(home,sessionId='session-one')=>({sessionId,title:'对话',backend:'desktop',cwd:home,workspaceId:'workspace-one',workspaceTitle:'项目'});

test('legacy notes migrate connection identities only, without defaults, run state or chat content',async()=>{
  const f=fixture();try{
    fs.writeFileSync(bindingsPath(f.home),JSON.stringify({schemaVersion:1,defaultSessionId:'session-one',policy:{reuseExistingByDefault:true},conversations:{
      'session-one':{...link(f.home),registeredAt:'2026-11-15T00:00:00Z',lastRunId:'old-run',status:'completed',progress:'PRIVATE_PROGRESS',todo:'PRIVATE_TODO'}
    }}));
    await refreshBinding(f.home,{...link(f.home),exists:true,archived:false,running:false});
    const raw=fs.readFileSync(bindingsPath(f.home),'utf8'),note=readBindings(f.home);
    assert.deepEqual(Object.keys(note).sort(),['projects','schemaVersion']);
    assert.deepEqual(note.projects[0].conversations,[{sessionId:'session-one',title:'对话',backend:'desktop',linkedAt:'2026-11-15T00:00:00Z'}]);
    for(const unwanted of ['defaultSessionId','lastRunId','status','progress','todo','PRIVATE_'])assert.ok(!raw.includes(unwanted));
  }finally{f.close();}
});
test('concurrent connections survive reload and continuing a chat does not duplicate its link or date',async()=>{
  const f=fixture();try{
    await Promise.all(['session-one','session-two'].map(s=>recordBinding(f.home,link(f.home,s))));
    const first=readBindings(f.home).projects[0].conversations.find(c=>c.sessionId==='session-one').linkedAt;
    await recordBinding(f.home,{...link(f.home),title:'改名',linkedAt:'2099-01-01T00:00:00Z'});
    const reloaded=readBindings(f.home);assert.equal(reloaded.projects.length,1);assert.equal(reloaded.projects[0].conversations.length,2);
    assert.equal(reloaded.projects[0].conversations.find(c=>c.sessionId==='session-one').linkedAt,first);
  }finally{f.close();}
});
test('unknown checks preserve notes; exact archived or deleted checks remove only that conversation',async()=>{
  const f=fixture();try{
    await recordBinding(f.home,link(f.home));await recordBinding(f.home,link(f.home,'session-two'));
    const before=fs.readFileSync(bindingsPath(f.home),'utf8');
    await assert.rejects(refreshBinding(f.home,{sessionId:'session-one'}),/unknown/);
    assert.equal(fs.readFileSync(bindingsPath(f.home),'utf8'),before);
    await refreshBinding(f.home,{sessionId:'session-one',exists:true,archived:true});
    assert.deepEqual(readBindings(f.home).projects[0].conversations.map(c=>c.sessionId),['session-two']);
    await refreshBinding(f.home,{sessionId:'session-two',exists:false,archived:false});
    assert.equal(readBindings(f.home).projects[0].conversations.length,0);
  }finally{f.close();}
});
test('inspecting an unrelated conversation does not register it and corrupt notes are never replaced',async()=>{
  const f=fixture();try{
    await refreshBinding(f.home,{...link(f.home),exists:true,archived:false});assert.ok(!fs.existsSync(bindingsPath(f.home)));
    fs.writeFileSync(bindingsPath(f.home),'broken');await assert.rejects(recordBinding(f.home,link(f.home)));
    assert.equal(fs.readFileSync(bindingsPath(f.home),'utf8'),'broken');
  }finally{f.close();}
});
test('native inspection cannot remove a connection owned by a different backend',async()=>{
  const f=fixture();try{
    await recordBinding(f.home,{...link(f.home),backend:'acp'});
    const before=fs.readFileSync(bindingsPath(f.home),'utf8');
    await refreshBinding(f.home,{sessionId:'session-one',exists:false,archived:false});
    await refreshBinding(f.home,{sessionId:'session-one',exists:true,archived:true});
    assert.equal(fs.readFileSync(bindingsPath(f.home),'utf8'),before);
  }finally{f.close();}
});
