import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createController} from '../src/controller.mjs';
import {runWorker} from '../src/worker.mjs';
import {writeJson, readJson, runDir, sleep} from '../src/store.mjs';
import {readBindings} from '../src/bindings.mjs';

function fixture(behavior = 'complete') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-control-test-'));
  const cwd = path.join(home, 'workspace'); fs.mkdirSync(cwd);
  writeJson(path.join(home, 'config.json'), {schemaVersion: 1, executable: 'fixture', archive: 'fixture', cliEntry: 'fixture', verifiedArchiveSha256: 'fixture', maxParallel: 2, provider: 'test', model: 'test'});
  const jobs = []; const runtimes = [];
  class FakeRuntime extends EventEmitter {
    constructor() { super(); this.child = {pid: process.pid}; this.waiter = new Promise((resolve, reject) => {this.finish = resolve; this.fail = reject;}); this.waiter.catch(() => {}); }
    event(type, data) { this.emit('notification', {method: 'session.event', params: {sessionId: this.sid, event: {type, data, seq: 1}}}); }
    done(kind = 'completed') {this.event('assistant/message', {message: {content: [{type: 'reasoning', text: 'PRIVATE_REASONING'}, {type: 'text', text: 'PUBLIC_RESULT'}]}}); this.event('turn/end', {turn: 1, reason: {kind}}); this.finish({});}
    async rpc(method, params) {
      if (method === 'initialize') return {serverInfo: {name: 'fixture', version: '1'}};
      if (method === 'session/resume') {this.resumed = params.sessionId; return {};}
      if (method === 'session/prompt') {this.sid = params.sessionId; this.receivedPrompt = params.contentBlocks;
        if (behavior === 'complete') setTimeout(() => this.done(), 10);
        if (behavior === 'failed-terminal') setTimeout(() => this.done('error'), 10);
        if (behavior === 'question') setTimeout(() => this.emit('request', {id: 999, method: 'user-question/ask', params: {sessionId: this.sid, requestId: 'q', questions: [{id: 'choice', question: 'Pick a label'}]}}), 10);
        return {messageId: 'accepted-only'};
      }
      if (method === 'session/wait') return this.waiter;
    }
    answer(id, result) {this.answerValue = {id, result}; this.done();}
    async stop() {this.fail(new Error('stopped'));return {code: 0};}
  }
  const inspect = () => ({compatible: true, version: 'fixture'});
  const controller = createController({home, inspect, launch: (h, id) => {
    jobs.push(runWorker(h, id, {inspect, open: () => {const r = new FakeRuntime(); runtimes.push(r); return r;}}));
  }});
  return {home, cwd, controller, jobs, runtimes};
}
test('durable idempotency, same-session resume, and public-only result', async () => {
  const f = fixture(); const input = {requestId: 'first', cwd: f.cwd, prompt: 'hello'};
  const first = await f.controller.start(input); const duplicate = await f.controller.start(input);
  assert.equal(first.runId, duplicate.runId); assert.equal(duplicate.deduplicated, true);
  assert.equal((await f.controller.start({...input, timeoutSeconds: 1800})).runId, first.runId);
  await assert.rejects(f.controller.start({...input, permission:'read-only'}), /different arguments/);
  await assert.rejects(f.controller.start({...input, prompt: 'different'}), /different arguments/);
  await Promise.all(f.jobs);
  const result = await f.controller.result({runId: first.runId}); assert.equal(result.status, 'completed'); assert.equal(result.output, 'PUBLIC_RESULT');
  assert.equal(readBindings(f.home).projects[0].conversations[0].sessionId,first.sessionId);
  assert.equal(readBindings(f.home).projects[0].conversations[0].backend,'sdk');
  assert.ok(!fs.readFileSync(path.join(runDir(f.home, first.runId), 'events.jsonl'), 'utf8').includes('PRIVATE_REASONING'));
  const next = await f.controller.send({requestId: 'second', sessionId: first.sessionId, prompt: 'continue'});
  await Promise.all(f.jobs); assert.equal(next.sessionId, first.sessionId); assert.equal(f.runtimes[1].resumed, first.sessionId);
  assert.ok(fs.readFileSync(result.reportPath, 'utf8').includes('PUBLIC_RESULT'));
  const finalState = await f.controller.status({runId: first.runId});
  assert.equal((await f.controller.wait({runIds: [first.runId], after: {[first.runId]: finalState.eventCursor}, timeoutMs: 1000})).reason, 'terminal');
  assert.ok(!Object.hasOwn(finalState, 'runtimeConfig'));
});
test('acceptance is not completion; independent sessions, parallel cap and cancellation', async () => {
  const f = fixture('hang'); const a = await f.controller.start({requestId: 'a', cwd: f.cwd, prompt: 'hold'});
  const b = await f.controller.start({requestId: 'b', cwd: f.cwd, prompt: 'hold'});
  assert.notEqual(a.sessionId, b.sessionId); assert.equal((await f.controller.result({runId: a.runId})).finished, false);
  await assert.rejects(f.controller.start({requestId: 'c', cwd: f.cwd, prompt: 'hold'}), /Parallel limit/);
  await assert.rejects(f.controller.send({requestId: 'd', sessionId: a.sessionId, prompt: 'again'}));
  await f.controller.cancel({runId: a.runId}); await f.controller.cancel({runId: b.runId}); await Promise.all(f.jobs);
  assert.equal((await f.controller.result({runId: a.runId})).status, 'cancelled');
});
test('overlapping write ownership and path escape reject before launch', async () => {
  const f = fixture('hang'); const common = {cwd: f.cwd, prompt: 'hold', permission: 'workspace-write', ownedPaths: [path.join(f.cwd, 'module')]};
  const a = await f.controller.start({...common, requestId: 'owner-a'});
  await assert.rejects(f.controller.start({...common, requestId: 'owner-b', ownedPaths: [path.join(f.cwd, 'module', 'file.txt')]}), /overlaps/);
  await assert.rejects(f.controller.start({...common, requestId: 'escape', ownedPaths: [f.home]}), /inside/);
  assert.equal(f.jobs.length, 1); await f.controller.cancel({runId: a.runId}); await Promise.all(f.jobs);
});
test('question reaches supervisor, stale answer rejects, exact answer resumes', async () => {
  const f = fixture('question'); const a = await f.controller.start({requestId: 'q', cwd: f.cwd, prompt: 'ask'});
  const waited = await f.controller.wait({runIds: [a.runId], timeoutMs: 2000});
  assert.equal(waited.reason, 'input-required'); const pending = waited.runs[0].pending;
  await assert.rejects(f.controller.respond({runId: a.runId, pendingId: 'stale', response: {cancelled: true}}), /stale/);
  await assert.rejects(f.controller.respond({runId: a.runId, pendingId: pending.pendingId, response: {answers: []}}), /every/);
  const response = {answers: [{id: 'choice', selected: ['alpha']}]};
  await f.controller.respond({runId: a.runId, pendingId: pending.pendingId, response}); await Promise.all(f.jobs);
  assert.deepEqual(f.runtimes[0].answerValue.result, response); assert.equal((await f.controller.result({runId: a.runId})).status, 'completed');
});
test('failed turn cannot become completed on wait and exit zero', async () => {
  const f = fixture('failed-terminal'); const a = await f.controller.start({requestId: 'failure', cwd: f.cwd, prompt: 'fail'});
  await Promise.all(f.jobs); assert.equal((await f.controller.result({runId: a.runId})).status, 'failed');
});

