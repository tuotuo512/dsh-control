import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(root, 'src', 'mcp.mjs');

function writeRun(home, runId) {
  const dir = path.join(home, 'runs', runId);
  fs.mkdirSync(dir, {recursive: true});
  const state = {
    schemaVersion: 1, runId, requestId: 'request-' + runId, signature: 'sig', sessionId: 'session-reconnect',
    cwd: home, permission: 'read-only', ownedPaths: [], prompt: 'fixture', title: 'reconnect fixture',
    provider: 'test', model: 'test', timeoutSeconds: 1800, status: 'completed', backend: 'sdk',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), eventCursor: 2,
    messages: [{cursor: 1, text: 'durable output'}], tools: [],
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(dir, 'report.md'), '# fixture report\n');
  return dir;
}

async function connect(home) {
  const child = spawn(process.execPath, [SERVER], {env: {...process.env, DSH_CONTROL_HOME: home}, stdio: ['pipe', 'pipe', 'pipe']});
  let buffer = '';
  const pending = new Map();
  let seq = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    buffer += data;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 10000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
  });
  const init = await rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'reconnect-test', version: '1'}});
  child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
  const call = async (name, args) => {
    const message = await rpc('tools/call', {name, arguments: args});
    const text = message.result?.content?.[0]?.text;
    if (message.result?.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return {child, init, call, close: () => new Promise(resolve => { child.once('close', resolve); child.kill(); })};
}

test('a new MCP client observes runs created before it started, and killing the client does not delete them', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reconnect-'));
  try {
    const runId = 'run-' + 'b'.repeat(24);
    writeRun(home, runId);

    const first = await connect(home);
    assert.equal(first.init.result.serverInfo.name, 'local-dsh-control');
    const initial = await first.call('dsh_list', {limit: 5});
    assert.ok(initial.runs.some(run => run.runId === runId), 'pre-existing run must be visible');
    await first.close();

    // Data must survive the client that created the connection.
    assert.ok(fs.existsSync(path.join(home, 'runs', runId, 'state.json')));
    assert.ok(fs.existsSync(path.join(home, 'runs', runId, 'report.md')));

    const second = await connect(home);
    const again = await second.call('dsh_list', {limit: 5});
    assert.ok(again.runs.some(run => run.runId === runId), 'new client must see the original run');
    const status = await second.call('dsh_status', {runId});
    assert.equal(status.status, 'completed');
    assert.equal(status.reportPath, path.join(home, 'runs', runId, 'report.md'));
    await second.close();
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('run data lives outside any plugin cache path the caller may clear', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cache-'));
  try {
    const runId = 'run-' + 'c'.repeat(24);
    writeRun(home, runId);
    const cache = path.join(home, 'simulated-plugin-cache');
    fs.mkdirSync(cache, {recursive: true});
    fs.writeFileSync(path.join(cache, 'plugin.json'), '{}');
    // Clearing the caller's plugin cache must not affect monitoring data.
    fs.rmSync(cache, {recursive: true, force: true});
    const client = await connect(home);
    const list = await client.call('dsh_list', {limit: 5});
    assert.ok(list.runs.some(run => run.runId === runId));
    await client.close();
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});
