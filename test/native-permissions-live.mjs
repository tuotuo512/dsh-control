// Explicit real Desktop acceptance. Not part of npm test; never run without authorization.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.env.DSH_LIVE_VERIFY !== '1') throw new Error('Set DSH_LIVE_VERIFY=1 only after authorizing a real, bounded Desktop test.');
const home=process.env.DSH_CONTROL_HOME || path.join(os.homedir(),'.codex','dsh-control-state');
const receiptName=fs.readdirSync(path.join(home,'install')).filter(n=>/^receipt-.*\.json$/.test(n)).sort().at(-1);
assert.ok(receiptName,'Install the candidate first');
const installation=JSON.parse(fs.readFileSync(path.join(home,'install',receiptName),'utf8'));
const server=path.join(installation.serverDir,'mcp.mjs');
const stamp='native-fastpath-'+Date.now();
const fixture=path.join(home,'verification',stamp),cwd=path.join(fixture,'workspace');
fs.mkdirSync(cwd,{recursive:true});
const marker='DSH_NATIVE_FULL_'+crypto.randomBytes(12).toString('hex');
fs.writeFileSync(path.join(cwd,'TASK.md'),[
  '# Disposable native permission acceptance',
  'Only read this file and write receipt.txt in this directory. Do not touch real projects, accounts, permissions, plugins or other files. Do not delegate.',
  '1. Use the read tool to read this file.',
  '2. Use pwsh to write the exact marker below into receipt.txt as UTF-8 without a newline. Then use pwsh to print its content, current directory and SHA256. Actually run the shell; do not use write/edit tools instead.',
  '3. Call ask_user_question once with two option labels exactly VERIFY_OK and VERIFY_REJECT. Wait for the answer. This is a business question, not permission approval.',
  '4. Finish with a short report containing the command result, selected label and marker. On failure report it; do not repair ACLs, escalate, retry unknown operations or substitute file-writing tools.',
  `Marker: ${marker}`,
].join('\n')+'\n');
let client, activeRun;
const evidence={at:new Date().toISOString(),fixture,installation:{packageVersion:installation.packageVersion,nativeRevision:installation.nativeRevision,serverDigest:installation.serverDigest},tests:[],approvalRequests:0};
async function connect(){client=new Client({name:'native-permission-acceptance',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[server],env:{...process.env,DSH_CONTROL_HOME:home}}));}
async function call(name,input={}){const r=await client.callTool({name:'dsh_'+name,arguments:input});if(r.isError)throw Error(r.content?.[0]?.text||'MCP error');return r.structuredContent;}
async function settle(run){
  activeRun=run.runId;let cursor=0;const answered=new Set(),deadline=Date.now()+240000;
  while(Date.now()<deadline){
    const response=await call('wait',{runIds:[run.runId],after:{[run.runId]:cursor},timeoutMs:10000,compact:true});
    const state=response.runs[0];cursor=state.eventCursor;
    if(state.pending && !answered.has(state.pending.pendingId)){
      if(state.pending.kind==='approval'){evidence.approvalRequests++;throw Error('Full-access execution unexpectedly asked for approval');}
      const answers=state.pending.params.questions.map(q=>{assert.ok(q.options?.some(o=>o.label==='VERIFY_OK'));return {id:q.id,selected:['VERIFY_OK']};});
      await call('respond',{runId:run.runId,pendingId:state.pending.pendingId,response:{answers}});answered.add(state.pending.pendingId);evidence.questionRoundtrip=true;
    }
    if(['completed','failed','interrupted','timed_out','cancelled'].includes(state.status)){
      activeRun=undefined;const result=await call('result',{runId:run.runId,maxChars:10000});assert.equal(result.status,'completed',result.error);assert.equal(result.runtimeOwnership,'released');return result;
    }
    if(state.pending)await new Promise(r=>setTimeout(r,250));
  }
  throw Error('Acceptance deadline elapsed; inspect the managed run instead of replaying it');
}
try{
  await connect();
  const tools=(await client.listTools()).tools;
  assert.ok(tools.some(t=>t.name==='dsh_preflight')&&tools.some(t=>t.name==='dsh_workspace_policy'));evidence.toolCount=tools.length;
  evidence.doctor=await call('doctor');assert.equal(evidence.doctor.ready,true);
  assert.equal(evidence.doctor.desktop.pluginVersion,installation.packageVersion);
  assert.equal(evidence.doctor.desktop.sourceDigest,installation.nativeRevision);
  assert.ok(evidence.doctor.desktop.permissionPresets.includes('danger-full-access'));
  let policy=await call('workspace_policy',{cwd});
  await call('workspace_policy',{cwd,permission:'danger-full-access',expectedRevision:policy.revision});
  const workspacesBefore=await call('desktop_workspaces');
  const preflight=await call('preflight',{cwd,backend:'desktop',ownedPaths:[path.join(cwd,'receipt.txt')]});
  const workspacesAfter=await call('desktop_workspaces');
  assert.deepEqual(workspacesAfter,workspacesBefore,'Preflight must not create workspace/session records');
  assert.equal(preflight.ready,true,JSON.stringify(preflight.blockers));assert.equal(preflight.permission,'danger-full-access');assert.equal(preflight.permissionSource,'project');assert.equal(preflight.shell,'not_probed');evidence.preflight=preflight;
  const input={requestId:stamp+'-start',backend:'desktop',cwd,title:'DSH new conversation acceptance '+installation.packageVersion,ownedPaths:[path.join(cwd,'receipt.txt')],timeoutSeconds:360,prompt:'This is a bounded plugin acceptance test. Read TASK.md in this disposable workspace and perform its four steps. Use real pwsh for the write/readback, ask the supervisor the required question, then report briefly. Do not modify anything else.'};
  const first=await call('start',input);activeRun=first.runId;
  assert.equal(first.permission,'danger-full-access');assert.equal(first.permissionSource,'project');
  assert.equal((await call('start',input)).deduplicated,true);
  evidence.first={runId:first.runId,sessionId:first.sessionId,cwd};
  console.log(JSON.stringify({phase:'new-native-conversation',...evidence.first,permission:first.permission,fixture}));
  await client.close();await connect();
  const result=await settle(first);evidence.firstResult=result;
  assert.equal(fs.readFileSync(path.join(cwd,'receipt.txt'),'utf8'),marker);
  assert.ok(result.tools.some(t=>t.name==='pwsh'));assert.ok(!result.tools.some(t=>['write','edit'].includes(t.name)));
  assert.ok(result.output.includes(marker));assert.ok(evidence.questionRoundtrip);assert.equal(evidence.approvalRequests,0);
  const info=await call('desktop_session',{sessionId:first.sessionId});assert.equal(info.exists,true);assert.equal(info.archived,false);assert.equal(info.cwd,cwd);evidence.nativeSession=info;
  const full=await call('list',{limit:1}),compact=await call('list',{limit:1,compact:true});evidence.monitorBytes={full:Buffer.byteLength(JSON.stringify(full)),compact:Buffer.byteLength(JSON.stringify(compact))};
  policy=await call('workspace_policy',{cwd});await call('workspace_policy',{cwd,permission:null,expectedRevision:policy.revision});
  const next=await call('send',{requestId:stamp+'-resume',sessionId:first.sessionId,prompt:'Without tools, repeat exactly the marker and the supervisor option you used in the previous turn. Do not run commands or change files.'});
  assert.equal(next.sessionId,first.sessionId);assert.equal(next.permission,'danger-full-access');
  evidence.resumeResult=await settle(next);assert.ok(evidence.resumeResult.output.includes(marker));assert.ok(evidence.resumeResult.output.includes('VERIFY_OK'));assert.equal(evidence.resumeResult.tools.length,0);
  assert.equal(fs.readFileSync(path.join(cwd,'receipt.txt'),'utf8'),marker);
  const notes=JSON.parse(fs.readFileSync(path.join(home,'conversation-bindings.json'),'utf8'));
  assert.ok(notes.projects.some(p=>p.cwd===cwd && p.conversations.some(c=>c.sessionId===first.sessionId)));
  evidence.tests=['fresh installed MCP discovery','native version and digest match','project full-access default','zero-chat/model preflight','new Desktop conversation','idempotent start','MCP reconnect','real pwsh write and independent readback','business question roundtrip without approval','compact receipts','same-session continuation after project-policy reset','relationship note persisted'];
  evidence.passed=true;console.log(JSON.stringify({phase:'accepted',sessionId:first.sessionId,tests:evidence.tests,monitorBytes:evidence.monitorBytes}));
}catch(error){evidence.error=String(error.stack||error);throw error;}
finally{
  if(activeRun){try{await call('cancel',{runId:activeRun});}catch(error){evidence.cleanupError=String(error.message);}}
  if(client)await client.close();
  fs.writeFileSync(path.join(fixture,'verification.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({verification:path.join(fixture,'verification.json'),passed:evidence.passed===true}));
}
