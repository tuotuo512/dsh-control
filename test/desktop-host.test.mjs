import http from 'node:http';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter}from 'node:events';import {DesktopHostController,listenDesktop}from '../src/desktop-host.mjs';
function fixture(){const home=fs.mkdtempSync(path.join(os.tmpdir(),'native-host-')),bus=new EventEmitter(),agents=new Map(),calls=[],workspaces=[];let controller;
 const ctx={on:(n,f)=>{bus.on(n,f);return()=>bus.off(n,f);},agents,typertGateway:{getPendingRemoteEvents:()=>[]},waterfall:async()=>[],llm:{resolveCallConfig:async()=>{}},workspaceRegistry:{archivedSessionIds:[],list:()=>workspaces,create:async cwd=>{calls.push(['workspace',cwd]);let w={id:'workspace',path:cwd,title:'Fixture workspace',sessionIds:[],attachSession:async id=>w.sessionIds.push(id)};workspaces.push(w);return w;}},permissionPresets:{set:(s,p)=>calls.push(['permission',p])},sessionPersistence:{stat:async id=>agents.has(id)?{header:agents.get(id).session.header}:undefined},sessionProjections:{snapshot:()=>({values:{title:'Existing title'}})}};
 const make=id=>{const a={session:{id,header:{cwd:home},seq:1},status:'idle',inbox:{nextTurn:[],nextStep:[]},whenIdle:async()=>{},model:{select:r=>calls.push(['model',r]),current:()=>({provider:'p',model:'m'})}};agents.set(id,a);return a;};
 ctx.sessionController={create:async v=>{calls.push(['create',v]);make(v.sessionId);await workspaces.find(w=>w.id===v.workspaceId).attachSession(v.sessionId);return{sessionId:v.sessionId};},resolveAgent:async id=>({agent:agents.get(id)}),rename:async v=>calls.push(['rename',v]),prompt:async v=>calls.push(['prompt',v]),cancel:v=>calls.push(['cancel',v]),updateQueue:async v=>calls.push(['drop',v]),list:async()=>({items:[]})};
 controller=new DesktopHostController(ctx,{home,runtime:{pid:123,instanceId:'i',archiveSha256:'hash'},answerNative:async(id,value)=>{calls.push(['answer',id,value]);controller.remoteFrame({type:'cancel',eventId:id});}});
 const input={runId:'run-'+'a'.repeat(24),requestId:'request',sessionId:'session-fixture',cwd:home,title:'Fixture title',permission:'workspace-write',ownedPaths:[path.join(home,'file.txt')],provider:'p',model:'m',timeoutSeconds:60};
 return{home,ctx,controller,input,calls,agents,make,bus,close:async()=>{await controller.close();fs.rmSync(home,{recursive:true,force:true});}};}
const blocks=[{type:'text',text:'fixture'}];
test('native open creates workspace, title, permissions and deduplicates open/prompt',async()=>{const f=fixture();try{await f.controller.open(f.input);await f.controller.open(f.input);assert.equal(f.calls.filter(c=>c[0]==='create').length,1);assert.ok(f.calls.some(c=>c[0]==='permission'&&c[1]==='workspace-write'));assert.ok(f.calls.some(c=>c[0]==='rename'&&c[1].title==='Fixture title'));await assert.rejects(f.controller.open({...f.input,title:'different'}));await f.controller.prompt({runId:f.input.runId,contentBlocks:blocks});await f.controller.prompt({runId:f.input.runId,contentBlocks:blocks});assert.equal(f.calls.filter(c=>c[0]==='prompt').length,1);await assert.rejects(f.controller.prompt({runId:f.input.runId,contentBlocks:[{type:'text',text:'different'}]}));}finally{await f.close();}});
test('busy native adoption refuses; idle adoption sends no prompt',async()=>{const f=fixture();try{const a=f.make('existing');a.status='running';await assert.rejects(f.controller.adopt({requestId:'adopt',sessionId:'existing'}),/busy/);a.status='idle';const r=await f.controller.adopt({requestId:'adopt',sessionId:'existing'});assert.equal(r.sessionId,'existing');assert.ok(!f.calls.some(c=>c[0]==='prompt'));}finally{await f.close();}});
test('foreign events stay private; managed question and approval accept one reply across cancellation race',async()=>{const f=fixture();try{f.controller.remoteFrame({type:'waterfall',event:'user-questions/request',eventId:'foreign',agentId:'author',request:{questions:[]}});assert.equal(f.controller.pending.size,0);await f.controller.open(f.input);await f.controller.prompt({runId:f.input.runId,contentBlocks:blocks});for(const [id,event,request,response]of [['q','user-questions/request',{questions:[{id:'choice',options:[{label:'A'}]}]},{answers:[{id:'choice',selected:['A']}]}],['a','approval/request',{toolName:'pwsh',callId:'call',reason:'fixture'},{outcome:'rejected'}]]){f.controller.remoteFrame({type:'waterfall',event,eventId:id,agentId:f.input.sessionId,request});assert.equal(f.controller.pending.size,1);await f.controller.respond({runId:f.input.runId,pendingId:id,response});assert.equal(f.controller.pending.size,0);await f.controller.respond({runId:f.input.runId,pendingId:id,response});}assert.equal(f.calls.filter(c=>c[0]==='answer').length,2);assert.ok(!f.controller.poll({runId:f.input.runId}).events.some(e=>e.message.id==='foreign'));}finally{await f.close();}});
test('completion needs matching input, completed turn and idle; foreign input prevents cancellation',async()=>{const f=fixture();try{await f.controller.open(f.input);await f.controller.prompt({runId:f.input.runId,contentBlocks:blocks});const a=f.agents.get(f.input.sessionId);a.status='running';f.controller.onEvent(a.session,{seq:2,type:'user/message',data:{source:{kind:'user',rpcId:'request'}}});f.controller.onEvent(a.session,{seq:3,type:'turn/end',data:{reason:{kind:'completed'},turn:1}});await new Promise(r=>setImmediate(r));assert.notEqual(f.controller.get(f.input.runId).status,'completed');a.status='idle';await f.controller.checkFinish(f.controller.get(f.input.runId));assert.equal(f.controller.get(f.input.runId).status,'completed');}finally{await f.close();}
 const g=fixture();try{await g.controller.open(g.input);await g.controller.prompt({runId:g.input.runId,contentBlocks:blocks});g.controller.onEvent(g.agents.get(g.input.sessionId).session,{seq:2,type:'user/message',data:{source:{kind:'user',rpcId:'author'}}});await g.controller.cancel({runId:g.input.runId});assert.equal(g.controller.get(g.input.runId).status,'interrupted');assert.ok(!g.calls.some(c=>c[0]==='cancel'));}finally{await g.close();}});
