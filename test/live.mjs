// Explicit live verification, not included in npm test. Uses the installed DSH and real model.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const fixture = path.join(repo, '.test-state', stamp); fs.mkdirSync(fixture, {recursive: true});
for (const name of ['reader', 'question']) {fs.mkdirSync(path.join(fixture, name)); fs.writeFileSync(path.join(fixture, name, 'AGENTS.md'), '# Verification workspace\nOnly perform the exact supervisor-assigned test. No delegation or other files.\n');}
fs.writeFileSync(path.join(fixture, 'reader', 'sample.txt'), 'DSH_READER_MARKER_7319\n');
let client;
async function connect() {
  client = new Client({name: 'dsh-control-live-verification', version: '0.1.0'});
  await client.connect(new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'src', 'mcp.mjs')]}));
}
async function call(operation, args = {}) {
  const response = await client.callTool({name: 'dsh_' + operation, arguments: args});
  if (response.isError) throw new Error(response.content?.[0]?.text || 'MCP tool failed');
  return response.structuredContent;
}
const observed = {fixture, timestamp: new Date().toISOString(), tests: []};
const active = new Set();
try {
  await connect(); observed.doctor = await call('doctor'); assert.equal(observed.doctor.ready, true);
  const aInput = {backend:'sdk', requestId: stamp + '-reader', cwd: path.join(fixture, 'reader'), title: 'DSH infrastructure reader test', timeoutSeconds: 120,
    prompt: 'This is a read-only connectivity test. Use the read tool to read sample.txt in this workspace. Remember its marker for the next turn. Reply with exactly the file marker. Do not modify any files, use a shell, or delegate.'};
  const a = await call('start', aInput); active.add(a.runId);
  const b = await call('start', {backend:'sdk', requestId: stamp + '-question', cwd: path.join(fixture, 'question'), title: 'DSH infrastructure question test', timeoutSeconds: 120,
    prompt: 'This is an actual supervisor-question roundtrip test. You must call ask_user_question once, asking the supervisor to choose ALPHA_7319 or BETA_7319. Wait for the answer. Then reply with exactly the selected label. Do not choose yourself. Do not read or write any files, run shell commands, or delegate.'}); active.add(b.runId);
  assert.notEqual(a.sessionId, b.sessionId); assert.equal((await call('start', aInput)).runId, a.runId);
  observed.start = {reader: a, question: b}; console.log(JSON.stringify({phase: 'two-sessions-started', runIds: [...active]}));
  // Disconnect while jobs run, then reconnect: job lifetime must not belong to this MCP transport.
  await client.close(); await connect(); observed.tests.push('MCP disconnect/reconnect with durable runs');
  const deadline = Date.now() + 120000;
  while (active.size && Date.now() < deadline) {
    const values = await call('wait', {runIds: [...active], timeoutMs: 10000});
    for (const run of values.runs) {
      if (run.pending) {
        assert.equal(run.runId, b.runId); assert.equal(run.pending.kind, 'question');
        const answers = run.pending.params.questions.map(q => {
          const label = q.options?.find(o => o.label.includes('ALPHA_7319'))?.label;
          assert.ok(label, 'DSH must offer requested test label'); return {id: q.id, selected: [label]};
        });
        observed.question = run.pending;
        await call('respond', {runId: run.runId, pendingId: run.pending.pendingId, response: {answers}});
        console.log(JSON.stringify({phase: 'question-answered', runId: run.runId}));
        // Wait for the queued answer to be consumed before asking the same snapshot again.
        await new Promise(r => setTimeout(r, 400));
      }
      if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(run.status)) {
        const result = await call('result', {runId: run.runId}); observed[run.runId] = result;
        assert.equal(result.status, 'completed', result.error); active.delete(run.runId);
        console.log(JSON.stringify({phase: 'completed', runId: run.runId, output: result.output, tools: result.tools}));
      }
    }
  }
  assert.equal(active.size, 0, 'live runs timed out');
  assert.match(observed[a.runId].output, /DSH_READER_MARKER_7319/);
  assert.ok(observed[a.runId].tools.some(t => t.name === 'read'));
  assert.match(observed[b.runId].output, /ALPHA_7319/); assert.ok(observed.question);
  const resumed = await call('send', {requestId: stamp + '-resume', sessionId: a.sessionId, prompt: 'Without calling any tools or reading files, reply with the exact marker you read in the previous turn.'}); active.add(resumed.runId);
  while (active.size && Date.now() < deadline) {
    const waited = await call('wait', {runIds: [resumed.runId], timeoutMs: 10000});
    if (waited.reason === 'terminal') {const result = await call('result', {runId: resumed.runId}); observed.resume = result; assert.equal(result.status, 'completed', result.error); assert.match(result.output, /DSH_READER_MARKER_7319/); active.delete(resumed.runId);}
  }
  assert.equal(active.size, 0); assert.equal(fs.readFileSync(path.join(fixture, 'reader', 'sample.txt'), 'utf8'), 'DSH_READER_MARKER_7319\n');
  observed.tests.push('Two distinct real SDK sessions', 'Idempotent start', 'Actual read tool result', 'DSH question → supervisor answer → DSH result', 'Resume after runtime exit', 'Read-only fixture retained');
  observed.passed = true;
} finally {
  for (const runId of active) {try {await call('cancel', {runId});} catch {}}
  if (client) await client.close();
  fs.writeFileSync(path.join(fixture, 'verification.json'), JSON.stringify(observed, null, 2));
  console.log(JSON.stringify({verification: path.join(fixture, 'verification.json'), passed: observed.passed === true}));
}
