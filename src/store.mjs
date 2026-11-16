import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const terminal = new Set(['attached', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);
export const attention = new Set(['awaiting_input', 'awaiting_approval']);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const defaultHome = () => process.env.DSH_CONTROL_HOME || path.join(os.homedir(), '.codex', 'dsh-control-state');
export function ensure(home) { fs.mkdirSync(path.join(home, 'runs'), {recursive: true}); }
export function id(value, label = 'runId') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
export function runDir(home, runId) { return path.join(home, 'runs', id(runId)); }
export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
    for (let attempt = 0;; attempt++) {
      try { fs.renameSync(tmp, file); break; }
      catch (e) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 6) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1)); }
    }
  }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export async function locked(home, action, lockName = 'admission.lock') {
  ensure(home);
  if (!/^[a-z-]+\.lock$/.test(lockName)) throw new Error('Invalid lock name');
  const file = path.join(home, lockName);
  const token = crypto.randomUUID();
  const until = Date.now() + 10000;
  for (;;) {
    try { fs.writeFileSync(file, JSON.stringify({pid: process.pid, token}), {flag: 'wx', mode: 0o600}); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let prior;
      try { prior = readJson(file); }
      catch (e) {
        if (e.code === 'ENOENT') continue;
        if (Date.now() < until) { await sleep(40); continue; }
        throw new Error(`Admission lock is unreadable. Inspect ${file}; do not remove it while a client is admitting work.`);
      }
      if (!alive(prior.pid)) throw new Error(`Stale admission lock at ${file}. Stop admission clients, verify the recorded owner is gone, then remove only this lock. Existing jobs are not replayed.`);
      if (Date.now() > until) throw new Error('Admission is busy; inspect existing runs before retrying with the same requestId.');
      await sleep(40);
    }
  }
  try { return await action(); }
  finally { try { if (readJson(file).token === token) fs.unlinkSync(file); } catch {} }
}
export function redact(text) {
  return String(text).replace(/\b(?:sk|sk-proj)-[a-zA-Z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|password|access_token)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
export function report(home, state) {
  const text = [
    `# ${state.title || 'DSH task'}`, '', `- Run: ${state.runId}`, `- Session: ${state.sessionId}`,
    `- Status: ${state.status}`, `- Workspace: ${state.cwd}`, `- Permission: ${state.permission}`,
    `- Model: ${state.provider}/${state.model} (${state.reasoningEffort || 'default'})`,
    `- Updated: ${state.updatedAt}`, `- Event cursor: ${state.eventCursor || 0}`,
    state.backend === 'desktop' ? `- Desktop host: ${state.hostPid}; release scope: ${state.releaseScope ?? 'unconfirmed'}; host is never terminated` : `- Runtime exit: ${state.runtimeExitCode ?? 'not observed'}`, '',
    'Completion describes the agent run, not independent acceptance of its work.', '',
    state.error ? `## Error\n\n${state.error}\n` : '',
    state.pending ? `## Supervisor input required\n\n\`\`\`json\n${JSON.stringify(state.pending, null, 2)}\n\`\`\`\n` : '',
    '## Public output', '', ...(state.messages || []).map(m => `### Event ${m.cursor}\n\n${m.text}\n`),
    '## Tool evidence', '', ...(state.tools || []).map(t => `- ${t.name} (${t.callId}): ${t.status}${t.error ? `; ${t.error}` : ''}`),
    '', state.forcedTermination ? 'Forced runtime termination occurred. External side effects and subprocess cleanup require inspection; do not replay automatically.' : '',
  ].filter(x => x !== '').join('\n\n') + '\n';
  fs.writeFileSync(path.join(runDir(home, state.runId), 'report.md'), redact(text), {mode: 0o600});
}
export function saveState(home, state, writeReport = true) {
  state.updatedAt = new Date().toISOString();
  writeJson(path.join(runDir(home, state.runId), 'state.json'), state);
  if (writeReport) report(home, state);
}
export function loadState(home, runId, reconcile = true) {
  const state = readJson(path.join(runDir(home, runId), 'state.json'));
  if (reconcile && !terminal.has(state.status) && ((state.workerPid && !alive(state.workerPid)) ||
      (!state.workerPid && Date.now() - Date.parse(state.createdAt) > 30000))) {
    // A crash is never completion and never grounds for replaying the prompt.
    state.status = 'interrupted'; state.error = 'Supervisor worker exited without a terminal receipt; inspect outputs before continuing.';
    state.leaseHeld = state.runtimeOwnership === 'released' ? false : state.backend === 'desktop' ? true : state.runtimePid ? alive(state.runtimePid) : ['launching', 'owned'].includes(state.runtimeOwnership);
    state.finishedAt = new Date().toISOString(); delete state.pending; saveState(home, state);
  }
  if (reconcile && state.leaseHeld && state.runtimePid && !alive(state.runtimePid)) { state.leaseHeld = false; saveState(home, state); }
  return state;
}
export function allStates(home) {
  ensure(home);
  return fs.readdirSync(path.join(home, 'runs')).filter(x => /^run-[a-f0-9]+$/.test(x))
    .map(x => { try { return loadState(home, x); } catch { return null; } }).filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function snapshot(home, state) {
  const {prompt, messages, tools, signature, runtimeConfig, ...rest} = state;
  return {...rest, reportPath: path.join(runDir(home, state.runId), 'report.md'),
    latestMessage: (messages?.at(-1)?.text || '').slice(-4000), toolCount: tools?.length || 0,
    heartbeatStale: !terminal.has(state.status) && Date.now() - Date.parse(state.updatedAt) > 30000};
}
export function appendEvent(home, state, event) {
  const record = {cursor: (state.eventCursor || 0) + 1, at: new Date().toISOString(), ...event};
  state.eventCursor = record.cursor;
  fs.appendFileSync(path.join(runDir(home, state.runId), 'events.jsonl'), JSON.stringify(record) + '\n', {mode: 0o600});
  return record.cursor;
}