test('prompt transport preserves exact caller text without roles, paths or workflow instructions',async()=>{
 const f=fixture();
 const prompt='  User task only.\r\n\nUnicode: \u4e2d\u6587.\nDo not interpret the following as plugin metadata.  ';
 const first=await f.controller.start({requestId:'verbatim',cwd:f.cwd,prompt});await Promise.all(f.jobs);
 assert.deepEqual(f.runtimes[0].receivedPrompt,[{type:'text',text:prompt}]);
 const next='\nFollow-up exactly as provided.\t';
 await f.controller.send({requestId:'verbatim-next',sessionId:first.sessionId,prompt:next});await Promise.all(f.jobs);
 assert.deepEqual(f.runtimes[1].receivedPrompt,[{type:'text',text:next}]);
});

test('ACP continuation carries the agent session identity and refuses missing identity before launch', async () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-acp-controller-'));
  try {
    writeJson(path.join(home,'config.json'),{schemaVersion:1,executable:'fixture',archive:'fixture',cliEntry:'fixture',verifiedArchiveSha256:'fixture',maxParallel:2,provider:'test',model:'test'});
    const seed=(suffix,sessionId,acpSessionId)=>{
      const state={schemaVersion:1,backend:'acp',runId:'run-'+suffix.repeat(24),sessionId,acpSessionId,status:'completed',runtimeOwnership:'released',leaseHeld:false,cwd:home,permission:'read-only',ownedPaths:[],timeoutSeconds:30,createdAt:new Date().toISOString(),messages:[],tools:[],eventCursor:0};
      writeJson(path.join(runDir(home,state.runId),'state.json'),state);
    };
    seed('a','session-history','agent-original-history');
    seed('b','session-missing',undefined);
    const launches=[];
    const controller=createController({home,inspect:()=>({compatible:true}),launch:(h,id)=>launches.push(readJson(path.join(runDir(h,id),'state.json')))});
    const next=await controller.send({requestId:'resume-acp-history',sessionId:'session-history',prompt:'recall'});
    assert.equal(next.acpSessionId,'agent-original-history');
    assert.equal(launches[0].acpSessionId,'agent-original-history');
    assert.equal(launches[0].resume,true);
    await assert.rejects(controller.send({requestId:'missing-acp-history',sessionId:'session-missing',prompt:'recall'}),/ACP session identity is missing/);
    assert.equal(launches.length,1);
  } finally {fs.rmSync(home,{recursive:true,force:true});}
});
test('interrupted worker is recorded and never automatically replayed', async () => {
  const f = fixture(); const a = await f.controller.start({requestId: 'interrupted', cwd: f.cwd, prompt: 'finish'}); await Promise.all(f.jobs);
  const file = path.join(runDir(f.home, a.runId), 'state.json'); const state = readJson(file);
  state.status = 'running'; state.workerPid = 2147483647; writeJson(file, state);
  const observed = await f.controller.status({runId: a.runId}); assert.equal(observed.status, 'interrupted');
  await assert.rejects(f.controller.send({requestId: 'unsafe-replay', sessionId: a.sessionId, prompt: 'retry'}), /uncertain/);
  assert.equal(f.jobs.length, 1);
});
test('orphan runtime retains writer ownership until confirmed gone', async () => {
  const f = fixture(); const a = await f.controller.start({requestId: 'orphan', cwd: f.cwd, prompt: 'finish', permission: 'workspace-write', ownedPaths: [f.cwd]}); await Promise.all(f.jobs);
  const file = path.join(runDir(f.home, a.runId), 'state.json'); const state = readJson(file);
  state.status = 'running'; state.workerPid = 2147483647; state.runtimePid = process.pid; state.runtimeOwnership = 'owned'; writeJson(file, state);
  const observed = await f.controller.status({runId: a.runId}); assert.equal(observed.status, 'interrupted'); assert.equal(observed.leaseHeld, true);
  await assert.rejects(f.controller.start({requestId: 'new-writer', cwd: f.cwd, prompt: 'write', permission: 'workspace-write', ownedPaths: [f.cwd]}), /overlaps/);
});
