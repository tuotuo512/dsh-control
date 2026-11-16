import {DesktopConnection} from './desktop-client.mjs';
import {openAcp} from './acp-client.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {openRuntime, inspectRuntime} from './runtime.mjs';
import {loadState, saveState, runDir, appendEvent, readJson, redact, sleep} from './store.mjs';
import {recordBinding, forgetBinding} from './bindings.mjs';

function publicText(content) { return Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text || '').join('\n') : ''; }
export function workerPrompt(state) {
  return [
    'You are a DeepSeek Harness worker directed by the Codex supervisor. The human authorized this bounded delegation; Codex retains overall planning, review and delivery.',
    `Workspace: ${state.cwd}. Permission: ${state.permission}. Owned paths: ${state.ownedPaths.join(', ') || 'none (read-only)'}.`,
    'You are not alone in the workspace. Preserve other people\'s edits. Follow applicable AGENTS.md and owner documentation. Stay within the assigned task and owned paths. Do not delegate further, publish, commit, install software, or launch background processes unless the task explicitly authorizes it.',
    'Use ask_user_question for a blocking question to the supervisor. Never request or print secrets. Report actual results, changed files, checks and unresolved items; do not claim completion without evidence. For a connectivity-only prompt, follow its requested concise response.',
    ...(state.backend === 'acp' ? ['This ACP session has no interactive question tool. If you are blocked on a decision, stop and report the exact question in your final message instead of waiting.'] : []),
    '--- Assigned task ---', state.prompt,
  ].join('\n');
}
export async function runWorker(home, runId, {open = openRuntime, inspect = inspectRuntime, acp = openAcp} = {}) {
  const state = loadState(home, runId, false); const dir = runDir(home, runId);
  state.workerPid = process.pid; state.status = 'starting'; saveState(home, state);
  let runtime; let interval; let stopReason; let stopPromise; let lastTurn; let waitSucceeded = false; let error;
  const requests = [];
  const record = event => { const cursor = appendEvent(home, state, event); saveState(home, state, false); return cursor; };
  const persist = () => saveState(home, state);
  const publishPending = () => {
    if (requests.length) {
      const next = requests[0]; state.pending = {pendingId: next.pendingId, kind: next.kind, params: next.params};
      state.status = next.kind === 'approval' ? 'awaiting_approval' : 'awaiting_input';
    } else { delete state.pending; if (!stopReason) state.status = 'running'; }
    persist();
  };
  const stop = reason => {
    if (!stopReason) { stopReason = reason; state.status = 'closing'; state.stopReason = reason; record({type: 'stopping', reason}); persist(); }
    if (!stopPromise && runtime) stopPromise = runtime.stop(reason);
    return stopPromise;
  };
  try {
    const cfg = state.runtimeConfig; const current = inspect(cfg);
    if (!current.compatible) throw new Error(current.warning || 'Runtime fingerprint changed');
    state.runtime = current;
    const patchPath = path.join(dir, 'permission.patch.yml');
    fs.writeFileSync(patchPath, `- id: permission\n  config:\n    defaultPreset: ${state.permission}\n`);
    state.runtimeOwnership = 'launching'; persist();
    runtime = state.backend==='acp' ? acp(cfg, state, patchPath)
      : state.backend==='desktop' ? new DesktopConnection(home,state)
      : open(cfg, state, patchPath); if(runtime.child)state.runtimePid = runtime.child.pid; state.runtimeOwnership = 'owned'; persist();
    runtime.on('notification', msg => {
      const p = msg.params;
      if (['user-question.cancelled','control.input_cancelled'].includes(msg.method)) {
        const index = requests.findIndex(r => r.params.requestId === p.requestId);
        if (index !== -1) { requests.splice(index, 1); record({type: 'input_cancelled', requestId: p.requestId}); publishPending(); }
        return;
      }
      if (p?.sessionId !== state.sessionId) return;
      if (msg.method === 'session.status') { state.agentStatus = p.status; record({type: 'agent_status', status: p.status}); return; }
      if (msg.method !== 'session.event') return;
      const e = p.event; const d = e.data;
      if (e.type === 'request/context') {
        state.actualModel = {provider: d.provider, model: d.model}; record({type: 'model', ...state.actualModel});
        if (d.provider !== state.provider || d.model !== state.model) { error = new Error('Actual provider/model differs from assigned route'); void stop('failed'); }
      } else if (e.type === 'assistant/message') {
        const text = redact(publicText(d.message?.content)).slice(0, 200000);
        if (text) { const cursor = record({type: 'message', seq: e.seq, text}); state.messages.push({cursor, seq: e.seq, text}); persist(); }
      } else if (e.type === 'tool/call') {
        const tool = {callId: d.callId, name: d.name, status: 'running'}; state.tools.push(tool);
        record({type: 'tool_call', ...tool, arguments: redact(typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments)).slice(0, 2000)});
      } else if (e.type === 'tool/result') {
        const callId = d.message?.callId ?? d.message?.toolCallId;
        const tool = state.tools.find(t => t.callId === callId) || state.tools.findLast(t => t.status === 'running');
        const toolError = d.message?.error;
        if (tool) { tool.status = toolError ? 'error' : 'returned'; if (toolError) tool.error = redact(JSON.stringify(toolError)); }
        record({type: 'tool_result', callId: tool?.callId, name: tool?.name, error: toolError ? redact(JSON.stringify(toolError)) : undefined,
          text: redact(publicText(d.message?.content)).slice(0, 6000)});
      } else if (e.type === 'turn/end') {
        lastTurn = d.reason; state.turnReason = d.reason; record({type: 'turn_end', reason: d.reason, turn: d.turn});
      }
    });
    runtime.on('request', msg => {
      if (!['approval/request', 'user-question/ask'].includes(msg.method) || msg.params?.sessionId !== state.sessionId) {
        Promise.resolve(runtime.answer(msg.id, msg.method === 'approval/request' ? {outcome: 'rejected'} : {cancelled: true})).catch(e=>{error=e;void stop('failed');}); return;
      }
      const pendingId = state.backend==='desktop'?String(msg.id):crypto.randomUUID(); const kind = msg.method === 'approval/request' ? 'approval' : 'question';
      const params = kind === 'approval' ? {sessionId: msg.params.sessionId, requestId:msg.params.requestId, toolName: msg.params.toolName, callId: msg.params.callId, reason: redact(msg.params.reason || '')}
        : {sessionId: msg.params.sessionId, requestId: msg.params.requestId, questions: JSON.parse(redact(JSON.stringify(msg.params.questions)))};
      requests.push({id: msg.id, pendingId, kind, params}); record({type: 'input_required', pendingId, kind, params}); publishPending();
    });
    const deadline = Date.now() + state.timeoutSeconds * 1000;
    let lastHeartbeat = 0;
    let answering=false;
    interval = setInterval(async () => {
      if(answering)return;answering=true;
      try {
        if (Date.now() >= deadline) { void stop('timed_out'); return; }
        if (fs.existsSync(path.join(dir, 'cancel.json'))) { void stop('cancelled'); return; }
        const responsePath = path.join(dir, 'response.json');
        if (fs.existsSync(responsePath)) {
          const response = readJson(responsePath); fs.unlinkSync(responsePath);
          const pending = requests[0];
          if (pending && pending.pendingId === response.pendingId && !stopReason) {
            try {await runtime.answer(pending.id, response.response);} catch(e) {
              if(state.backend!=='desktop'||!(/pending|stale|already|answered/i.test(e.message)))throw e;
              record({type:'input_answer_race',pendingId:pending.pendingId});
            }
            const answeredIndex=requests.findIndex(r=>r.pendingId===pending.pendingId);
            if(answeredIndex!==-1)requests.splice(answeredIndex,1);
            record({type: 'input_answered', pendingId: response.pendingId}); publishPending();
          } else record({type: 'stale_response_ignored', pendingId: response.pendingId});
        }
        if (Date.now() - lastHeartbeat > 2000) { lastHeartbeat = Date.now(); saveState(home, state, false); }
      } catch (e) { error = e; void stop('failed'); } finally {answering=false;}
    }, 200);
    state.serverInfo = (await runtime.rpc('initialize', {cwd: state.cwd, provider: state.provider, model: state.model,
      reasoningEffort: state.reasoningEffort, approvalRequests: true, capabilities: {userQuestions: state.backend !== 'acp'}})).serverInfo;
    if (state.backend === 'acp' && runtime.acpSessionId) { state.acpSessionId = runtime.acpSessionId; record({type: 'acp_session', sessionId: runtime.acpSessionId}); }
    if(runtime.hostPid)state.hostPid=runtime.hostPid;
    if(state.backend==='desktop'){
      state.workspaceId=runtime.workspaceId;state.workspaceTitle=runtime.workspaceTitle;
      await recordBinding(home,state);
    }
    if (stopReason) throw new Error('Stopped before admission');
    if (state.resume) { await runtime.rpc('session/resume', {sessionId: state.sessionId}); record({type: 'session_resumed'}); }
    if (stopReason) throw new Error('Stopped before admission');
    state.status = 'running'; state.startedAt = new Date().toISOString(); persist();
    const receipt = await runtime.rpc('session/prompt', {sessionId: state.sessionId, contentBlocks: [{type: 'text', text: workerPrompt(state)}]});
    if(state.backend!=='desktop')await recordBinding(home,state);
    if(state.backend==='desktop'){state.nativeRequestId=receipt.requestId;record({type:'accepted',requestId:receipt.requestId});}else{state.messageId=receipt.messageId;record({type:'accepted',messageId:receipt.messageId});}
    await runtime.rpc('session/wait', {sessionId: state.sessionId}); waitSucceeded = true;
  } catch (e) {
    error ||= e;
    if(['DSH_SESSION_ARCHIVED','DSH_SESSION_NOT_FOUND'].includes(e.code)){
      try{await forgetBinding(home,state.sessionId);}catch(noteError){state.bindingsError=redact(noteError.message);}
    }
  }
  finally {
    if (interval) clearInterval(interval);
    state.status = 'closing'; delete state.pending; persist();
    let exit = {code: null};
    if (runtime) exit = await (stopPromise || runtime.stop());
    if(state.backend==='desktop'){state.hostPid=exit.hostPid||runtime?.hostPid;state.releaseScope=exit.scope;state.nativeCompletion=exit.status;}else state.runtimeExitCode = exit.code; state.forcedTermination = Boolean(runtime?.forcedTermination || exit.unconfirmed);
    state.runtimeOwnership = exit.unconfirmed ? 'owned' : 'released'; state.leaseHeld = Boolean(exit.unconfirmed);
    if (stopReason === 'cancelled' || stopReason === 'timed_out') state.status = stopReason;
    else if (!error && waitSucceeded && lastTurn?.kind === 'completed' && (state.backend==='desktop'?exit.released&&exit.status==='completed':exit.code===0) && !state.forcedTermination) state.status = 'completed';
    else state.status = 'failed';
    if (exit.unconfirmed) state.status = 'interrupted';
    if(state.backend==='desktop'&&runtime?.failure){state.status='interrupted';state.leaseHeld=true;state.runtimeOwnership='owned';}
    if(error?.code)state.errorCode=error.code;
    if(Number.isInteger(error?.status))state.httpStatus=error.status;
    if (state.status !== 'completed') state.error = redact(error?.message || `Run stopped: ${stopReason || lastTurn?.kind || 'missing completion receipt'}`);
    state.finishedAt = new Date().toISOString(); record({type: 'finished', status: state.status, reason: state.turnReason, runtimeExitCode: exit.code}); persist();
  }
  return state;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const launch = path.join(runDir(process.argv[2], process.argv[3]), 'launch.json');
    for (let n = 0; n < 100 && !fs.existsSync(launch); n++) await sleep(100);
    if (!fs.existsSync(launch) || readJson(launch).workerPid !== process.pid) throw new Error('Worker admission handshake did not complete; no DSH runtime was started');
    return runWorker(process.argv[2], process.argv[3]);
  })().catch(error => {
    try { const state = loadState(process.argv[2], process.argv[3], false); state.status = 'failed'; state.error = redact(error.message); saveState(process.argv[2], state); } catch {}
    process.exitCode = 1;
  });
}
