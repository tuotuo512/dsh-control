import {DesktopClient} from './desktop-client.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {config, inspectRuntime} from './runtime.mjs';
import {defaultHome, ensure, locked, allStates, loadState, readJson, writeJson, saveState, snapshot, runDir, terminal, attention, sleep, id, alive} from './store.mjs';
import {bindingsPath, recordBinding, refreshBinding} from './bindings.mjs';
import {checkPermission, isWriter, workspacePolicy, updateWorkspacePolicy} from './permissions.mjs';

const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const string = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`); return value; };
function integer(value, fallback, min, max, name) { const n = value ?? fallback; if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be ${min}..${max}`); return n; }
function canonical(p) {
  if (!path.isAbsolute(p)) throw new Error('Workspace and ownedPaths must be absolute paths');
  if (fs.existsSync(p)) return fs.realpathSync.native(p);
  if (path.dirname(p) === p) throw new Error('Path root does not exist');
  return path.join(canonical(path.dirname(p)), path.basename(p));
}
const keyPath = p => process.platform === 'win32' ? p.toLowerCase() : p;
export function contains(root, child) { const rel = path.relative(keyPath(root), keyPath(child)); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
export function overlaps(a, b) { return contains(a, b) || contains(b, a); }
function launchWorker(home, runId) {
  const stderr = fs.openSync(path.join(runDir(home, runId), 'worker.stderr.log'), 'a', 0o600);
  const child = spawn(process.execPath, [workerPath, home, runId], {detached: true, windowsHide: true, stdio: ['ignore', 'ignore', stderr]});
  fs.closeSync(stderr);
  child.on('error', error => { const state = loadState(home, runId, false); if (!terminal.has(state.status)) { state.status = 'failed'; state.error = `Worker spawn failed: ${error.message}`; saveState(home, state); } });
  if (!child.pid) throw new Error('Worker did not receive a process id');
  const state = loadState(home, runId, false); state.workerPid = child.pid; saveState(home, state);
  writeJson(path.join(runDir(home, runId), 'launch.json'), {workerPid: child.pid});
  child.unref(); return child.pid;
}
function recoverOwnedRuntime(home, state) {
  if (process.platform !== 'win32') throw new Error('Orphan recovery on this platform requires manual runtime identity verification');
  const patch = path.join(runDir(home, state.runId), 'permission.patch.yml');
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'DeepSeek Harness.exe' -and $_.CommandLine -and $_.CommandLine.Contains($env:DSH_CONTROL_RECOVERY_PATCH) } | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: true, encoding: 'utf8', timeout: 10000, env: {...process.env, DSH_CONTROL_RECOVERY_PATCH: patch}}).trim();
  const values = raw ? [].concat(JSON.parse(raw)) : [];
  for (const candidate of values) {
    if (keyPath(path.resolve(candidate.ExecutablePath || '')) !== keyPath(path.resolve(state.runtimeConfig.executable))) throw new Error('Orphan runtime identity does not match the assigned installation');
    process.kill(candidate.ProcessId);
  }
  return values.map(x => x.ProcessId);
}
export function createController({home = defaultHome(), launch = launchWorker, inspect = inspectRuntime} = {}) {
  ensure(home);
  async function doctor() {
    const cfg = config(home); const runtime = inspect(cfg);
    let desktop; if((cfg.defaultBackend??'sdk')==='desktop'){try{desktop=await new DesktopClient(home).health();}catch(e){desktop={ready:false,error:e.message};}}
    return {ready: runtime.compatible && (desktop===undefined||desktop.ready!==false), defaultBackend:cfg.defaultBackend??'sdk', backends:['sdk','desktop','acp'], acp:{profile:cfg.acpProfile||'acp', interactiveQuestions:false}, desktop, runtime, stateDirectory: home, bindingsPath:bindingsPath(home), maxParallel: cfg.maxParallel,
      communication: {directToolResults: true, durableMarkdown: true, wakeEndedCodexChat: false}};
  }
  function view(state, compact = false) {
    const value = snapshot(home, state);
    if (!compact) return value;
    const fields = ['runId','sessionId','backend','cwd','workspaceId','title','status','permission','permissionSource','eventCursor','pending','reportPath','error','errorCode','leaseHeld','runtimeOwnership','executionHealth','toolCount','heartbeatStale'];
    return {...Object.fromEntries(fields.filter(k => value[k] !== undefined).map(k => [k, value[k]])), latestMessage: value.latestMessage?.slice(-600)};
  }
  async function workspace_policy(input) {
    return Object.hasOwn(input, 'permission') ? updateWorkspacePolicy(home, input) : workspacePolicy(home, input.cwd);
  }
  async function preflight(input) {
    const policy = workspacePolicy(home, input.cwd), cfg = config(home);
    const permission = checkPermission(input.permission ?? policy.permission);
    const backend = input.backend ?? cfg.defaultBackend ?? 'sdk';
    if (!['desktop','sdk','acp'].includes(backend)) throw new Error('Invalid backend');
    if (input.workspaceId && backend !== 'desktop') throw new Error('workspaceId requires the desktop backend');
    const ownedPaths = (input.ownedPaths ?? []).map(canonical), blockers = [];
    if (isWriter(permission) && !ownedPaths.length) blockers.push('write_permission_requires_ownedPaths');
    if (ownedPaths.some(p => !contains(policy.cwd, p))) blockers.push('ownedPaths_outside_workspace');
    if (backend === 'acp' && permission === 'danger-full-access') blockers.push('acp_full_access_unverified');
    const runtime = inspect(cfg);
    if (!runtime.compatible) blockers.push('runtime_fingerprint_changed');
    const live = allStates(home).filter(s => !terminal.has(s.status) || s.leaseHeld);
    if (live.length >= cfg.maxParallel) blockers.push('parallel_limit');
    if (isWriter(permission) && live.some(s => isWriter(s.permission) && s.ownedPaths.some(a => ownedPaths.some(b => overlaps(a,b))))) blockers.push('write_ownership_overlap');
    let desktop;
    if (backend === 'desktop') {
      try {
        const client = new DesktopClient(home); desktop = await client.health();
        if (desktop.ready === false) blockers.push('desktop_not_ready');
        if (desktop.archiveSha256 !== cfg.verifiedArchiveSha256) blockers.push('desktop_fingerprint_changed');
        if (permission === 'danger-full-access' && !desktop.permissionPresets?.includes(permission)) blockers.push('desktop_permission_capability_missing');
        if (input.workspaceId) {
          let offset = 0, found;
          do {
            const page = await client.call('list-workspaces', {limit:100, offset});
            found = page.workspaces.find(w => w.workspaceId === input.workspaceId);
            if (found || page.nextOffset === null) break;
            if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error('Invalid workspace pagination');
            offset = page.nextOffset;
          } while (true);
          if (!found) blockers.push('workspace_not_found');
          else if (keyPath(canonical(found.cwd)) !== keyPath(policy.cwd)) blockers.push('workspace_path_mismatch');
        }
      } catch (error) { blockers.push('desktop_unavailable'); desktop = {error:error.message}; }
    }
    return {ready:!blockers.length, cwd:policy.cwd, backend, permission, permissionSource:input.permission === undefined ? policy.source : 'explicit', policyRevision:policy.revision, blockers, shell:'not_probed', createsChat:false, callsModel:false, runtime, desktop};
  }
  async function admit(input, continuation) {
    string(input.requestId, 'requestId'); if (input.requestId.length > 200) throw new Error('requestId too long');
    string(input.prompt, 'prompt'); if (input.prompt.length > 200000) throw new Error('prompt exceeds 200000 characters');
    if (input.title !== undefined) string(input.title, 'title');
    const runId = 'run-' + crypto.createHash('sha256').update(input.requestId).digest('hex').slice(0, 24);
    // Canonical input identity includes the operation and all explicit arguments.
    const chosenBackend=input.backend??config(home).defaultBackend??'sdk';if(!['sdk','desktop','acp'].includes(chosenBackend))throw Error('Invalid backend');
    if(!continuation&&input.workspaceId!==undefined){id(input.workspaceId,'workspaceId');if(chosenBackend!=='desktop')throw Error('workspaceId requires the desktop backend');}
    const normalized = continuation ? {...input} : {...input, backend:chosenBackend, cwd: canonical(string(input.cwd, 'cwd')), permission: input.permission ?? 'project-default', ownedPaths: input.ownedPaths || [], timeoutSeconds: input.timeoutSeconds ?? 1800};
    const signature = crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries({operation: continuation ? 'send' : 'start', ...normalized}).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
    return locked(home, async () => {
      const file = path.join(runDir(home, runId), 'state.json');
      if (fs.existsSync(file)) {
        const existing = loadState(home, runId);
        const legacy = !continuation && existing.permissionSource === undefined
          ? crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries({operation:'start',...normalized,permission:input.permission || 'read-only'}).sort(([a],[b])=>a.localeCompare(b))))).digest('hex') : undefined;
        if (existing.signature !== signature && existing.signature !== legacy) throw new Error('requestId already used with different arguments');
        return {...view(existing), deduplicated: true};
      }
      const cfg = config(home); const runtime = inspect(cfg);
      if (!runtime.compatible) throw new Error(runtime.warning);
      const states = allStates(home); const live = states.filter(s => !terminal.has(s.status) || s.leaseHeld);
      if (live.length >= cfg.maxParallel) throw new Error(`Parallel limit ${cfg.maxParallel} reached; wait for an existing run`);
      let base;
      if (continuation) {
        id(input.sessionId, 'sessionId'); base = states.find(s => s.sessionId === input.sessionId);
        if (!base) throw new Error('Only bridge-managed sessions may be continued');
        if (live.some(s => s.sessionId === input.sessionId)) throw new Error('Session is busy; use status/wait/respond, not a second prompt');
        if (['interrupted', 'timed_out'].includes(base.status) || base.forcedTermination) throw new Error('Previous run has uncertain side effects. Inspect report and use a new task; automatic continuation is refused.');
      }
      const backend=base?(base.backend||'sdk'):chosenBackend;
      if(backend==='acp'&&base&&!base.acpSessionId)throw new Error('ACP session identity is missing; refusing to create a new session for a continuation');
      let native,checked;
      if(backend==='desktop'){
        native=new DesktopClient(home);const h=await native.health();if(h.archiveSha256!==cfg.verifiedArchiveSha256)throw Error('Desktop fingerprint mismatch');
        if(base){
          checked=await inspectNativeSession(native,base.sessionId);
          await refreshBinding(home,checked);
          requireSendable(checked);
          if(keyPath(canonical(checked.cwd))!==keyPath(canonical(base.cwd)))throw Error('Native session directory differs from the recorded workspace; inspect before sending');
          if(base.workspaceId&&checked.workspaceId!==base.workspaceId)throw Error('Native session workspace changed; inspect before sending');
        }
      }
      const cwd = base?.cwd || canonical(string(input.cwd, 'cwd'));
      const workspaceId=base?(checked?.workspaceId||base.workspaceId):input.workspaceId;
      let workspaceTitle=checked?.workspaceTitle||base?.workspaceTitle;
      if(native&&!base&&workspaceId){
        let offset=0,selected;
        do{const page=await native.call('list-workspaces',{limit:100,offset});selected=page.workspaces.find(w=>w.workspaceId===workspaceId);if(selected||page.nextOffset===null)break;if(!Number.isSafeInteger(page.nextOffset)||page.nextOffset<=offset)throw Error('Invalid native workspace pagination');offset=page.nextOffset;}while(true);
        if(!selected)throw Error('Selected workspace no longer exists; no new workspace was created');
        if(keyPath(canonical(selected.cwd))!==keyPath(cwd))throw Error('Selected workspace directory differs from cwd');
        workspaceTitle=selected.title;
      }
      if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd must be an existing directory');
      const policy = base ? undefined : workspacePolicy(home, cwd);
      const permission = checkPermission(base?.permission ?? input.permission ?? policy.permission);
      if (backend === 'acp' && permission === 'danger-full-access') throw new Error('ACP full-access preset has not been verified; select a supported backend explicitly');
      const permissionSource = base ? 'session' : input.permission === undefined ? policy.source : 'explicit';
      if (native && permission === 'danger-full-access') {
        const health = await native.health();
        if (!health.permissionPresets?.includes(permission)) throw new Error('Desktop plugin does not advertise danger-full-access; update it after active runs finish');
      }
      const ownedPaths = base?.ownedPaths || (input.ownedPaths || []).map(p => canonical(string(p, 'ownedPath')));
      if (isWriter(permission) && ownedPaths.length === 0) throw new Error('Write permission requires explicit ownedPaths');
      if (ownedPaths.some(p => !contains(cwd, p))) throw new Error('Every ownedPath must be inside the canonical cwd');
      if (isWriter(permission)) for (const other of live.filter(s => isWriter(s.permission))) {
        if (other.ownedPaths.some(a => ownedPaths.some(b => overlaps(a, b)))) throw new Error(`Write ownership overlaps active run ${other.runId}`);
      }
      const timeoutSeconds = base?.timeoutSeconds || integer(input.timeoutSeconds, 1800, 5, 14400, 'timeoutSeconds');
      const state = {schemaVersion: 1, backend, runId, requestId: input.requestId, signature,
        sessionId: base?.sessionId || 'session-' + crypto.randomUUID(), resume: Boolean(base), previousRunId: base?.runId,
        ...(backend==='acp'&&base?{acpSessionId:base.acpSessionId}:{}),
        cwd, ...(workspaceId?{workspaceId,workspaceTitle}:{}), permission, permissionSource, ownedPaths, prompt: input.prompt, title: input.title || (base ? base.title : 'DSH delegated task'),
        provider: base?.provider || cfg.provider, model: base?.model || cfg.model, reasoningEffort: base?.reasoningEffort || cfg.reasoningEffort,
        timeoutSeconds, runtime, runtimeConfig: cfg, status: 'starting', createdAt: new Date().toISOString(),
        runtimeOwnership: 'not-started', eventCursor: 0, messages: [], tools: []};
      fs.mkdirSync(runDir(home, runId), {recursive: true}); saveState(home, state);
      try { launch(home, runId); } catch (e) { state.status = 'failed'; state.error = e.message; saveState(home, state); throw e; }
      return view(loadState(home, runId));
    });
  }
  async function start(input) { return admit(input, false); }
  async function send(input) { return admit(input, true); }
  async function status({runId, afterEvent = 0, maxEvents, compact = false} = {}) {
    id(runId); integer(afterEvent, 0, 0, Number.MAX_SAFE_INTEGER, 'afterEvent'); const max = integer(maxEvents, 20, 1, 100, 'maxEvents');
    const state = loadState(home, runId); const file = path.join(runDir(home, runId), 'events.jsonl');
    const events = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }).filter(e => e.cursor > afterEvent).slice(0, max) : [];
    return {...view(state, compact), events, nextEvent: events.at(-1)?.cursor ?? afterEvent, hasMoreEvents: (events.at(-1)?.cursor ?? afterEvent) < state.eventCursor};
  }
  async function result({runId, maxChars} = {}) {
    const state = loadState(home, id(runId)); const max = integer(maxChars, 12000, 1, 50000, 'maxChars');
    const text = state.messages.map(m => m.text).join('\n\n');
    return {...view(state), output: text.slice(-max), truncated: text.length > max, tools: state.tools.slice(-100), finished: terminal.has(state.status)};
  }
  async function list({limit, compact = false} = {}) { return {runs: allStates(home).slice(0, integer(limit, 20, 1, 100, 'limit')).map(s => view(s, compact))}; }
  async function wait({runIds, timeoutMs, after = {}, compact = false} = {}) {
    if (!Array.isArray(runIds) || !runIds.length || runIds.length > 8) throw new Error('runIds must contain 1..8 ids');
    runIds.forEach(x => id(x)); const deadline = Date.now() + integer(timeoutMs, 10000, 0, 30000, 'timeoutMs');
    for (;;) {
      const runs = runIds.map(x => loadState(home, x));
      const ready = runs.find(s => attention.has(s.status) || terminal.has(s.status));
      if (ready) return {reason: attention.has(ready.status) ? 'input-required' : 'terminal', runs: runs.map(s => view(s, compact))};
      if (runs.some(s => after[s.runId] !== undefined && s.eventCursor > after[s.runId])) return {reason: 'progress', runs: runs.map(s => view(s, compact))};
      if (Date.now() >= deadline) return {reason: 'timeout', runs: runs.map(s => view(s, compact))};
      await sleep(Math.min(200, Math.max(1, deadline - Date.now())));
    }
  }
  async function respond({runId, pendingId, response} = {}) {
    id(runId); string(pendingId, 'pendingId');
    return locked(home, async () => {
      const state = loadState(home, runId); const pending = state.pending;
      if (!pending || pending.pendingId !== pendingId || !attention.has(state.status)) throw new Error('Input is no longer pending or pendingId is stale');
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('response must be an object');
      if (pending.kind === 'approval') {
        if (!['allowed-once', 'rejected', 'cancelled'].includes(response.outcome) || Object.keys(response).length !== 1) throw new Error('Approval response requires one valid outcome');
      } else if (response.cancelled === true) {
        if (Object.keys(response).length !== 1) throw new Error('Cancelled response must contain only cancelled: true');
      } else {
        const expected = pending.params.questions.map(q => q.id);
        if (!Array.isArray(response.answers) || response.answers.length !== expected.length || new Set(response.answers.map(a => a.id)).size !== expected.length || response.answers.some(a => !expected.includes(a.id))) throw new Error('Answer every pending question id exactly once');
      }
      const file = path.join(runDir(home, runId), 'response.json');
      if (fs.existsSync(file)) { const prior = readJson(file); if (prior.pendingId !== pendingId || JSON.stringify(prior.response) !== JSON.stringify(response)) throw new Error('A different answer is already queued'); }
      else writeJson(file, {pendingId, response});
      return {...view(state), responseQueued: true};
    });
  }
  async function cancel({runId} = {}) {
    const state = loadState(home, id(runId));
    if(state.backend==='desktop'&&state.leaseHeld&&!alive(state.workerPid)){
      const c=new DesktopClient(home);await c.health();await c.call('cancel',{runId,reason:'cancelled'});
      const receipt=await c.call('poll',{runId,after:0});if(!terminal.has(receipt.status))throw Error('Native cancellation not confirmed; lease retained');
      const released=await c.call('release',{runId});if(!released.released||released.scope!=='managed-run')throw Error('Native lease release unconfirmed');
      state.status='cancelled';state.leaseHeld=false;state.runtimeOwnership='released';state.hostPid=released.hostPid;state.releaseScope=released.scope;saveState(home,state);return view(state);
    }
    if (state.leaseHeld && !alive(state.workerPid)) {
      const pids = recoverOwnedRuntime(home, state);
      for (let attempt = 0; attempt < 25 && pids.some(alive); attempt++) await sleep(200);
      if (pids.some(alive)) throw new Error('Owned orphan termination is not yet confirmed; lease remains held');
      state.leaseHeld = false; state.status = 'cancelled'; state.forcedTermination = true; state.runtimeOwnership = 'released';
      state.error = 'Orphan runtime identity verified and stopped. Inspect side effects; do not replay automatically.'; saveState(home, state); return view(state);
    }
    if (terminal.has(state.status)) return view(state);
    writeJson(path.join(runDir(home, runId), 'cancel.json'), {requestedAt: new Date().toISOString()});
    return {...view(state), cancellationRequested: true};
  }
  async function desktop_sessions({limit}={}){const c=new DesktopClient(home);await c.health();return c.call('list-sessions',{limit:integer(limit,20,1,100,'limit')});}
  async function desktop_workspaces({limit,offset}={}){const c=new DesktopClient(home);await c.health();return c.call('list-workspaces',{limit:integer(limit,100,1,100,'limit'),offset:integer(offset,0,0,Number.MAX_SAFE_INTEGER,'offset')});}
  async function inspectNativeSession(client,sessionId){
    const info=await client.call('inspect-session',{sessionId:id(sessionId,'sessionId')});
    if(info.sessionId!==sessionId||typeof info.exists!=='boolean'||typeof info.archived!=='boolean')throw Error('Native session check is inconclusive; notes were preserved');
    return info;
  }
  function requireSendable(info){
    if(info.archived)throw Object.assign(Error('Session is archived; link removed and sending refused'),{code:'DSH_SESSION_ARCHIVED'});
    if(!info.exists)throw Object.assign(Error('Session no longer exists; link removed and sending refused'),{code:'DSH_SESSION_NOT_FOUND'});
  }
  async function desktop_session({sessionId}={}){
    const client=new DesktopClient(home);await client.health();const info=await inspectNativeSession(client,sessionId);
    await refreshBinding(home,info);return info;
  }
  async function adopt(input){
    string(input.requestId,'requestId');id(input.sessionId,'sessionId');
    const args={requestId:input.requestId,sessionId:input.sessionId,...(input.permission === undefined ? {} : {permission:checkPermission(input.permission)}),ownedPaths:(input.ownedPaths??[]).map(canonical),timeoutSeconds:integer(input.timeoutSeconds,1800,5,14400,'timeoutSeconds')};
    const runId='run-'+crypto.createHash('sha256').update(input.requestId).digest('hex').slice(0,24),signature=crypto.createHash('sha256').update(JSON.stringify({operation:'adopt',...args})).digest('hex');
    return locked(home,async()=>{
      const file=path.join(runDir(home,runId),'state.json');if(fs.existsSync(file)){const old=loadState(home,runId);if(old.signature!==signature)throw Error('requestId already used with different arguments');return {...view(old),deduplicated:true};}
      if(allStates(home).some(s=>s.sessionId===input.sessionId&&(!terminal.has(s.status)||s.leaseHeld)))throw Error('Session is busy');
      const peers=allStates(home).filter(s=>!terminal.has(s.status)||s.leaseHeld);
      const c=new DesktopClient(home);const h=await c.health();if(h.archiveSha256!==config(home).verifiedArchiveSha256)throw Error('Desktop fingerprint mismatch');const checked=await inspectNativeSession(c,input.sessionId);await refreshBinding(home,checked);requireSendable(checked);
      const policy=workspacePolicy(home,checked.cwd),permission=checkPermission(input.permission??policy.permission);
      if(isWriter(permission)&&!args.ownedPaths.length)throw Error('Write permission requires explicit ownedPaths');
      if(args.ownedPaths.some(p=>!contains(policy.cwd,p)))throw Error('Every ownedPath must be inside canonical cwd');
      if(permission==='danger-full-access'&&!h.permissionPresets?.includes(permission))throw Error('Desktop plugin does not advertise danger-full-access');
      if(isWriter(permission)&&peers.some(s=>isWriter(s.permission)&&s.ownedPaths.some(a=>args.ownedPaths.some(b=>overlaps(a,b)))))throw Error('Write ownership overlaps active run');
      const state={schemaVersion:1,runId,signature,...args,permission,permissionSource:input.permission===undefined?policy.source:'explicit',backend:'desktop',status:'starting',runtimeOwnership:'launching',leaseHeld:true,createdAt:new Date().toISOString(),messages:[],tools:[],eventCursor:0,runtimeConfig:config(home)};saveState(home,state);
      try{const native=await c.call('adopt',{...args,permission:state.permission});const cwd=canonical(native.cwd);if(args.ownedPaths.some(p=>!contains(cwd,p)))throw Error('Every ownedPath must be inside canonical cwd');Object.assign(state,native,{status:'attached',runtimeOwnership:'released',leaseHeld:false,note:'Attached idle native session. No prompt submitted; no work executed.'});saveState(home,state);await recordBinding(home,{...state,workspaceTitle:checked.workspaceTitle});return view(state);}catch(e){if(['DSH_SESSION_ARCHIVED','DSH_SESSION_NOT_FOUND'].includes(e.code))await refreshBinding(home,{sessionId:input.sessionId,exists:e.code!=='DSH_SESSION_NOT_FOUND',archived:e.code==='DSH_SESSION_ARCHIVED'});state.status=e.noEffects===true?'failed':'interrupted';state.leaseHeld=e.noEffects!==true;state.runtimeOwnership=e.noEffects===true?'released':'owned';state.error=e.message;state.errorCode=e.code;state.httpStatus=e.status;saveState(home,state);throw e;}
    });
  }
  return {workspace_policy, preflight, desktop_workspaces,desktop_session,desktop_sessions, adopt, doctor, start, send, status, result, list, wait, respond, cancel};
}
const controller = createController();
export const {workspace_policy, preflight, desktop_workspaces,desktop_session,desktop_sessions, adopt, doctor, start, send, status, result, list, wait, respond, cancel} = controller;
