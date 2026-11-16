import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {writeJson, readJson, redact} from './store.mjs';
import {PROTOCOL_VERSION, CAPABILITIES} from './protocol.mjs';
import {PERMISSIONS, checkPermission, isWriter} from './permissions.mjs';

export const PLUGIN_VERSION = '0.7.0';
const done = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const clean = value => JSON.parse(redact(JSON.stringify(value)));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, name, max = 200000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be nonempty and at most ${max} characters`);
  return value;
};
const safeId = (value, name) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
};
const canonical = value => {
  if (!path.isAbsolute(text(value, 'path'))) throw new Error('Expected an absolute path');
  return fs.existsSync(value) ? fs.realpathSync.native(value) : path.join(canonical(path.dirname(value)), path.basename(value));
};
const contains = (root, child) => {
  const key = p => process.platform === 'win32' ? p.toLowerCase() : p;
  const rel = path.relative(key(root), key(child));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
};
const publicContent = blocks => (blocks || []).filter(b => b.type === 'text').map(b => ({type: 'text', text: redact(String(b.text || '')).slice(0,200000)}));
const quietInbox = agent => !(agent.inbox?.nextTurn?.length || agent.inbox?.nextStep?.length);
const unavailable = (code, message) => Object.assign(new Error(message), {code});
const scope = input => {
  const cwd = canonical(input.cwd);
  if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd must be an existing directory');
  const permission = input.permission || 'read-only';
  checkPermission(permission);
  const ownedPaths = (input.ownedPaths || []).map(canonical);
  if (isWriter(permission) && !ownedPaths.length) throw new Error('Write permission requires ownedPaths');
  if (ownedPaths.some(p => !contains(cwd,p))) throw new Error('Owned paths must remain inside cwd');
  const timeoutSeconds = input.timeoutSeconds ?? 1800;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 14400) throw new Error('timeoutSeconds must be 5..14400');
  return {cwd, permission, ownedPaths, timeoutSeconds};
};

/** Native execution authority. The external transport never exposes arbitrary Host RPC. */
export class DesktopHostController {
  constructor(ctx, {home, runtime, maxParallel = 2, answerNative} = {}) {
    this.ctx = ctx; this.home = home; this.runtime = runtime; this.maxParallel = maxParallel;
    this.answerNative = answerNative; this.runs = new Map(); this.active = new Map(); this.pending = new Map();
    this.dir = path.join(home,'desktop'); this.runHome = path.join(this.dir,'runs');
    fs.mkdirSync(this.runHome,{recursive:true}); this.registryPath = path.join(this.dir,'sessions.json');
    this.registry = fs.existsSync(this.registryPath) ? readJson(this.registryPath) : {schemaVersion:1,sessions:{},adoptions:{}};
    if (this.registry.schemaVersion !== 1) throw new Error('Unsupported native session registry');
    this.tail = Promise.resolve(); this.closed = false;
    for (const name of fs.readdirSync(this.runHome).filter(n=>/^run-[a-f0-9]+\.json$/.test(n))) {
      const run = readJson(path.join(this.runHome,name));
      if (!done.has(run.status)) { run.status='interrupted';run.error='Desktop plugin generation changed; inspect native session before any continuation. No prompt was replayed.';this.persist(run); }
      this.runs.set(run.runId,run);
    }
    this.disposers = [
      ctx.on('session/event',(session,event)=>this.onEvent(session,event)),
      ctx.on('agent/status',({agent,status})=>{
        const run=this.activeRun(agent.session.id); if (!run) return;
        this.frame(run,{method:'session.status',params:{sessionId:run.sessionId,status}});
        if(status==='idle')void this.checkFinish(run);
      }),
      ctx.on('agent/error',({agent,error})=>{
        const run=this.activeRun(agent.session.id);if(!run)return;
        run.error=redact(error?.message||String(error));this.persist(run);void this.checkFinish(run);
      }),
    ];
    this.timer=setInterval(()=>{for(const run of this.runs.values())if(!done.has(run.status)&&Date.now()>run.deadline)void this.cancel({runId:run.runId,reason:'timed_out'}).catch(e=>{run.error=redact(e.message);this.persist(run);});},500);
    this.timer.unref?.();
  }
  serial(fn) { const p=this.tail.then(fn);this.tail=p.catch(()=>{});return p; }
  persist(run) { run.updatedAt=new Date().toISOString();writeJson(path.join(this.runHome,run.runId+'.json'),run); }
  saveRegistry() {writeJson(this.registryPath,this.registry);}
  activeRun(sessionId) {const run=this.runs.get(this.active.get(String(sessionId)));return run&&!done.has(run.status)?run:undefined;}
  get(runId) {safeId(runId,'runId');const run=this.runs.get(runId);if(!run)throw new Error('Unknown native managed run');return run;}
  frame(run,message) {
    const frame={cursor:++run.cursor,message:clean(message)};
    fs.appendFileSync(path.join(this.runHome,run.runId+'.events.jsonl'),JSON.stringify(frame)+'\n',{mode:0o600});
    this.persist(run);
  }
  supportedPermissions() {
    const catalog = this.ctx.permissionPresets.catalog?.();
    return catalog ? PERMISSIONS.filter(p => catalog.options?.some(o => o.value === p)) : PERMISSIONS.filter(p => p !== 'danger-full-access');
  }
  applyPermission(agent, permission) {
    if (!this.supportedPermissions().includes(permission)) throw new Error('Native permission preset is unavailable');
    this.ctx.permissionPresets.set(agent.session, permission);
    if (this.ctx.permissionPresets.current && this.ctx.permissionPresets.current(agent.session) !== permission) throw new Error('Native permission preset readback mismatch');
  }
  health() {return {ready:!this.closed,backend:'desktop',pluginVersion:PLUGIN_VERSION,protocolVersion:PROTOCOL_VERSION,...this.runtime,permissionPresets:this.supportedPermissions(),capabilities:{operations:[...CAPABILITIES],nativeWorkspace:true,nativeTitle:true,liveEvents:true,sharedQuestions:true,adoptIdleSession:true,killDesktop:false}};}
  async assertIdle(sessionId) {
    if (this.activeRun(sessionId)) throw new Error('Session already has an active supervised run');
    const agent=this.ctx.agents.get(sessionId);
    if(agent&&(agent.status==='running'||!quietInbox(agent)))throw new Error('Session is busy or has queued input; takeover refused');
    const nativePending=this.ctx.typertGateway.getPendingRemoteEvents();
    if(nativePending.some(p=>String(p.agentId)===sessionId))throw new Error('Session has pending native input; takeover refused');
    const activity=await this.ctx.waterfall('workspace/session-activity',{sessionId},()=>Promise.resolve([]));
    if(activity.length)throw new Error('Session has background activity; takeover refused');
  }
  async resolveAgent(sessionId) {
    const found=await this.ctx.sessionController.resolveAgent(sessionId);
    if('error' in found)throw found.error;
    return found.agent;
  }
  async listSessions({limit=20}={}) {
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('limit must be 1..100');
    const {items}=await this.ctx.sessionController.list({},AbortSignal.timeout(30000));
    const workspaceFor=new Map(this.ctx.workspaceRegistry.list().flatMap(w=>w.sessionIds.map(id=>[id,w.id])));
    return {sessions:items.filter(s=>s.origin!=='subagent').slice(0,limit).map(s=>({sessionId:s.sessionId,cwd:s.cwd,
      title:s.projections?.values?.title||this.registry.sessions[s.sessionId]?.title||'未命名',running:s.running,
      managed:Boolean(this.registry.sessions[s.sessionId]),workspaceId:workspaceFor.get(s.sessionId),
      archived:this.ctx.workspaceRegistry.archivedSessionIds.includes(s.sessionId)}))};
  }
  listWorkspaces({limit=100,offset=0}={}) {
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('limit must be 1..100');
    if(!Number.isSafeInteger(offset)||offset<0)throw new Error('offset must be a nonnegative integer');
    const all=this.ctx.workspaceRegistry.list();
    const workspaces=all.slice(offset,offset+limit).map(w=>({workspaceId:w.id,title:w.title,cwd:w.path,sessionCount:w.sessionIds.length}));
    return {workspaces,total:all.length,nextOffset:offset+limit<all.length?offset+limit:null};
  }
  async inspectSession({sessionId}) {
    safeId(sessionId,'sessionId');
    const agent=this.ctx.agents.get(sessionId);
    const session=agent?.session||this.ctx.sessions?.get(sessionId);
    const header=session?.header||(await this.ctx.sessionPersistence.stat(sessionId))?.header;
    const archived=this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId);
    if(!header)return {sessionId,exists:false,archived,managed:Boolean(this.registry.sessions[sessionId])};
    const workspace=this.ctx.workspaceRegistry.list().find(w=>w.sessionIds.includes(sessionId));
    const title=session?this.ctx.sessionProjections.snapshot(session,['title']).values.title:undefined;
    return {sessionId,exists:true,archived,cwd:header.cwd,title:title||this.registry.sessions[sessionId]?.title||'未命名',
      running:Boolean(agent&&(agent.status==='running'||!quietInbox(agent))),managed:Boolean(this.registry.sessions[sessionId]),
      ...(workspace?{workspaceId:workspace.id,workspaceTitle:workspace.title}:{})};
  }
  async assertSendable(sessionId) {
    const info=await this.inspectSession({sessionId});
    if(info.archived)throw unavailable('DSH_SESSION_ARCHIVED','Session is archived; sending is refused');
    if(!info.exists)throw unavailable('DSH_SESSION_NOT_FOUND','Session no longer exists; sending is refused');
    return info;
  }
  assertSessionWorkspace(info,assigned) {
    const actual=canonical(info.cwd);
    if(!contains(actual,assigned.cwd)||!contains(assigned.cwd,actual)||
      (assigned.workspaceId&&info.workspaceId!==assigned.workspaceId)){
      throw unavailable('DSH_WORKSPACE_MISMATCH','Native session workspace changed before sending');
    }
  }
  async adopt(input) {return this.serial(async()=>{
    text(input.requestId,'requestId',200);safeId(input.sessionId,'sessionId');
    const signature=hash(input),prior=this.registry.adoptions[input.requestId];
    if(prior){if(prior.signature!==signature)throw new Error('Adoption requestId reused with different arguments');return {...prior.value,deduplicated:true};}
    const stored=await this.ctx.sessionPersistence.stat(input.sessionId);
    if(!stored)throw unavailable('DSH_SESSION_NOT_FOUND','Existing session not found');
    if(stored.header.origin==='subagent')throw new Error('Subagent sessions cannot be adopted');
    if(this.ctx.workspaceRegistry.archivedSessionIds.includes(input.sessionId))throw unavailable('DSH_SESSION_ARCHIVED','Restore an archived session explicitly before adoption');
    await this.assertIdle(input.sessionId);
    const assigned=scope({...input,cwd:stored.header.cwd});
    const agent=await this.resolveAgent(input.sessionId);await this.assertIdle(input.sessionId);await this.assertSendable(input.sessionId);
    const workspace=await this.ctx.workspaceRegistry.create(assigned.cwd);
    await workspace.attachSession(input.sessionId);
    const route=agent.model.current();if(!route?.provider||!route?.model)throw new Error('Existing session has no established model route');
    this.applyPermission(agent,assigned.permission);
    const title=this.ctx.sessionProjections.snapshot(agent.session,['title']).values.title||'DSH adopted session';
    const value={sessionId:input.sessionId,...assigned,title,provider:route.provider,model:route.model,reasoningEffort:route.reasoningEffort,
      workspaceId:workspace.id,hostPid:this.runtime.pid,backend:'desktop'};
    this.registry.sessions[input.sessionId]={...value,adoptedAt:new Date().toISOString()};
    this.registry.adoptions[input.requestId]={signature,value};this.saveRegistry();return value;
  });}
  async open(input) {return this.serial(async()=>{
    if(this.closed)throw new Error('Desktop bridge is shutting down');
    if(!/^run-[a-f0-9]{24}$/.test(input.runId))throw new Error('Invalid runId');
    text(input.requestId,'requestId',200);safeId(input.sessionId,'sessionId');
    const signature=hash(input),prior=this.runs.get(input.runId);
    if(prior){if(prior.signature!==signature)throw new Error('Native runId reused with different arguments');if(prior.status==='interrupted')throw new Error(prior.error);return this.openReceipt(prior);}
    const assigned=scope(input);text(input.title,'title',200);text(input.provider,'provider',200);text(input.model,'model',200);
    if(!this.supportedPermissions().includes(assigned.permission))throw new Error('Native permission preset is unavailable');
    const resumedInfo=input.resume?await this.assertSendable(input.sessionId):undefined;
    const selectedWorkspaceId=input.workspaceId??(input.resume?this.registry.sessions[input.sessionId]?.workspaceId:undefined);
    let selectedWorkspace;
    if(selectedWorkspaceId!==undefined){
      safeId(selectedWorkspaceId,'workspaceId');selectedWorkspace=this.ctx.workspaceRegistry.get(selectedWorkspaceId);
      if(!selectedWorkspace)throw unavailable('DSH_WORKSPACE_NOT_FOUND','Selected workspace no longer exists');
      const selectedPath=canonical(selectedWorkspace.path);
      if(!contains(selectedPath,assigned.cwd)||!contains(assigned.cwd,selectedPath))throw unavailable('DSH_WORKSPACE_MISMATCH','Selected workspace directory differs from assigned cwd');
    }
    if(resumedInfo)this.assertSessionWorkspace(resumedInfo,{...assigned,workspaceId:selectedWorkspaceId});
    const active=[...this.runs.values()].filter(r=>!done.has(r.status));
    if(active.length>=this.maxParallel)throw new Error('Native parallel limit reached');
    if(isWriter(assigned.permission))for(const other of active.filter(r=>isWriter(r.permission))){
      if(other.ownedPaths.some(a=>assigned.ownedPaths.some(b=>contains(a,b)||contains(b,a))))throw new Error('Native write ownership overlaps another active run');
    }
    await this.assertIdle(input.sessionId);
    if(input.resume&&!this.registry.sessions[input.sessionId])throw new Error('Existing Desktop session requires explicit adoption');
    if(!input.resume&&(await this.ctx.sessionPersistence.stat(input.sessionId)))throw new Error('New session identity already exists; implicit reuse refused');
    await this.ctx.llm.resolveCallConfig({provider:input.provider,model:input.model,...input.reasoningEffort?{reasoningEffort:input.reasoningEffort}:{}});
    const run={schemaVersion:1,runId:input.runId,requestId:input.requestId,sessionId:input.sessionId,signature,...assigned,
      title:input.title,provider:input.provider,model:input.model,reasoningEffort:input.reasoningEffort,status:'prepared',cursor:0,
      createdAt:new Date().toISOString(),deadline:Date.now()+assigned.timeoutSeconds*1000,pendingIds:[],responses:{},sawInput:false};
    this.runs.set(run.runId,run);this.persist(run);
    try {
      const workspace=selectedWorkspace||await this.ctx.workspaceRegistry.create(assigned.cwd);run.workspaceId=workspace.id;run.workspaceTitle=workspace.title;
      let agent;
      if(input.resume){agent=await this.resolveAgent(input.sessionId);if(canonical(agent.session.header.cwd)!==assigned.cwd)throw new Error('Resumed session cwd differs from assigned workspace');await workspace.attachSession(input.sessionId);}
      else {const created=await this.ctx.sessionController.create({sessionId:input.sessionId,workspaceId:workspace.id});if(created.sessionId!==input.sessionId)throw new Error('Native create returned a different session; prompt refused');agent=await this.resolveAgent(created.sessionId);}
      await this.assertIdle(input.sessionId);
      this.applyPermission(agent,assigned.permission);
      agent.model.select({provider:input.provider,model:input.model,...input.reasoningEffort?{reasoningEffort:input.reasoningEffort}:{}});
      await this.ctx.sessionController.rename({sessionId:input.sessionId,title:input.title});
      run.afterSeq=agent.session.seq-1;
      this.registry.sessions[input.sessionId]={sessionId:input.sessionId,...assigned,title:input.title,workspaceId:workspace.id,
        provider:input.provider,model:input.model,reasoningEffort:input.reasoningEffort,backend:'desktop'};
      this.saveRegistry();this.active.set(input.sessionId,run.runId);this.persist(run);return this.openReceipt(run);
    }catch(e){run.status='failed';run.error=redact(e.message);this.persist(run);throw e;}
  });}
  openReceipt(run){return {sessionId:run.sessionId,workspaceId:run.workspaceId,workspaceTitle:run.workspaceTitle,cwd:run.cwd,title:run.title,hostPid:this.runtime.pid,backend:'desktop',
    serverInfo:{name:'dsh-native-desktop-control',version:PLUGIN_VERSION},status:run.status};}
  async prompt({runId,contentBlocks}) {return this.serial(async()=>{
    const run=this.get(runId);
    if(!Array.isArray(contentBlocks)||!contentBlocks.length||contentBlocks.some(b=>b.type!=='text'||typeof b.text!=='string'))throw new Error('Only text prompt blocks are accepted');
    text(contentBlocks.map(b=>b.text).join('\n'),'prompt');const signature=hash(contentBlocks);
    if(run.promptSignature){if(run.promptSignature!==signature)throw new Error('Prompt already admitted with different content');if(run.status==='interrupted')throw new Error(run.error);return {accepted:true,requestId:run.requestId,deduplicated:true};}
    if(run.status!=='prepared')throw new Error('Native run is not prepared');
    try{this.assertSessionWorkspace(await this.assertSendable(run.sessionId),run);}catch(error){run.status='failed';run.error=error.message;run.errorCode=error.code;this.persist(run);throw error;}
    const agent=this.ctx.agents.get(run.sessionId);if(!agent||agent.status==='running'||!quietInbox(agent))throw new Error('Native session changed before prompt admission');
    run.promptSignature=signature;run.status='running';run.phase='submitting';this.persist(run);
    try{
      await this.ctx.sessionController.prompt({sessionId:run.sessionId,requestId:run.requestId,mode:'queue',content:contentBlocks},AbortSignal.timeout(30000));
      run.phase='accepted';run.acceptedAt=new Date().toISOString();this.persist(run);return {accepted:true,requestId:run.requestId};
    }catch(e){run.status='interrupted';run.error='Native prompt outcome requires inspection: '+redact(e.message);this.persist(run);throw e;}
  });}
  onEvent(session,event) {
    const run=this.activeRun(session.id);if(!run||event.seq<=run.afterSeq||!run.promptSignature)return;
    const d=event.data;
    if(event.type==='user/message'){
      if(d.source?.rpcId===run.requestId)run.sawInput=true;
      else if(d.source?.kind==='user'||d.source?.kind==='retry'){
        run.foreignInput=true;run.status='interrupted';run.error='Another user input entered this session. Attribution ended; the bridge will not cancel that work.';this.persist(run);return;
      }
      this.persist(run);return;
    }
    let data;
    if(event.type==='request/context'){
      data={provider:d.provider,model:d.model};
      if(d.provider!==run.provider||d.model!==run.model){run.error='Actual native model route differs from assigned route';void this.cancel({runId:run.runId,reason:'failed'});}
    }else if(event.type==='assistant/message')data={message:{content:publicContent(d.message?.content)}};
    else if(event.type==='tool/call')data={callId:d.callId,name:d.name,arguments:redact(typeof d.arguments==='string'?d.arguments:JSON.stringify(d.arguments)).slice(0,2000)};
    else if(event.type==='tool/result')data={message:{callId:d.message?.callId,toolCallId:d.message?.toolCallId,content:publicContent(d.message?.content).map(b=>({...b,text:b.text.slice(0,6000)})),...d.message?.error?{error:redact(JSON.stringify(d.message.error))}:{}}};
    else if(event.type==='turn/end'){data={turn:d.turn,reason:d.reason};run.turnReason=d.reason;run.turnSeq=event.seq;}
    else return;
    this.frame(run,{method:'session.event',params:{sessionId:run.sessionId,event:{type:event.type,seq:event.seq,data}}});
    if(event.type==='turn/end')void this.checkFinish(run);
  }
  async checkFinish(run) {
    if(done.has(run.status)||run.checking||(!run.turnReason&&!run.stopReason&&!run.error))return;
    run.checking=true;
    try{
      const agent=this.ctx.agents.get(run.sessionId);if(!agent){run.status='interrupted';run.error='Native Agent disappeared before quiescence receipt';return;}
      await agent.whenIdle();
      if(done.has(run.status))return;
      if(agent.status==='running'||!quietInbox(agent)||run.pendingIds.length)return;
      if(run.foreignInput){run.status='interrupted';return;}
      if(run.stopReason)run.status=run.stopReason;
      else if(run.error)run.status='failed';
      else if(run.sawInput&&run.turnReason?.kind==='completed')run.status='completed';
      else {run.status='failed';run.error='Native turn did not provide a completed receipt for the admitted input';}
      run.finishedAt=new Date().toISOString();run.phase='finished';
    }catch(e){run.status='interrupted';run.error=redact(e.message);}
    finally{delete run.checking;this.persist(run);}
  }
  settlePending(eventId) {
    const pending=this.pending.get(eventId);if(!pending)return;
    this.pending.delete(eventId);const run=this.get(pending.runId);run.pendingIds=run.pendingIds.filter(id=>id!==eventId);
    this.frame(run,{method:'control.input_cancelled',params:{sessionId:run.sessionId,requestId:eventId}});
    if(!done.has(run.status)){run.status=run.pendingIds.length?(this.pending.get(run.pendingIds[0])?.kind==='approval'?'awaiting_approval':'awaiting_input'):'running';this.persist(run);void this.checkFinish(run);}
  }
  remoteFrame(frame) {
    if(frame.type==='cancel'){this.settlePending(frame.eventId);return;}
    if(frame.type!=='waterfall')return;
    const run=this.activeRun(frame.agentId);
    // Deliberately do not answer, export, persist or delegate unrelated Host events.
    if(!run||!['approval/request','user-questions/request'].includes(frame.event))return;
    if(this.pending.has(frame.eventId))return;
    const kind=frame.event==='approval/request'?'approval':'question';
    const request=frame.request;
    const params=kind==='approval'?{sessionId:run.sessionId,requestId:frame.eventId,toolName:request.toolName,callId:request.callId,reason:redact(request.reason||'')}
      :{sessionId:run.sessionId,requestId:frame.eventId,questions:clean(request.questions)};
    this.pending.set(frame.eventId,{runId:run.runId,kind,params});run.pendingIds.push(frame.eventId);run.status=kind==='approval'?'awaiting_approval':'awaiting_input';
    this.frame(run,{id:frame.eventId,method:kind==='approval'?'approval/request':'user-question/ask',params});
  }
  async respond({runId,pendingId,response}) {
    const run=this.get(runId),signature=hash(response);
    if(run.responses[pendingId]){if(run.responses[pendingId]!==signature)throw new Error('Different answer already submitted');return {accepted:true,deduplicated:true};}
    const pending=this.pending.get(pendingId);if(!pending||pending.runId!==runId)throw new Error('Native input is no longer pending');
    let value;
    if(pending.kind==='approval'){
      if(!response||Object.keys(response).length!==1||!['allowed-once','rejected','cancelled'].includes(response.outcome))throw new Error('Only explicit one-shot approval outcomes are accepted');
      value=response.outcome;
    }else{
      if(response?.cancelled===true)value={cancelled:true};
      else{
        const questions=pending.params.questions;
        if(!Array.isArray(response?.answers)||response.answers.length!==questions.length||new Set(response.answers.map(a=>a.id)).size!==questions.length)throw new Error('Answer each question exactly once');
        for(const a of response.answers){const q=questions.find(q=>q.id===a.id);if(!q||!Array.isArray(a.selected)||a.selected.some(s=>!q.options?.some(o=>o.label===s))||(a.custom!==undefined&&typeof a.custom!=='string'))throw new Error('Invalid question answer');}
        value=response;
      }
    }
    await this.answerNative(pendingId,value);run.responses[pendingId]=signature;
    // The native gateway cancels competing Peers; the winning Peer may receive no cancel frame.
    this.settlePending(pendingId);this.persist(run);return {accepted:true};
  }
  poll({runId,after=0}) {
    const run=this.get(runId);if(!Number.isSafeInteger(after)||after<0)throw new Error('Invalid event cursor');
    const file=path.join(this.runHome,runId+'.events.jsonl');
    const events=fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(e=>e.cursor>after).slice(0,200):[];
    const nextCursor=events.at(-1)?.cursor??after;
    return {status:run.status,events,nextCursor,hasMoreEvents:nextCursor<run.cursor,eventCursor:run.cursor,error:run.error,
      hostPid:this.runtime.pid,scope:'managed-run',foreignInput:Boolean(run.foreignInput),completion:run.status==='completed'?{requestId:run.requestId,turnReason:run.turnReason,turnSeq:run.turnSeq,quiescent:true}:undefined};
  }
  async cancel({runId,reason='cancelled'}) {
    const run=this.get(runId);
    if(done.has(run.status))return {status:run.status};
    if(!['cancelled','timed_out','failed'].includes(reason))throw new Error('Invalid native cancellation reason');
    run.stopReason=reason;this.persist(run);
    if(!run.promptSignature){run.status=reason;run.finishedAt=new Date().toISOString();this.persist(run);return {status:run.status};}
    const agent=this.ctx.agents.get(run.sessionId);
    if(!agent){run.status='interrupted';run.error='Managed Agent missing during cancellation';this.persist(run);return {status:run.status};}
    // Remove only this run's queued occurrence; native cancel intentionally keeps the rest of the inbox.
    for(const item of [...(agent.inbox.nextTurn||[]),...(agent.inbox.nextStep||[])])if(item.source?.rpcId===run.requestId){
      await this.ctx.sessionController.updateQueue({sessionId:run.sessionId,itemId:item.id,action:{kind:'remove'}});
    }
    this.ctx.sessionController.cancel({sessionId:run.sessionId});void this.checkFinish(run);return {status:run.status,cancellationRequested:true};
  }
  async release({runId}) {
    const run=this.get(runId);if(!done.has(run.status))throw new Error('Managed run is still active; release refused');
    await this.assertIdle(run.sessionId);
    if(this.active.get(run.sessionId)===run.runId)this.active.delete(run.sessionId);
    run.releasedAt=new Date().toISOString();this.persist(run);return {released:true,status:run.status,hostPid:this.runtime.pid,scope:'managed-run'};
  }
  async close() {
    this.closed=true;clearInterval(this.timer);
    for(const dispose of this.disposers)dispose();
    for(const run of this.runs.values())if(!done.has(run.status)){
      try{await this.cancel({runId:run.runId});}catch{}
      if(!done.has(run.status)){run.status='interrupted';run.error='Desktop plugin unloaded; native cancellation requested. Inspect the session; no replay.';this.persist(run);}
    }
  }
}

/** Authenticated loopback-only carrier for the fixed controller operations. */
export async function listenDesktop(controller,{token=crypto.randomBytes(32).toString('base64url')}={}) {
  const operations={'/v1/open':'open','/v1/prompt':'prompt','/v1/poll':'poll','/v1/respond':'respond','/v1/cancel':'cancel','/v1/release':'release','/v1/list-sessions':'listSessions','/v1/list-workspaces':'listWorkspaces','/v1/inspect-session':'inspectSession','/v1/adopt':'adopt'};
  let port;
  const server=http.createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if(req.headers.host!==`127.0.0.1:${port}`||req.headers.origin!==undefined||req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'Untrusted browser/Host request'});
    const supplied=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+token);
    if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))return send(401,{error:'Authentication required'});
    try{
      if(req.method==='GET'&&req.url==='/v1/health')return send(200,controller.health());
      const operation=operations[req.url];if(req.method!=='POST'||!operation)return send(404,{error:'Unknown operation'});
      let bytes=0,chunks=[];
      for await(const chunk of req){bytes+=chunk.length;if(bytes>1024*1024){send(413,{error:'Request exceeds 1 MiB'});req.destroy();return;}chunks.push(chunk);}
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Expected an object');
      send(200,await controller[operation](input));
    }catch(e){send(409,{error:redact(e.message||String(e)),...(e.code?{code:e.code}:{})});}
  });
  server.requestTimeout=35000;server.headersTimeout=10000;server.keepAliveTimeout=1000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});port=server.address().port;
  return {url:`http://127.0.0.1:${port}`,token,server,close:()=>new Promise(resolve=>server.close(resolve))};
}
