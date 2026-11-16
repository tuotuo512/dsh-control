import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {AcpConnection} from '../src/acp-client.mjs';
import {runWorker} from '../src/worker.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures', 'fake-acp-server.mjs');

function sandbox(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-'));
  const log = path.join(dir, 'calls.jsonl');
  const child = spawn(process.execPath, [FAKE], {env: {...process.env, FAKE_ACP_LOG: log, ...extra}, stdio: ['pipe', 'pipe', 'pipe']});
  const connection = new AcpConnection(child, {
    sessionId: 'session-test',
    state: {cwd: dir, model: 'test-model', reasoningEffort: 'medium'},
    log: (name, detail) => fs.appendFileSync(log, JSON.stringify({type: name, detail}) + '\n'),
  });
  return {
    dir, log, child, connection,
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    close: async () => { await connection.stop('completed').catch(() => {}); if (!child.killed) child.kill(); fs.rmSync(dir, {recursive: true, force: true}); },
  };
}

const waitFor = async (fn, timeout = 8000) => {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

test('initialize negotiates ACP v1, creates a session and pins model and effort', async () => {
  const box = sandbox();
  try {
    const init = await box.connection.rpc('initialize', {cwd: box.dir});
    assert.equal(init.acpSessionId, 'acp-session-1');
    assert.equal(box.connection.acpSessionId, 'acp-session-1');
    const calls = box.calls();
    assert.ok(calls.some(call => call.method === 'initialize' && call.params.protocolVersion === 1));
    assert.ok(calls.some(call => call.method === 'session/new' && call.params.cwd === box.dir));
    const pinned = calls.filter(call => call.method === 'session/set_config_option').map(call => call.params);
    assert.ok(pinned.some(params => params.configId === 'model' && params.value === 'test-model'));
    assert.ok(pinned.some(params => params.configId === 'reasoning_effort' && params.value === 'medium'));
  } finally { await box.close(); }
});

test('a model missing from the catalog is reported, not silently claimed', async () => {
  const box = sandbox({FAKE_ACP_MODEL: 'other-model'});
  try {
    const init = await box.connection.rpc('initialize', {cwd: box.dir});
    assert.equal(init.acpSessionId, 'acp-session-1');
    const calls = box.calls();
    assert.ok(calls.some(call => call.type === 'model-unpinned'), 'must log the unmatched model');
    assert.ok(!calls.some(call => call.method === 'session/set_config_option' && call.params.configId === 'model'),
      'must not send a model value the agent does not offer');
  } finally { await box.close(); }
});

test('continuation resumes the ACP identity and never opens a replacement session', async () => {
  const box=sandbox();
  try {
    box.connection.state.resume=true;
    box.connection.acpSessionId='agent-existing-history';
    await box.connection.rpc('initialize',{cwd:box.dir});
    const calls=box.calls();
    assert.ok(calls.some(call=>call.method==='session/resume'&&call.params.sessionId==='agent-existing-history'));
    assert.ok(!calls.some(call=>call.method==='session/new'));
  } finally {await box.close();}
});

test('continuation with missing ACP identity refuses before any request', async () => {
  const box=sandbox();
  try {
    box.connection.state.resume=true;
    await assert.rejects(box.connection.rpc('initialize',{cwd:box.dir}),/session identity is missing/);
    assert.equal(box.calls().filter(call=>call.method).length,0);
  } finally {await box.close();}
});

test('grouped, provider-encoded model options are matched by model name', async () => {
  const box = sandbox({FAKE_ACP_GROUPED: '1'});
  try {
    await box.connection.rpc('initialize', {cwd: box.dir});
    const pinned = box.calls().filter(call => call.method === 'session/set_config_option').map(call => call.params);
    const model = pinned.find(params => params.configId === 'model');
    assert.ok(model, 'model must be pinned from the grouped catalog');
    assert.deepEqual(JSON.parse(model.value), ['test-provider', 'test-model']);
    assert.ok(pinned.some(params => params.configId === 'reasoning_effort' && params.value === 'medium'));
  } finally { await box.close(); }
});

test('prompt settles through supervisor-shaped receipt + wait', async () => {
  const box = sandbox();
  const events = [];
  box.connection.on('notification', message => events.push(message.params.event));
  try {
    await box.connection.rpc('initialize', {cwd: box.dir});
    const receipt = await box.connection.rpc('session/prompt', {contentBlocks: [{type: 'text', text: 'go'}]});
    assert.match(receipt.messageId, /^acp-/);
    const settled = await box.connection.rpc('session/wait', {sessionId: 'session-test'});
    assert.equal(settled.stopReason, 'end_turn');
    assert.deepEqual(events.map(event => event.type), ['assistant/message', 'tool/call', 'tool/result', 'assistant/message', 'turn/end']);
    assert.equal(events.at(-1).data.reason.kind, 'completed');
    assert.ok(box.calls().some(call => call.method === 'session/prompt' && call.params.prompt[0].text === 'go'));
  } finally { await box.close(); }
});

test('permission requests are surfaced as approvals and decisions map to ACP options', async () => {
  const box = sandbox({FAKE_ACP_PERMISSION: '1'});
  try {
    await box.connection.rpc('initialize', {cwd: box.dir});
    const request = new Promise(resolve => box.connection.once('request', resolve));
    await box.connection.rpc('session/prompt', {contentBlocks: [{type: 'text', text: 'go'}]});
    const approval = await request;
    assert.equal(approval.method, 'approval/request');
    assert.equal(approval.params.sessionId, 'session-test');
    assert.equal(approval.params.callId, 'call-1');
    await box.connection.answer(approval.id, {outcome: 'allowed-once'});
    await box.connection.rpc('session/wait');
    const answer = box.calls().find(call => call.type === 'permission-answer');
    assert.deepEqual(answer.answer, {outcome: {outcome: 'selected', optionId: 'allow-1'}});
  } finally { await box.close(); }
});

test('stop sends session/cancel and closes the session without hanging', async () => {
  const box = sandbox();
  try {
    await box.connection.rpc('initialize', {cwd: box.dir});
    await box.connection.rpc('session/prompt', {contentBlocks: [{type: 'text', text: 'long task'}]});
    const exit = await box.connection.stop('cancelled');
    assert.equal(exit.code, 0);
    const calls = box.calls();
    assert.ok(calls.some(call => call.method === 'session/cancel'));
    assert.ok(calls.some(call => call.method === 'session/close'));
  } finally { await box.close(); }
});

function runFixture(home, overrides = {}) {
  const runId = 'run-' + 'd'.repeat(24);
  const dir = path.join(home, 'runs', runId);
  fs.mkdirSync(dir, {recursive: true});
  const state = {
    schemaVersion: 1, backend: 'acp', runId, requestId: 'request-' + runId, signature: 'sig', sessionId: 'session-' + 'e'.repeat(8),
    resume: false, cwd: home, permission: 'read-only', ownedPaths: [], prompt: 'fixture task', title: 'acp fixture',
    provider: 'test', model: 'test-model', reasoningEffort: 'medium', timeoutSeconds: 30, runtimeConfig: {},
    status: 'starting', eventCursor: 0, messages: [], tools: [], createdAt: new Date().toISOString(),
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  return {runId, dir};
}

test('worker completes an ACP run, writes the report and keeps the shape of other backends', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-worker-'));
  const box = sandbox();
  try {
    const {runId, dir} = runFixture(home);
    const final = await runWorker(home, runId, {
      inspect: () => ({compatible: true, version: 'test', archiveSha256: 'x', protocolPackageVersion: 'test'}),
      acp: (cfg, state) => {
        box.connection.state = state;
        box.connection.sessionId = state.sessionId;
        return box.connection;
      },
    });
    assert.equal(final.status, 'completed');
    assert.equal(final.acpSessionId, 'acp-session-1');
    assert.ok(final.messages.map(message => message.text).join('|').includes('done'));
    assert.ok(final.tools.some(tool => tool.callId === 'call-1' && tool.status === 'returned'));
    assert.ok(fs.existsSync(path.join(dir, 'report.md')));
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(event => event.type === 'finished' && event.status === 'completed'));
    assert.ok(events.some(event => event.type === 'acp_session' && event.sessionId === 'acp-session-1'));
  } finally { await box.close(); fs.rmSync(home, {recursive: true, force: true}); }
});

test('worker pauses on an ACP permission, accepts the supervisor answer and completes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-perm-'));
  const box = sandbox({FAKE_ACP_PERMISSION: '1'});
  try {
    const {runId, dir} = runFixture(home);
    const running = runWorker(home, runId, {
      inspect: () => ({compatible: true, version: 'test', archiveSha256: 'x', protocolPackageVersion: 'test'}),
      acp: (cfg, state) => {
        box.connection.state = state;
        box.connection.sessionId = state.sessionId;
        return box.connection;
      },
    });
    const pending = await waitFor(() => {
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      return state.status === 'awaiting_approval' ? state.pending : null;
    });
    assert.equal(pending.kind, 'approval');
    fs.writeFileSync(path.join(dir, 'response.json'), JSON.stringify({pendingId: pending.pendingId, response: {outcome: 'allowed-once'}}));
    const final = await running;
    assert.equal(final.status, 'completed');
    assert.equal(final.pending, undefined);
    const answer = box.calls().find(call => call.type === 'permission-answer');
    assert.equal(answer.answer.outcome.optionId, 'allow-1');
  } finally { await box.close(); fs.rmSync(home, {recursive: true, force: true}); }
});
