import { EventEmitter } from 'node:events';
import { readJson, redact, sleep } from './store.mjs';
import { assertDescriptor, assertHealth } from './protocol.mjs';
import path from 'node:path';

const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const openFields = ['runId', 'requestId', 'sessionId', 'resume', 'cwd', 'workspaceId', 'title', 'permission',
  'ownedPaths', 'provider', 'model', 'reasoningEffort', 'timeoutSeconds'];

export class DesktopRequestError extends Error {
  constructor(message, {status, code, outcomeUnknown = true, noEffects = false} = {}) {
    super(message); this.name='DesktopRequestError'; this.status=status; this.code=code;
    this.outcomeUnknown=outcomeUnknown; this.noEffects=noEffects;
  }
}
const preAdmissionRefusal = /busy or has queued input|pending native input|background activity|Existing session not found|Subagent sessions cannot|Restore an archived|Only read-only|requires ownedPaths|Owned paths must|Invalid permission|Native permission preset is unavailable|timeoutSeconds must|parallel limit reached|write ownership overlaps|explicit adoption|implicit reuse refused|already has an active supervised run/;

export class DesktopClient {
  constructor(home, { fetchImpl = fetch } = {}) {
    this.connection = readJson(path.join(home, 'desktop-connection.json'));
    this.fetch = fetchImpl;
    assertDescriptor(this.connection);
  }

  async call(route, body) {
    let response;
    try {
      response = await this.fetch(this.connection.url + '/v1/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + this.connection.token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new DesktopRequestError('Desktop connection failed; mutation outcome may be unknown. Do not replay.',{code:'DESKTOP_TRANSPORT_UNKNOWN'});
    }
    if (!response.ok) {
      const diagnostic = (await response.text()).split(this.connection.token).join('[REDACTED]');
      const status=response.status;
      const safe=redact(diagnostic).slice(0,2000);
      let detail;try{detail=JSON.parse(diagnostic);}catch{}
      const explicitCode=['DSH_SESSION_ARCHIVED','DSH_SESSION_NOT_FOUND','DSH_WORKSPACE_NOT_FOUND','DSH_WORKSPACE_MISMATCH'].includes(detail?.code)?detail.code:undefined;
      const rejected=status>=400&&status<500;
      // A 409 can follow partial native setup. Only explicit pre-admission refusals
      // prove no task ownership was acquired; transport rejection alone does not.
      const noEffects=rejected&&([401,403,404].includes(status)||Boolean(explicitCode)||preAdmissionRefusal.test(safe));
      throw new DesktopRequestError('Desktop request rejected: '+safe,{
        status,code:explicitCode||(rejected?'DESKTOP_HTTP_REJECTED':'DESKTOP_HTTP_UNKNOWN'),
        outcomeUnknown:!noEffects,noEffects,
      });
    }
    return response.json();
  }

  async health() {
    const health = assertHealth(await this.call('health'), {legacy: this.connection.legacyProtocol === true});
    if (health.instanceId !== this.connection.instanceId ||
        health.archiveSha256 !== this.connection.archiveSha256) {
      throw Error('Desktop instance or fingerprint changed');
    }
    return health;
  }
}

export class DesktopConnection extends EventEmitter {
  constructor(home, state) {
    super();
    this.client = new DesktopClient(home);
    this.state = state;
    this.cursor = 0;
    this.closed = false;
    this.failure = null;
  }

  async rpc(method, params) {
    if (method === 'initialize') {
      const health = await this.client.health();
      if (health.archiveSha256 !== this.state.runtimeConfig?.verifiedArchiveSha256) {
        throw Error('Desktop archive differs from pinned runtime');
      }
      try {
        this.opened = await this.client.call('open',
          Object.fromEntries(openFields.map(key => [key, this.state[key]])));
      } catch(error) {
        this.openRefused=error.noEffects===true;
        throw error;
      }
      if (this.opened.sessionId !== this.state.sessionId) {
        throw Error('Desktop returned a different session identity');
      }
      this.hostPid = this.opened.hostPid;
      this.workspaceId = this.opened.workspaceId;
      this.workspaceTitle = this.opened.workspaceTitle;
      return this.opened;
    }
    if (method === 'session/resume') return {};
    if (method === 'session/prompt') {
      const receipt = await this.client.call('prompt', {
        runId: this.state.runId, contentBlocks: params.contentBlocks,
      });
      this.startPolling();
      return receipt;
    }
    if (method === 'session/wait') {
      await this.pollPromise;
      if (this.failure) throw this.failure;
      const completion = this.final?.completion;
      if (this.final?.status === 'completed' && !(completion?.requestId === this.state.requestId &&
          completion?.turnReason?.kind === 'completed' && completion?.quiescent === true &&
          Number.isSafeInteger(completion?.turnSeq))) {
        throw Error('Native completion receipt missing or mismatched');
      }
      if (this.final?.status !== 'completed') {
        throw Error(this.final?.error || 'Desktop run ended: ' + this.final?.status);
      }
      return this.final;
    }
    throw Error('Unsupported Desktop operation');
  }

  startPolling() {
    if (!this.pollPromise) {
      this.pollPromise = this.poll();
      this.pollPromise.catch(() => {});
    }
  }

  async poll() {
    try {
      while (!this.closed) {
        const page = await this.client.call('poll', { runId: this.state.runId, after: this.cursor });
        for (const event of page.events || []) {
          if (event.cursor <= this.cursor) continue;
          this.emit(event.message.method && event.message.id !== undefined ? 'request' : 'notification', event.message);
          this.cursor = event.cursor;
        }
        this.cursor = Math.max(this.cursor, page.nextCursor || 0);
        if (terminal.has(page.status) && !page.hasMoreEvents) {
          this.final = page;
          return page;
        }
        if (!page.hasMoreEvents) await sleep(150);
      }
    } catch (error) {
      this.failure = error;
      throw error;
    }
  }

  async answer(id, response) {
    return this.client.call('respond', { runId: this.state.runId, pendingId: id, response });
  }

  async stop(reason) {
    if(this.openRefused)return {desktop:true,released:true,scope:'no-run-acquired',status:'failed'};
    try {
      if (!this.final) {
        await this.client.call('cancel', {
          runId: this.state.runId, reason: reason === 'timed_out' ? 'timed_out' : 'cancelled',
        });
        this.startPolling();
        for (let attempt = 0; attempt < 100 && !this.final; attempt++) {
          if (this.failure) throw this.failure;
          await sleep(100);
        }
        if (!this.final) throw Error('Desktop cancellation not confirmed');
      }
      const receipt = await this.client.call('release', { runId: this.state.runId });
      if (!receipt.released || receipt.scope !== 'managed-run') throw Error('Desktop release not confirmed');
      this.closed = true;
      return { desktop: true, status: this.final.status, scope: receipt.scope, hostPid: receipt.hostPid, released: true };
    } catch (error) {
      this.closed = true;
      this.failure = error;
      return { desktop: true, unconfirmed: true };
    }
  }
}
