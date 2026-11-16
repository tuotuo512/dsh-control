import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {readJson, sleep, redact} from './store.mjs';

export function readArchive(archive) {
  const bytes = fs.readFileSync(archive);
  const tree = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)).toString());
  const base = bytes.readUInt32LE(4) + 8;
  return {sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    read(p) { let item = tree; for (const part of p.split('/')) item = item.files?.[part];
      if (!item || !Number.isFinite(item.size)) throw new Error(`Installed archive entry missing: ${p}`);
      return bytes.subarray(base + Number(item.offset), base + Number(item.offset) + item.size).toString(); }};
}
export function config(home) {
  const cfg = readJson(path.join(home, 'config.json'));
  if (cfg.defaultBackend!==undefined&&!['sdk','desktop','acp'].includes(cfg.defaultBackend))throw Error('Invalid defaultBackend');
  if (cfg.schemaVersion !== 1) throw new Error('Unsupported local control config schema');
  if (!Number.isInteger(cfg.maxParallel) || cfg.maxParallel < 1 || cfg.maxParallel > 8) throw new Error('maxParallel must be 1..8');
  for (const key of ['executable', 'archive', 'cliEntry', 'verifiedArchiveSha256', 'provider', 'model']) {
    if (typeof cfg[key] !== 'string' || !cfg[key]) throw new Error(`Missing config field: ${key}`);
  }
  return cfg;
}
export function inspectRuntime(cfg) {
  if (!fs.existsSync(cfg.executable) || !fs.existsSync(cfg.archive)) throw new Error('Configured installed DSH runtime is missing');
  const ar = readArchive(cfg.archive); const pkg = JSON.parse(ar.read('package.json'));
  const protocol = JSON.parse(ar.read('dsh/node_modules/@deepseek-ai/dsh-sdk-protocol/package.json'));
  const compatible = ar.sha256 === cfg.verifiedArchiveSha256;
  return {compatible, version: pkg.version, buildCommit: pkg.dshBuildCommit, archiveSha256: ar.sha256,
    executable: cfg.executable, archive: cfg.archive, cliEntry: cfg.cliEntry, protocolPackageVersion: protocol.version,
    provider: cfg.provider, model: cfg.model, reasoningEffort: cfg.reasoningEffort,
    warning: compatible ? undefined : 'Installed DSH changed. Verify its SDK contract before updating the pinned fingerprint.'};
}
export class SdkConnection extends EventEmitter {
  constructor(child) {
    super(); this.child = child; this.seq = 0; this.pending = new Map(); this.buffer = ''; this.stderr = ''; this.exited = false;
    this.exit = new Promise(resolve => {
      child.once('error', e => { this.failure = e; this.rejectAll(e); this.emit('failure', e); });
      child.once('close', (code, signal) => { this.exited = true; this.exitCode = code; this.rejectAll(new Error(`DSH runtime closed (${code}, ${signal})`)); resolve({code, signal}); });
    });
    child.stdin.on('error', e => { this.failure = e; this.rejectAll(e); });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { this.stderr = redact((this.stderr + data.toString()).slice(-8192)); });
    child.stdout.on('data', data => {
      this.buffer += data.toString();
      if (this.buffer.length > 32 * 1024 * 1024) { this.failure = new Error('SDK frame exceeds 32 MiB'); this.rejectAll(this.failure); child.kill(); return; }
      let i; while ((i = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { this.failure = new Error('Non-JSON SDK stdout; incompatible runtime'); this.rejectAll(this.failure); child.kill(); return; }
        if (msg.id !== undefined && msg.method) this.emit('request', msg);
        else if (msg.id !== undefined) {
          const waiter = this.pending.get(msg.id); if (!waiter) continue; this.pending.delete(msg.id);
          msg.error ? waiter.reject(new Error(redact(JSON.stringify(msg.error)))) : waiter.resolve(msg.result);
        } else this.emit('notification', msg);
      }
    });
  }
  rejectAll(error) { for (const waiter of this.pending.values()) waiter.reject(error); this.pending.clear(); }
  rpc(method, params) {
    if (this.exited || this.failure) return Promise.reject(this.failure || new Error('Runtime exited'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq; this.pending.set(id, {resolve, reject});
      this.child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, ...(params === undefined ? {} : {params})}) + '\n');
    });
  }
  answer(id, result) { if (this.exited) throw new Error('Runtime exited'); this.child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, result}) + '\n'); }
  async stop() {
    if (!this.exited) {
      await Promise.race([this.rpc('shutdown').catch(() => {}), sleep(5000)]);
      this.child.stdin.end();
      await Promise.race([this.exit, sleep(3000)]);
      if (!this.exited) { this.forcedTermination = true; this.child.kill(); }
    }
    return await Promise.race([this.exit, sleep(5000).then(() => ({code: null, unconfirmed: true}))]);
  }
}
export function openRuntime(cfg, run, patchPath) {
  return new SdkConnection(spawn(cfg.executable, ['--expose-internals', cfg.cliEntry, '--profile', 'sdk', '--patch', patchPath], {
    cwd: run.cwd, env: {...process.env, ...(cfg.dshHome?{DSH_HOME:cfg.dshHome}:{}),ELECTRON_RUN_AS_NODE: '1'}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }));
}
