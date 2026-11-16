/**
 * ACP (Agent Client Protocol) backend for the supervisor's worker.
 *
 * The worker is written against the DSH SDK message shape (`initialize`,
 * `session/prompt` receipt + `session/wait`, SDK-shaped notifications). This
 * adapter speaks standard ACP v1 over stdio and translates in both directions, so
 * adding the backend does not change the controller, tools, reports or the state
 * machine.
 *
 * Differences that are inherent to ACP, not translation bugs:
 * - ACP has no interactive question operation; agents only send one-shot
 *   `session/request_permission`. Runs that need `ask_user_question` cannot work
 *   on this backend and the worker prompt says so.
 * - ACP assigns the session id. The supervisor keeps its own id for history and
 *   reports and remembers the ACP id for resume.
 */
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';

const PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT = 30000;

const isText = block => block && block.type === 'text' && typeof block.text === 'string';

export class AcpConnection extends EventEmitter {
  constructor(child, {sessionId, state, log = () => {}} = {}) {
    super();
    this.child = child;
    this.sessionId = sessionId;          // supervisor-side identity
    this.state = state;                  // run snapshot (cwd, provider, model, ...)
    this.acpSessionId = state?.acpSessionId || null;
    this.seq = 0;
    this.pending = new Map();
    this.requests = new Map();           // server request id -> {toolCallId, options}
    this.buffer = '';
    this.stderr = '';
    this.exited = false;
    this.message = '';
    this.messageSeq = 0;
    this.settlement = null;
    this.settled = null;
    this.stopReason = null;
    this.closed = false;
    this.log = log;
    this.exit = new Promise(resolve => {
      child.once('error', error => { this.failure = error; this.rejectAll(error); resolve({code: null, error}); });
      child.once('close', (code, signal) => {
        this.exited = true; this.exitCode = code;
        this.rejectAll(new Error(`ACP runtime closed (${code}, ${signal})`));
        if (this.stopReason === null) this.finalize('runtime-exited', {code, signal});
        resolve({code, signal});
      });
    });
    child.stdin.on('error', error => { this.failure = error; this.rejectAll(error); });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-8192); });
    child.stdout.on('data', data => {
      this.buffer += data;
      if (this.buffer.length > 32 * 1024 * 1024) { this.failure = new Error('ACP frame exceeds 32 MiB'); this.rejectAll(this.failure); child.kill(); return; }
      let index;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { this.failure = new Error('Non-JSON ACP stdout; incompatible runtime'); this.rejectAll(this.failure); child.kill(); return; }
        this.dispatch(message);
      }
    });
  }

  rejectAll(error) { for (const waiter of this.pending.values()) waiter.reject(error); this.pending.clear(); }

  dispatch(message) {
    if (message.id !== undefined && message.method) return this.onServerRequest(message);
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id); if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
      return;
    }
    if (message.method === 'session/update') return this.onUpdate(message.params || {});
    if (typeof message.method === 'string') this.emit('notification', {method: message.method, params: message.params});
  }

  onServerRequest(message) {
    if (message.method === 'session/request_permission') {
      const params = message.params || {};
      const toolCall = params.toolCall || {};
      this.requests.set(message.id, {toolCallId: toolCall.toolCallId, options: params.options || []});
      this.log('permission', {toolCallId: toolCall.toolCallId, options: (params.options || []).length});
      this.emit('request', {
        id: message.id,
        method: 'approval/request',
        params: {
          sessionId: this.sessionId,
          requestId: message.id,
          toolName: toolCall.title || toolCall.kind || 'tool',
          callId: toolCall.toolCallId,
          reason: 'ACP permission request',
        },
      });
      return;
    }
    // Unknown client-side request: refuse explicitly instead of hanging the agent.
    this.write({jsonrpc: '2.0', id: message.id, error: {code: -32601, message: 'Unsupported client method'}});
  }

  write(value) {
    if (this.exited) throw new Error('ACP runtime exited');
    this.child.stdin.write(JSON.stringify({jsonrpc: '2.0', ...value}) + '\n');
  }

  /** Supervisor method names are translated here; the worker stays backend-agnostic. */
  async rpc(method, params) {
    if (method === 'initialize') return this.initialize(params);
    if (method === 'session/prompt') return this.prompt(params);
    if (method === 'session/wait') return this.wait();
    if (method === 'session/resume') return this.resume();
    return this.request(method, params);
  }

  request(method, params) {
    if (this.exited || this.failure) return Promise.reject(this.failure || new Error('Runtime exited'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ACP request timed out: ${method}`)); }, REQUEST_TIMEOUT);
      this.pending.set(id, {resolve, reject, timer});
      this.write({id, method, params});
    });
  }

  async initialize(params = {}) {
    if(this.state?.resume&&!this.acpSessionId)throw new Error('ACP session identity is missing; continuation cannot create a new session');
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false},
      clientInfo: {name: 'dsh-control', version: '0.4.0'},
    });
    const agentCaps = init?.agentCapabilities || {};
    if (this.state?.resume && this.acpSessionId) {
      if ((agentCaps.sessionCapabilities?.resume ?? false) === false) {
        throw new Error('ACP agent does not support session/resume; refusing to continue without the original session');
      }
      await this.request('session/resume', {sessionId: this.acpSessionId, cwd: this.state.cwd});
      this.log('resumed', {sessionId: this.acpSessionId});
    } else {
      const created = await this.request('session/new', {cwd: this.state.cwd, mcpServers: []});
      this.acpSessionId = created?.sessionId || null;
      if (!this.acpSessionId) throw new Error('ACP session/new returned no session id');
      this.log('created', {sessionId: this.acpSessionId});
      await this.pinConfig(created?.configOptions || []);
    }
    return {serverInfo: init?.agentInfo || {name: 'dsh-acp'}, acpSessionId: this.acpSessionId, agentCapabilities: agentCaps};
  }

  /** Pin the assigned model/effort. Model catalogs name routes differently from the
   * DSH config (observed: config `deepseek-flash` vs ACP `deepseek-v4-flash`, and the
   * ACP value is a JSON-encoded [provider, model] pair), so matching is tolerant and
   * an unmatched model is reported instead of pretending it was pinned. */
  async pinConfig(options = []) {
    const select = options.filter(option => option && typeof option.id === 'string');
    if (!select.length) { this.log('model-unpinned', {reason: 'no config options'}); return; }
    const flatten = option => (option.options || []).flatMap(entry => entry.options ? entry.options : [entry]);
    const decode = value => {
      try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
    };
    const pick = (option, wanted) => {
      if (!option || !wanted) return null;
      for (const choice of flatten(option)) {
        const value = choice.value ?? choice.id;
        if (value === wanted) return value;
        const parts = decode(value);
        if (parts && String(parts.at(-1)) === wanted) return value;
        if (choice.name === wanted) return value;
      }
      return null;
    };
    const byId = id => select.find(option => option.id === id);
    const modelOption = byId('model') || select.find(option => option.category === 'model');
    const effortOption = byId('reasoning_effort') || select.find(option => option.category === 'thought_level');
    const modelValue = pick(modelOption, this.state?.model);
    const effortValue = pick(effortOption, this.state?.reasoningEffort);
    if (modelOption && this.state?.model && !modelValue) {
      this.log('model-unpinned', {model: this.state.model, offered: flatten(modelOption).map(choice => choice.name || decode(choice.value)?.at(-1) || choice.value)});
      this.emitEvent({type: 'model_unpinned', data: {assigned: this.state.model, offered: flatten(modelOption).map(choice => choice.name || choice.value)}});
    }
    for (const [option, value] of [[modelOption, modelValue], [effortOption, effortValue]]) {
      if (option && value !== null) {
        await this.request('session/set_config_option', {sessionId: this.acpSessionId, configId: option.id, value});
        this.log('config', {configId: option.id, value});
      }
    }
  }

  onUpdate(params) {
    if (params.sessionId !== this.acpSessionId) return; // other sessions on the same connection are not ours
    const update = params.update || {};
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        if (isText(update.content)) this.message += update.content.text;
        return;
      }
      case 'agent_thought_chunk':
      case 'user_message_chunk':
        return;
      case 'tool_call': {
        this.flushMessage();
        this.emitEvent({type: 'tool/call', data: {callId: update.toolCallId, name: update.title || update.kind || 'tool', arguments: update.rawInput}});
        return;
      }
      case 'tool_call_update': {
        this.flushMessage();
        const error = update.status === 'failed' ? {message: 'ACP tool call failed'} : undefined;
        this.emitEvent({type: 'tool/result', data: {message: {callId: update.toolCallId, error, content: update.content}}});
        return;
      }
      case 'usage_update':
        this.emitEvent({type: 'usage', data: {used: update.used, size: update.size}});
        return;
      default:
        return;
    }
  }

  flushMessage() {
    if (!this.message) return;
    const text = this.message; this.message = '';
    this.messageSeq += 1;
    this.emitEvent({type: 'assistant/message', seq: this.messageSeq, data: {message: {content: [{type: 'text', text}]}}});
  }

  emitEvent(event) {
    this.emit('notification', {method: 'session.event', params: {sessionId: this.sessionId, event: {...event, seq: event.seq ?? ++this.messageSeq}}});
  }

  finalize(reason, extra = {}) {
    if (this.stopReason !== null) return;
    this.flushMessage();
    this.stopReason = reason;
    this.emitEvent({type: 'turn/end', data: {reason: {kind: reason === 'end_turn' ? 'completed' : reason}, turn: extra.code ?? null}});
  }

  /** Supervisor-shaped prompt: return a receipt now, settle on the ACP prompt response. */
  async prompt(params) {
    const text = (params?.contentBlocks || []).filter(isText).map(block => block.text).join('\n\n');
    const messageId = 'acp-' + crypto.randomUUID();
    this.settled = new Promise(resolve => { this.resolveSettlement = resolve; });
    this.settlement = this.request('session/prompt', {sessionId: this.acpSessionId, prompt: [{type: 'text', text}]})
      .then(result => {
        this.finalize(result?.stopReason || 'end_turn');
        this.resolveSettlement({stopReason: result?.stopReason || 'end_turn'});
        return result;
      }, error => {
        this.finalize('failed');
        this.resolveSettlement({error});
        throw error;
      });
    this.settlement.catch(() => {});
    return {messageId};
  }

  async wait() {
    if (!this.settled) throw new Error('No ACP prompt in flight');
    const outcome = await this.settled;
    if (outcome.error) throw outcome.error;
    return outcome;
  }

  async resume() { return {}; }

  async answer(id, response) {
    const pending = this.requests.get(id);
    if (!pending) throw new Error('Permission request is no longer pending');
    this.requests.delete(id);
    const options = pending.options || [];
    const allow = options.find(option => String(option.kind || '').startsWith('allow'));
    const reject = options.find(option => String(option.kind || '').startsWith('reject'));
    let result;
    if (response && (response.outcome === 'allowed-once' || response.outcome === 'allow')) {
      if (!allow) throw new Error('ACP agent offered no allow option');
      result = {outcome: {outcome: 'selected', optionId: allow.optionId}};
    } else if (response && response.outcome === 'cancelled') {
      result = {outcome: {outcome: 'cancelled'}};
    } else {
      if (!reject) throw new Error('ACP agent offered no reject option');
      result = {outcome: {outcome: 'selected', optionId: reject.optionId}};
    }
    this.write({id, result});
  }

  async stop(reason) {
    if (this.closed) return {code: this.exitCode ?? 0};
    this.closed = true;
    try {
      if (!this.exited && this.acpSessionId && this.settled && this.stopReason === null) {
        this.write({method: 'session/cancel', params: {sessionId: this.acpSessionId}});
        await Promise.race([this.settled, new Promise(resolve => setTimeout(resolve, 10000))]);
      }
      if (!this.exited && this.acpSessionId) {
        await Promise.race([this.request('session/close', {sessionId: this.acpSessionId}).catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
      }
    } finally {
      if (!this.exited) this.child.stdin.end();
      const exited = await Promise.race([this.exit, new Promise(resolve => setTimeout(() => resolve({code: null, timeout: true}), 3000))]);
      if (!this.exited) { this.forcedTermination = true; this.child.kill(); }
      const code = typeof this.exitCode === 'number' ? this.exitCode : 0;
      return {code: reason === 'cancelled' ? 0 : code, acp: true};
    }
  }
}

export function openAcp(cfg, run, patchPath) {
  const profile = cfg.acpProfile || 'acp';
  const child = spawn(cfg.executable, ['--expose-internals', cfg.cliEntry, '--profile', profile, '--patch', patchPath], {
    cwd: run.cwd,
    env: {...process.env, ...(cfg.dshHome?{DSH_HOME:cfg.dshHome}:{}),ELECTRON_RUN_AS_NODE: '1'},
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new AcpConnection(child, {sessionId: run.sessionId, state: run});
}