test('HTTP rejects unauthenticated, foreign Origin and Host without token disclosure',async()=>{const f=fixture();let listener;try{listener=await listenDesktop(f.controller,{token:'fixture-private-token'});for(const headers of [{},{Authorization:'Bearer wrong'},{Authorization:'Bearer fixture-private-token',Origin:'https://foreign.example'},]){const r=await fetch(listener.url+'/v1/health',{headers});assert.ok([401,403].includes(r.status));assert.ok(!(await r.text()).includes('fixture-private-token'));}const badHost=await new Promise((resolve,reject)=>{const q=http.get(listener.url+'/v1/health',{headers:{Authorization:'Bearer fixture-private-token',Host:'foreign.example'}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});q.on('error',reject);});assert.equal(badHost,403);const r=await fetch(listener.url+'/v1/health',{headers:{Authorization:'Bearer fixture-private-token'}});assert.equal(r.status,200);assert.ok(!(await r.text()).includes('fixture-private-token'));}finally{await listener?.close();await f.close();}});
test('completed turn without admitted input cannot count as completion; busy open preserves author run',async()=>{
 const f=fixture();try{
  await f.controller.open(f.input);
  await f.controller.prompt({runId:f.input.runId,contentBlocks:blocks});
  const agent=f.agents.get(f.input.sessionId);
  f.controller.onEvent(agent.session,{seq:2,type:'turn/end',data:{reason:{kind:'completed'},turn:1}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.controller.get(f.input.runId).status,'failed');
 }finally{await f.close();}
 const g=fixture();try{
  const author=g.make(g.input.sessionId);author.status='running';
  await assert.rejects(g.controller.open(g.input),/busy/);
  assert.ok(!g.calls.some(call=>call[0]==='cancel'||call[0]==='prompt'));
 }finally{await g.close();}
});
test('successful native answer settles its own pending without receiving a cancel echo',async()=>{
 const f=fixture();try{
  await f.controller.open(f.input);
  await f.controller.prompt({runId:f.input.runId,contentBlocks:blocks});
  let answered=0;
  // Native event transport may notify competing peers only. No cancel frame
  // is delivered back to this answering peer in this fixture.
  f.controller.answerNative=async()=>{answered++;};
  f.controller.remoteFrame({type:'waterfall',event:'user-questions/request',eventId:'no-echo',agentId:f.input.sessionId,
   request:{questions:[{id:'choice',options:[{label:'A'}]}]}});
  assert.equal(f.controller.get(f.input.runId).status,'awaiting_input');
  await f.controller.respond({runId:f.input.runId,pendingId:'no-echo',response:{answers:[{id:'choice',selected:['A']}]}});
  assert.equal(answered,1);
  assert.equal(f.controller.pending.size,0);
  assert.deepEqual(f.controller.get(f.input.runId).pendingIds,[]);
  const agent=f.agents.get(f.input.sessionId);
  f.controller.onEvent(agent.session,{seq:2,type:'user/message',data:{source:{kind:'user',rpcId:f.input.requestId}}});
  f.controller.onEvent(agent.session,{seq:3,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.controller.get(f.input.runId).status,'completed');
 }finally{await f.close();}
});
test('terminal interrupted record cannot release a still busy native agent',async()=>{
 const f=fixture();try{
  await f.controller.open(f.input);
  const run=f.controller.get(f.input.runId),agent=f.agents.get(f.input.sessionId);
  run.status='interrupted';
  agent.status='running';
  await assert.rejects(f.controller.release({runId:f.input.runId}),/busy|running|active/i);
  assert.equal(run.releasedAt,undefined);
  agent.status='idle';
  const receipt=await f.controller.release({runId:f.input.runId});
  assert.equal(receipt.released,true);assert.equal(receipt.scope,'managed-run');
 }finally{await f.close();}
});
