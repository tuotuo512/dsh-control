import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createController} from '../src/controller.mjs';
import {workspacePolicy, updateWorkspacePolicy, policyPath} from '../src/permissions.mjs';
import {writeJson, loadState, saveState} from '../src/store.mjs';
import {invoke} from '../src/mcp.mjs';

function fixture() {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-policy-'));
  const cwd=path.join(home,'repo');fs.mkdirSync(cwd);fs.mkdirSync(path.join(cwd,'child'));
  writeJson(path.join(home,'config.json'),{schemaVersion:1,executable:'fixture',archive:'fixture',cliEntry:'fixture',verifiedArchiveSha256:'hash',provider:'test',model:'test',maxParallel:2});
  const launches=[];
  const controller=createController({home,inspect:()=>({compatible:true,archiveSha256:'hash'}),launch:(_,id)=>launches.push(id)});
  return {home,cwd,launches,controller,close:()=>fs.rmSync(home,{recursive:true,force:true})};
}
test('policy uses exact canonical workspace, CAS, restart persistence and reset',async()=>{
  const f=fixture();try {
    assert.equal(workspacePolicy(f.home,f.cwd).permission,'read-only');
    const value=await f.controller.workspace_policy({cwd:f.cwd,permission:'danger-full-access',expectedRevision:0});
    assert.equal(value.permission,'danger-full-access');assert.equal(value.source,'project');
    assert.equal(workspacePolicy(f.home,path.join(f.cwd,'child')).permission,'read-only');
    await assert.rejects(updateWorkspacePolicy(f.home,{cwd:f.cwd,permission:'workspace-write',expectedRevision:0}),/revision changed/);
    await assert.rejects(updateWorkspacePolicy(f.home,{cwd:f.cwd,permission:'unknown',expectedRevision:1}),/Invalid permission/);
    await assert.rejects(updateWorkspacePolicy(f.home,{cwd:f.cwd,permission:'read-only'}),/expectedRevision/);
    const reread=createController({home:f.home});assert.equal((await reread.workspace_policy({cwd:f.cwd})).permission,'danger-full-access');
    assert.equal((await f.controller.workspace_policy({cwd:f.cwd,permission:null,expectedRevision:1})).source,'default');
    fs.writeFileSync(policyPath(f.home),'{}');assert.throws(()=>workspacePolicy(f.home,f.cwd),/Invalid workspace permission/);
  } finally {f.close();}
});
test('full access retains ownership, overlap, explicit override, frozen continuation and idempotency',async()=>{
  const f=fixture();try {
    await f.controller.workspace_policy({cwd:f.cwd,permission:'danger-full-access',expectedRevision:0});
    const request={requestId:'full',cwd:f.cwd,prompt:'bounded work',ownedPaths:[path.join(f.cwd,'src')]};
    await assert.rejects(f.controller.start({...request,ownedPaths:[]}),/requires explicit ownedPaths/);
    await assert.rejects(f.controller.start({...request,ownedPaths:[f.home]}),/inside/);
    const first=await f.controller.start(request);assert.equal(first.permission,'danger-full-access');
    await assert.rejects(f.controller.start({...request,requestId:'overlap',permission:'workspace-write'}),/overlaps/);
    await f.controller.workspace_policy({cwd:f.cwd,permission:'read-only',expectedRevision:1});
    assert.equal((await f.controller.start(request)).deduplicated,true);
    const state=loadState(f.home,first.runId,false);state.status='completed';state.runtimeOwnership='released';saveState(f.home,state);
    const next=await f.controller.send({requestId:'next',sessionId:first.sessionId,prompt:'continue'});assert.equal(next.permission,'danger-full-access');
    const other=await f.controller.start({requestId:'readonly',cwd:f.cwd,prompt:'observe',permission:'read-only'});assert.equal(other.permission,'read-only');
    assert.equal(f.launches.length,3);
  } finally {f.close();}
});
test('preflight is zero launch, exact, reports conflicts and ACP unsupported full access',async()=>{
  const f=fixture();try {
    await f.controller.workspace_policy({cwd:f.cwd,permission:'danger-full-access',expectedRevision:0});
    const params={cwd:f.cwd,ownedPaths:[path.join(f.cwd,'src')]};
    const result=await f.controller.preflight(params);assert.equal(result.ready,true);assert.equal(result.shell,'not_probed');assert.equal(result.callsModel,false);assert.equal(f.launches.length,0);
    assert.ok((await f.controller.preflight({...params,backend:'acp'})).blockers.includes('acp_full_access_unverified'));
    await assert.rejects(f.controller.start({...params,backend:'acp',requestId:'acp-full',prompt:'work'}),/has not been verified/);
    assert.equal(f.launches.length,0);
    await f.controller.start({...params,requestId:'owner',prompt:'work'});
    assert.ok((await f.controller.preflight(params)).blockers.includes('write_ownership_overlap'));
    const value=await f.controller.list({compact:true});assert.equal(value.runs[0].permission,'danger-full-access');assert.ok(!Object.hasOwn(value.runs[0],'runtime'));
    const compact=await f.controller.wait({runIds:[value.runs[0].runId],timeoutMs:0,compact:true});assert.equal(compact.reason,'timeout');assert.ok(!Object.hasOwn(compact.runs[0],'ownedPaths'));
  } finally {f.close();}
});
test('MCP keeps absent permission absent and accepts project policy and compact modes',async()=>{
  let got;const spy={start:async x=>(got=x),workspace_policy:async x=>(got=x),preflight:async x=>(got=x)};
  await invoke(spy,'start',{requestId:'x',cwd:'absolute-vetted-later',prompt:'task',permission:'danger-full-access',ownedPaths:['src']});assert.equal(got.permission,'danger-full-access');
  await invoke(spy,'workspace_policy',{cwd:'repo',permission:null,expectedRevision:4});assert.equal(got.permission,null);
  await invoke(spy,'preflight',{cwd:'repo'});assert.equal(got.permission,undefined);
  await assert.rejects(invoke(spy,'start',{requestId:'x',cwd:'repo',prompt:'task',permission:'admin'}));
});
test('pre-policy request receipts remain idempotent after upgrade',async()=>{
 const f=fixture();try{
  const input={requestId:'legacy',cwd:f.cwd,prompt:'old assignment'};
  const receipt=await f.controller.start(input);
  const state=loadState(f.home,receipt.runId,false);
  delete state.permissionSource;
  const legacy={operation:'start',...input,cwd:fs.realpathSync.native(f.cwd),backend:'sdk',permission:'read-only',ownedPaths:[],timeoutSeconds:1800};
  state.signature=crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(legacy).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
  saveState(f.home,state);
  await f.controller.workspace_policy({cwd:f.cwd,permission:'danger-full-access',expectedRevision:0});
  assert.equal((await f.controller.start(input)).deduplicated,true);
  assert.equal(f.launches.length,1);
  await assert.rejects(f.controller.start({...input,prompt:'changed'}),/different arguments/);
 }finally{f.close();}
});
