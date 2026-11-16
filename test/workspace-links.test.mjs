import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {DesktopHostController,listenDesktop} from '../src/desktop-host.mjs';
import {createController} from '../src/controller.mjs';
import {runWorker} from '../src/worker.mjs';
import {writeJson} from '../src/store.mjs';
import {readBindings,recordBinding,bindingsPath} from '../src/bindings.mjs';

async function fixture(){
  const parent=fs.realpathSync.native(os.tmpdir()),home=fs.mkdtempSync(path.join(parent,'dsh-workspaces-'));
  const bus=new EventEmitter(),agents=new Map(),stored=new Map(),calls=[],workspaces=[],jobs=[];
  const addWorkspace=(id,title)=>{
    const cwd=path.join(home,id);fs.mkdirSync(cwd);
    const w={id,title,path:cwd,sessionIds:[],async attachSession(sid){if(!this.sessionIds.includes(sid))this.sessionIds.push(sid);}};
    workspaces.push(w);return w;
  };
  const a=addWorkspace('workspace-a','同名项目'),b=addWorkspace('workspace-b','同名项目'),empty=addWorkspace('workspace-empty','空项目');
  const make=(sid,workspace)=>{
    const session={id:sid,header:{id:sid,cwd:workspace.path},seq:1};stored.set(sid,{header:session.header});
    const agent={session,status:'idle',inbox:{nextTurn:[],nextStep:[]},whenIdle:async()=>{},model:{select(){},current:()=>({provider:'p',model:'m'})}};
    agents.set(sid,agent);return agent;
  };
  const ctx={agents,on:(name,handler)=>{bus.on(name,handler);return()=>bus.off(name,handler);},typertGateway:{getPendingRemoteEvents:()=>[]},waterfall:async()=>[],
    llm:{resolveCallConfig:async()=>{}},permissionPresets:{set(){}},sessionPersistence:{stat:async sid=>stored.get(sid)},sessionProjections:{snapshot:session=>({values:{title:'对话-'+session.id}})},
    workspaceRegistry:{archivedSessionIds:[],list:()=>workspaces,get:id=>workspaces.find(w=>w.id===id),create:async cwd=>{
      calls.push(['workspace-create',cwd]);return workspaces.find(w=>w.path===cwd)||addWorkspace('workspace-new',path.basename(cwd));
    }}};
  ctx.sessionController={
    create:async request=>{calls.push(['create',request]);make(request.sessionId,ctx.workspaceRegistry.get(request.workspaceId));await ctx.workspaceRegistry.get(request.workspaceId).attachSession(request.sessionId);return {sessionId:request.sessionId};},
    resolveAgent:async sid=>({agent:agents.get(sid)}),rename:async request=>calls.push(['rename',request]),
    prompt:async request=>{
      calls.push(['prompt',request]);const agent=agents.get(request.sessionId);agent.status='running';
      setTimeout(()=>{
        bus.emit('session/event',agent.session,{seq:++agent.session.seq,type:'user/message',data:{source:{kind:'user',rpcId:request.requestId}}});
        bus.emit('session/event',agent.session,{seq:++agent.session.seq,type:'assistant/message',data:{message:{content:[{type:'text',text:'OK'}]}}});
        agent.status='idle';bus.emit('session/event',agent.session,{seq:++agent.session.seq,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
        bus.emit('agent/status',{agent,status:'idle'});
      },1);
    },cancel:request=>calls.push(['cancel',request]),updateQueue:async()=>{},list:async()=>({items:[]})
  };
  const native=new DesktopHostController(ctx,{home,runtime:{pid:123,instanceId:'fixture',archiveSha256:'hash'}});
  const listener=await listenDesktop(native,{token:'fixture-token'});
  writeJson(path.join(home,'desktop-connection.json'),{schemaVersion:1,protocolVersion:1,url:listener.url,token:listener.token,instanceId:'fixture',archiveSha256:'hash'});
  writeJson(path.join(home,'config.json'),{schemaVersion:1,defaultBackend:'desktop',executable:'fixture',archive:'fixture',cliEntry:'fixture',verifiedArchiveSha256:'hash',maxParallel:2,provider:'p',model:'m'});
  const controller=()=>createController({home,inspect:()=>({compatible:true}),launch:(h,id)=>{jobs.push(runWorker(h,id,{inspect:()=>({compatible:true})}));}});
  const input={runId:'run-'+'a'.repeat(24),requestId:'manual',sessionId:'session-manual',cwd:b.path,workspaceId:b.id,title:'测试',permission:'read-only',ownedPaths:[],provider:'p',model:'m',timeoutSeconds:30};
  return {home,ctx,agents,stored,calls,workspaces,jobs,native,a,b,empty,make,controller,input,async close(){
    await Promise.allSettled(jobs);await native.close();await listener.close();
    assert.equal(path.dirname(home),parent);assert.ok(path.basename(home).startsWith('dsh-workspaces-'));fs.rmSync(home,{recursive:true,force:true});
  }};
}

test('workspace discovery includes empty workspaces and separates identical titles without mutation',async()=>{
  const f=await fixture();try{
    const c=f.controller(),first=await c.desktop_workspaces({limit:2});assert.equal(first.total,3);assert.equal(first.nextOffset,2);
    assert.equal(first.workspaces[0].title,first.workspaces[1].title);assert.notEqual(first.workspaces[0].workspaceId,first.workspaces[1].workspaceId);
    const last=await c.desktop_workspaces({offset:2});assert.equal(last.workspaces[0].sessionCount,0);assert.equal(last.nextOffset,null);assert.equal(f.calls.length,0);
  }finally{await f.close();}
});
test('selected workspace is used by identity; unknown ids and directory conflicts cannot create substitutes',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.native.open({...f.input,workspaceId:'missing'}),e=>e.code==='DSH_WORKSPACE_NOT_FOUND');
    await assert.rejects(f.native.open({...f.input,cwd:f.a.path}),e=>e.code==='DSH_WORKSPACE_MISMATCH');
    assert.equal(f.calls.length,0);
    const receipt=await f.native.open(f.input);assert.equal(receipt.workspaceId,f.b.id);assert.equal(f.agents.get(f.input.sessionId).session.header.cwd,f.b.path);
    assert.equal(f.calls.filter(c=>c[0]==='workspace-create').length,0);assert.ok(!f.a.sessionIds.includes(f.input.sessionId));
  }finally{await f.close();}
});
test('exact archived and deleted lookups do not rely on a finite session list',async()=>{
  const f=await fixture();try{
    f.make('session-old',f.a);await f.a.attachSession('session-old');f.ctx.workspaceRegistry.archivedSessionIds.push('session-old');
    const archived=await f.controller().desktop_session({sessionId:'session-old'});assert.equal(archived.exists,true);assert.equal(archived.archived,true);assert.equal(archived.workspaceId,f.a.id);
    const deleted=await f.controller().desktop_session({sessionId:'session-deleted'});assert.equal(deleted.exists,false);assert.equal(deleted.archived,false);
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});
test('accepted native work records a link, a next-day controller resumes it, and retries never duplicate chats',async()=>{
  const f=await fixture();try{
    const firstInput={requestId:'first',cwd:f.b.path,workspaceId:f.b.id,backend:'desktop',prompt:'hello',title:'项目对话'};
    const first=await f.controller().start(firstInput);await Promise.all(f.jobs);
    assert.equal((await f.controller().status({runId:first.runId})).status,'completed');
    const before=readBindings(f.home).projects[0];assert.equal(before.workspaceId,f.b.id);assert.equal(before.conversations.length,1);
    const linkedAt=before.conversations[0].linkedAt;
    const next=await f.controller().send({requestId:'next-day',sessionId:first.sessionId,prompt:'continue'});await Promise.all(f.jobs);
    assert.equal(next.sessionId,first.sessionId);assert.equal(next.workspaceId,f.b.id);
    assert.equal((await f.controller().status({runId:next.runId})).status,'completed');
    assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
    assert.equal(readBindings(f.home).projects[0].conversations[0].linkedAt,linkedAt);
    f.ctx.workspaceRegistry.archivedSessionIds.push(first.sessionId);
    const dedup=await f.controller().start(firstInput);assert.equal(dedup.deduplicated,true);assert.equal(f.calls.filter(c=>c[0]==='prompt').length,2);
    await assert.rejects(f.controller().send({requestId:'after-archive',sessionId:first.sessionId,prompt:'must not send'}),e=>e.code==='DSH_SESSION_ARCHIVED');
    assert.equal(f.calls.filter(c=>c[0]==='prompt').length,2);assert.equal(readBindings(f.home).projects[0].conversations.length,0);
    assert.ok(!fs.readFileSync(bindingsPath(f.home),'utf8').includes('next-day'));
  }finally{await f.close();}
});
test('archival after open is caught at prompt and never cancels or sends author work',async()=>{
  const f=await fixture();try{
    await f.native.open(f.input);f.ctx.workspaceRegistry.archivedSessionIds.push(f.input.sessionId);
    await assert.rejects(f.native.prompt({runId:f.input.runId,contentBlocks:[{type:'text',text:'do not send'}]}),e=>e.code==='DSH_SESSION_ARCHIVED');
    assert.equal(f.native.get(f.input.runId).status,'failed');assert.ok(!f.calls.some(c=>c[0]==='prompt'||c[0]==='cancel'));
    await f.native.release({runId:f.input.runId});
    await assert.rejects(f.native.open({...f.input,runId:'run-'+'b'.repeat(24),requestId:'resumed',resume:true}),e=>e.code==='DSH_SESSION_ARCHIVED');
    assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
  }finally{await f.close();}
});
test('read failures preserve notes and explicit deletion prunes the link without launching anything',async()=>{
  const f=await fixture();try{
    const agent=f.make('session-history',f.a);await f.a.attachSession(agent.session.id);
    await recordBinding(f.home,{sessionId:agent.session.id,cwd:f.a.path,workspaceId:f.a.id,workspaceTitle:f.a.title,title:'历史',backend:'desktop'});
    f.agents.delete(agent.session.id);
    const prior=f.ctx.sessionPersistence.stat;f.ctx.sessionPersistence.stat=async()=>{throw Error('temporary persistence failure');};
    const before=fs.readFileSync(bindingsPath(f.home),'utf8');await assert.rejects(f.controller().desktop_session({sessionId:agent.session.id}),/persistence failure/);
    assert.equal(fs.readFileSync(bindingsPath(f.home),'utf8'),before);
    f.ctx.sessionPersistence.stat=prior;f.stored.delete(agent.session.id);
    assert.equal((await f.controller().desktop_session({sessionId:agent.session.id})).exists,false);
    assert.equal(readBindings(f.home).projects[0].conversations.length,0);assert.equal(f.jobs.length,0);
  }finally{await f.close();}
});
test('removing workspace membership after open blocks the final send without deleting chat history',async()=>{
  const f=await fixture();try{
    await f.native.open(f.input);f.b.sessionIds=[];
    await assert.rejects(f.native.prompt({runId:f.input.runId,contentBlocks:[{type:'text',text:'wrong workspace'}]}),e=>e.code==='DSH_WORKSPACE_MISMATCH');
    assert.ok(f.stored.has(f.input.sessionId));assert.ok(!f.calls.some(c=>c[0]==='prompt'||c[0]==='cancel'));
  }finally{await f.close();}
});
test('controller rejects a selected workspace mismatch or unsupported backend before launch',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.controller().start({requestId:'bad-cwd',cwd:f.a.path,workspaceId:f.b.id,prompt:'bad'}),/differs/);
    await assert.rejects(f.controller().start({requestId:'bad-id',cwd:f.a.path,workspaceId:'missing',prompt:'bad'}),/no longer exists/);
    await assert.rejects(f.controller().start({requestId:'bad-backend',backend:'sdk',cwd:f.a.path,workspaceId:f.a.id,prompt:'bad'}),/desktop/);
    assert.equal(f.jobs.length,0);assert.ok(!f.calls.some(c=>c[0]==='create'));
  }finally{await f.close();}
});
test('legacy continuation cannot recreate a deleted workspace when its old receipt omitted workspaceId',async()=>{
  const f=await fixture();try{
    await f.native.open(f.input);await f.native.cancel({runId:f.input.runId});await f.native.release({runId:f.input.runId});
    f.workspaces.splice(f.workspaces.indexOf(f.b),1);
    const {workspaceId,...legacy}=f.input;
    await assert.rejects(f.native.open({...legacy,runId:'run-'+'b'.repeat(24),requestId:'legacy-next-day',resume:true}),e=>e.code==='DSH_WORKSPACE_NOT_FOUND');
    assert.equal(f.calls.filter(c=>c[0]==='workspace-create').length,0);assert.ok(f.stored.has(f.input.sessionId));
  }finally{await f.close();}
});
