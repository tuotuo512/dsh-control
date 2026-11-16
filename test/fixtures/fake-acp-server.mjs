#!/usr/bin/env node
/**
 * Minimal ACP v1 agent used by the tests. It implements just enough of the real
 * surface to exercise the adapter: initialize, session/new, resume, config
 * options, prompt with permission, updates, cancel and close.
 *
 * Environment:
 *   FAKE_ACP_LOG        JSONL path for received calls (test assertions)
 *   FAKE_ACP_PERMISSION '1' -> ask for permission before finishing the prompt
 *   FAKE_ACP_MODEL      value advertised in the model option (default test-model)
 */
import fs from 'node:fs';

const log = message => {
  if (process.env.FAKE_ACP_LOG) fs.appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(message) + '\n');
};
const send = value => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...value}) + '\n');
const sessionId = 'acp-session-1';
const model = process.env.FAKE_ACP_MODEL || 'test-model';
let settling = null;      // resolver for the in-flight prompt
let cancelled = false;
let permission = null;    // resolver waiting for the client's permission answer
let seq = 0;

const grouped = process.env.FAKE_ACP_GROUPED === '1';
const modelValue = grouped ? JSON.stringify(['test-provider', model]) : model;
const configOptions = [
  grouped
    ? {id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: modelValue,
       options: [{group: 'test-provider', name: 'Test', options: [{value: modelValue, name: model}]}]}
    : {id: 'model', name: 'Model', type: 'select', currentValue: model, options: [{value: model}, {value: 'other-model'}]},
  {id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{value: 'low'}, {value: 'medium'}, {value: 'high'}]},
];

function update(payload) {
  send({method: 'session/update', params: {sessionId, update: payload}});
}

async function runPrompt(id) {
  update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'working'}});
  update({sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'write file', status: 'in_progress'});
  if (process.env.FAKE_ACP_PERMISSION === '1' && !cancelled) {
    const requestId = ++seq;
    const answer = await new Promise(resolve => {
      permission = resolve;
      send({
        id: requestId,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {toolCallId: 'call-1', title: 'write file'},
          options: [
            {optionId: 'allow-1', name: 'Allow once', kind: 'allow_once'},
            {optionId: 'reject-1', name: 'Reject', kind: 'reject_once'},
          ],
        },
      });
    });
    log({type: 'permission-answer', answer});
  }
  update({sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: []});
  update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: ' done'}});
  send({id, result: {stopReason: cancelled ? 'cancelled' : 'end_turn'}});
  settling = null;
}

function handle(message) {
  log({type: 'call', method: message.method || null, id: message.id ?? null, params: message.params ?? null});
  if (message.method === 'initialize') {
    return send({id: message.id, result: {protocolVersion: 1, agentInfo: {name: 'fake-acp', version: '1.0.0'}, agentCapabilities: {sessionCapabilities: {resume: true}}, authMethods: []}});
  }
  if (message.method === 'session/new') {
    return send({id: message.id, result: {sessionId, configOptions}});
  }
  if (message.method === 'session/resume') {
    return send({id: message.id, result: {}});
  }
  if (message.method === 'session/set_config_option') {
    return send({id: message.id, result: {configOptions}});
  }
  if (message.method === 'session/prompt') {
    cancelled = false;
    settling = message.id;
    void runPrompt(message.id);
    return;
  }
  if (message.method === 'session/cancel') {
    cancelled = true;
    if (settling !== null) {
      const id = settling; settling = null;
      send({id, result: {stopReason: 'cancelled'}});
    }
    if (permission) { const resolve = permission; permission = null; resolve({outcome: {outcome: 'cancelled'}}); }
    return;
  }
  if (message.method === 'session/close') {
    return send({id: message.id, result: {}});
  }
  if (message.id !== undefined && message.result !== undefined && permission) {
    const resolve = permission; permission = null;
    resolve(message.result);
    return;
  }
  if (message.id !== undefined) {
    return send({id: message.id, error: {code: -32601, message: 'unsupported in fake agent'}});
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
