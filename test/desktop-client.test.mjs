import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {DesktopClient,DesktopConnection}from '../src/desktop-client.mjs';
function fixture(){const h=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-client-'));fs.writeFileSync(path.join(h,'desktop-connection.json'),JSON.stringify({schemaVersion:1,protocolVersion:1,capabilities:['prompt','poll','respond','cancel','release'],url:'http://127.0.0.1:1234',token:'fixture-secret',instanceId:'i',archiveSha256:'hash'}));return h;}
test('connection validates loopback and redacts token on rejected responses',async()=>{const h=fixture();try{const c=new DesktopClient(h,{fetchImpl:async()=>({ok:false,text:async()=> 'busy fixture-secret'})});await assert.rejects(c.call('open',{}),e=>e.message.includes('busy')&&!e.message.includes('fixture-secret'));}finally{fs.rmSync(h,{recursive:true,force:true});}});
test('native completion releases only managed run and never invents process exit',async()=>{const h=fixture();try{const c=new DesktopConnection(h,{runId:'r',sessionId:'session-r',requestId:'request-r',runtimeConfig:{verifiedArchiveSha256:'hash'}});let routes=[];c.client={health:async()=>({archiveSha256:'hash'}),call:async(route)=>{routes.push(route);if(route==='open')return{hostPid:44,sessionId:'session-r'};if(route==='poll')return{status:'completed',completion:{requestId:'request-r',turnReason:{kind:'completed'},turnSeq:3,quiescent:true},events:[{cursor:1,message:{method:'session.event',params:{}}}],nextCursor:1};if(route==='release')return{released:true,scope:'managed-run',hostPid:44};return{accepted:true};}};let messages=0;c.on('notification',()=>messages++);await c.rpc('initialize',{});await c.rpc('session/prompt',{contentBlocks:[]});await c.rpc('session/wait',{});const r=await c.stop();assert.equal(messages,1);assert.equal(r.scope,'managed-run');assert.equal(r.code,undefined);assert.ok(!routes.includes('cancel'));}finally{fs.rmSync(h,{recursive:true,force:true});}});
test('terminal pages drain fully and incomplete attribution is refused',async()=>{
 const home=fixture();
 try {
  const connection=new DesktopConnection(home,{runId:'r',requestId:'owned'});
  const after=[];let seen=0;
  connection.client={call:async(route,body)=>{
   after.push(body.after);
   return body.after===0
    ? {status:'completed',hasMoreEvents:true,nextCursor:1,events:[{cursor:1,message:{method:'session.status',params:{}}}]}
    : {status:'completed',hasMoreEvents:false,nextCursor:2,events:[{cursor:2,message:{method:'session.status',params:{}}}]};
  }};
  connection.on('notification',()=>seen++);
  connection.startPolling();
  await assert.rejects(connection.rpc('session/wait',{}),/completion receipt/);
  assert.equal(seen,2);assert.deepEqual(after,[0,1]);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('HTTP busy refusal is distinct from transport and ambiguous server outcome',async()=>{
 const home=fixture();try{
  for(const [status,message,noEffects]of [[409,'Session is busy or has queued input; takeover refused',true],[409,'rename failed after create',false],[503,'unavailable',false]]){
   const client=new DesktopClient(home,{fetchImpl:async()=>({ok:false,status,text:async()=>message+' fixture-secret'})});
   await assert.rejects(client.call('adopt',{}),error=>error.status===status&&error.noEffects===noEffects&&error.outcomeUnknown===!noEffects&&!error.message.includes('fixture-secret'));
  }
  const client=new DesktopClient(home,{fetchImpl:async()=>{throw Error('fixture-secret');}});
  await assert.rejects(client.call('adopt',{}),error=>error.code==='DESKTOP_TRANSPORT_UNKNOWN'&&error.outcomeUnknown&&!error.message.includes('fixture-secret'));
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('explicit busy open never cancels someone else native run',async()=>{
 const home=fixture();try{
  const connection=new DesktopConnection(home,{runId:'r',sessionId:'s',runtimeConfig:{verifiedArchiveSha256:'hash'}});
  const client=new DesktopClient(home,{fetchImpl:async()=>({ok:false,status:409,text:async()=> 'Session already has an active supervised run'})});
  client.health=async()=>({archiveSha256:'hash'});connection.client=client;
  await assert.rejects(connection.rpc('initialize',{}),/active supervised/);
  connection.client.call=async()=>{throw Error('must not issue cancellation');};
  const stopped=await connection.stop();assert.equal(stopped.scope,'no-run-acquired');assert.equal(stopped.unconfirmed,undefined);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('adopt definite refusal releases local admission while unknown outcome retains lease',async()=>{
 const {createController}=await import('../src/controller.mjs');const home=fixture(),prior=globalThis.fetch;
 try{
  fs.writeFileSync(path.join(home,'config.json'),JSON.stringify({schemaVersion:1,executable:'fixture',archive:'fixture',cliEntry:'fixture',verifiedArchiveSha256:'hash',maxParallel:2,provider:'p',model:'m'}));
  let unknown=false;
  globalThis.fetch=async (url,options)=>{
   if(url.endsWith('/health'))return{ok:true,json:async()=>({protocolVersion:1,instanceId:'i',archiveSha256:'hash',capabilities:{operations:['prompt','poll','respond','cancel','release']}})};
   if(url.endsWith('/inspect-session'))return{ok:true,json:async()=>({sessionId:JSON.parse(options.body).sessionId,exists:true,archived:false,cwd:home})};
   if(unknown)throw Error('disconnected');
   return{ok:false,status:409,text:async()=> 'Session is busy or has queued input; takeover refused'};
  };
  const controller=createController({home});
  await assert.rejects(controller.adopt({requestId:'busy',sessionId:'session-busy'}));
  let record=(await controller.list({})).runs.find(r=>r.requestId==='busy');assert.equal(record.status,'failed');assert.equal(record.leaseHeld,false);assert.equal(record.httpStatus,409);
  unknown=true;await assert.rejects(controller.adopt({requestId:'unknown',sessionId:'session-unknown'}));
  record=(await controller.list({})).runs.find(r=>r.requestId==='unknown');assert.equal(record.status,'interrupted');assert.equal(record.leaseHeld,true);
 }finally{globalThis.fetch=prior;fs.rmSync(home,{recursive:true,force:true});}
});
