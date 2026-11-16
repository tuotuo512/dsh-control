#!/usr/bin/env node
/**
 * Installer / maintenance entry for the dsh-control plugin suite.
 *
 *   node scripts/install.mjs plan       # read-only: what is installed, what would change
 *   node scripts/install.mjs apply      # deploy immutable snapshots and register both ends
 *   node scripts/install.mjs verify     # read-only: hashes, registrations, protocol
 *   node scripts/install.mjs uninstall  # remove this project's registrations, keep data
 *
 * Rules (docs/contract.md):
 * - never overwrite a file that changed since it was read;
 * - never treat a managed task as replaceable while it is live;
 * - never write secrets into the packages or the receipt;
 * - keep run history, reports and connection data on uninstall.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {config as runtimeConfig,inspectRuntime} from '../src/runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BEGIN = '# BEGIN dsh-control managed block';
const END = '# END dsh-control managed block';
const NATIVE_FILES = ['desktop-plugin.mjs', 'desktop-host.mjs', 'store.mjs', 'protocol.mjs', 'permissions.mjs'];

export const paths = (options = {}) => {
  const home = path.resolve(options.home || process.env.DSH_CONTROL_HOME || path.join(os.homedir(), '.codex', 'dsh-control-state'));
  // Refuse obviously dangerous targets before anything is written or removed.
  const relative = path.relative(path.parse(home).root, home);
  if (!relative || relative.split(path.sep).length < 2) throw new Error(`Refusing to manage an unsafe home: ${home}`);
  let initialized={};try{initialized=readJson(path.join(home,'config.json'));}catch{}
  const profile=options.profile||initialized.desktopProfile||'desktop';
  if(!/^[a-zA-Z0-9._-]+$/.test(profile)||profile==='.'||profile==='..')throw new Error('Invalid profile name');
  return {
    home,
    codexRoot: path.resolve(options.codexRoot || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
    dshHome: path.resolve(options.dshHome || process.env.DSH_HOME || initialized.dshHome || path.join(os.homedir(), '.dsh')),
    profile,
    dist: path.resolve(options.dist || path.join(root, 'dist')),
    node: options.node || process.execPath,
    codexCli: options.codexCli || null,
  };
};

/** Backups must survive a wiped home, so they live beside it, never inside it. */
export const backupsRoot = p => path.join(path.dirname(p.home), path.basename(p.home) + '-backups');

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const writeAtomic = (file, text) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, text, {mode: 0o600});
  fs.renameSync(tmp, file);
};
const digestOf = dir => {
  const hash = crypto.createHash('sha256');
  // Older receipts predate the optional permissions module. Their four-file
  // digests remain verifiable; removing it from a new snapshot still mismatches.
  for (const file of NATIVE_FILES) {
    if (file === 'permissions.mjs' && !fs.existsSync(path.join(dir, file))) continue;
    hash.update(fs.readFileSync(path.join(dir, file)));
  }
  return hash.digest('hex');
};

function manifest(p) {
  const file = path.join(p.dist, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`Missing build manifest: ${file}. Run node scripts/build.mjs first.`);
  return readJson(file);
}

function runtimeState(home) {
  try {
    const cfg = readJson(path.join(home, 'config.json'));
    return {configured: true, executable: cfg.executable, cliEntry: cfg.cliEntry, archive: cfg.archive, defaultBackend: cfg.defaultBackend, verifiedArchiveSha256: cfg.verifiedArchiveSha256};
  } catch (error) {
    return {configured: false, error: error.message};
  }
}

function liveRuns(home) {
  const runs = path.join(home, 'runs');
  if (!fs.existsSync(runs)) return [];
  const terminal = new Set(['attached', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);
  const out = [];
  for (const name of fs.readdirSync(runs)) {
    const file = path.join(runs, name, 'state.json');
    if (!fs.existsSync(file)) continue;
    try {
      const state = readJson(file);
      if (!terminal.has(state.status) || state.leaseHeld) out.push({runId: state.runId, status: state.status, leaseHeld: Boolean(state.leaseHeld), sessionId: state.sessionId});
    } catch { /* an unreadable run is not proof of idleness */ out.push({runId: name, status: 'unreadable'}); }
  }
  return out;
}

/** Extract a marker block, or a legacy `[mcp_servers.dsh-control]` table, without a TOML rewrite. */
export function readCodexRegistration(codexRoot) {
  const file = path.join(codexRoot, 'config.toml');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const managed = text.includes(BEGIN);
  const legacy = /(^|\r?\n)\[mcp_servers\.dsh-control\]\r?\n/.test(text) && !managed;
  return {file, exists: fs.existsSync(file), managed, legacy, text};
}

/** Replace only this project's block/section; refuse if the file changed under us. */
export function writeCodexMcp(codexRoot, {command, args, env, previous}) {
  const file = path.join(codexRoot, 'config.toml');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (previous !== undefined && current !== previous) throw new Error('Codex config changed during install; refusing to overwrite');
  let next;
  const environment=Object.entries(env||{}).map(([key,value])=>{if(!/^[A-Z_][A-Z0-9_]*$/.test(key)||typeof value!=='string')throw new Error('Invalid MCP environment entry');return `${key} = ${JSON.stringify(value)}`;});
  const block = [BEGIN, '[mcp_servers.dsh-control]', `command = ${JSON.stringify(command)}`, `args = [${args.map(a => JSON.stringify(a)).join(', ')}]`, ...(environment.length?['[mcp_servers.dsh-control.env]',...environment]:[]),END, ''].join('\n');
  if (current.includes(BEGIN)) {
    const start = current.indexOf(BEGIN);
    const stop = current.indexOf(END, start);
    if (stop < 0) throw new Error('Managed Codex block is unterminated; inspect config.toml');
    next = current.slice(0, start) + block + current.slice(stop + END.length + 1);
  } else if (/(^|\r?\n)\[mcp_servers\.dsh-control\]/.test(current)) {
    // Legacy section: drop the header and its key lines up to the next table header.
    const lines = current.split(/\r?\n/);
    const at = lines.findIndex(line => line.trim() === '[mcp_servers.dsh-control]');
    let end = at + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    next = [...lines.slice(0, at), ...block.split('\n'), ...lines.slice(end)].join('\n');
  } else {
    next = current.trim() ? current.replace(/\s*$/, '') + '\n\n' + block : block;
  }
  writeAtomic(file, next);
  const check = fs.readFileSync(file, 'utf8');
  if (!check.includes('[mcp_servers.dsh-control]')) throw new Error('Codex registration read-back failed');
  return file;
}

export function removeCodexMcp(codexRoot) {
  const file = path.join(codexRoot, 'config.toml');
  if (!fs.existsSync(file)) return {removed: false, reason: 'no config.toml'};
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(BEGIN);
  if (start < 0) {
    // Legacy section without markers: remove the header and its key lines only.
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex(line => line.trim() === '[mcp_servers.dsh-control]');
    if (at < 0) return {removed: false, reason: 'no managed block'};
    let end = at + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    writeAtomic(file, [...lines.slice(0, at), ...lines.slice(end)].join('\n'));
    return {removed: true, file, legacy: true};
  }
  const stop = text.indexOf(END, start);
  if (stop < 0) throw new Error('Managed Codex block is unterminated; inspect config.toml');
  writeAtomic(file, text.slice(0, start) + text.slice(stop + END.length + 1));
  return {removed: true, file};
}

/** DSH profile patch: one owned block, never a full-profile rewrite. */
export function readProfileBlock(dshHome, profile) {
  const file = path.join(dshHome, 'profiles', profile, 'cordis.patch.yml');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return {file, exists: fs.existsSync(file), text, managed: text.includes('# BEGIN dsh-control'), legacy: /file:\/\/\/.*desktop-plugin\.mjs/.test(text)};
}

export function writeProfileBlock(dshHome, profile, {home, snapshot, registered,previous}) {
  const file = path.join(dshHome, 'profiles', profile, 'cordis.patch.yml');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if(previous!==undefined&&before!==previous)throw new Error('DSH profile changed during install; refusing to overwrite');
  const quote = value => JSON.stringify(value);
  const row = registered
    ? ['- id: dsh-control-bridge', '  name: dsh-control-bridge', '  config:', `    home: ${quote(home)}`, `    snapshot: ${quote(snapshot)}`, `    revision: ${quote(path.basename(snapshot))}`]
    : ['- insert:', '    - id: dsh-control-bridge-' + path.basename(snapshot).slice(0, 12), `      name: ${quote(pathToFileURL(path.join(snapshot, 'desktop-plugin.mjs')).href)}`, '      config:', `        home: ${quote(home)}`, `        snapshot: ${quote(snapshot)}`, `        revision: ${quote(path.basename(snapshot))}`];
  const block = ['# BEGIN dsh-control native bridge', ...row, '# END dsh-control native bridge', ''].join('\n');
  const start = before.indexOf('# BEGIN dsh-control native bridge');
  const stop = before.indexOf('# END dsh-control native bridge', start);
  let next;
  if (start >= 0 && stop >= 0) next = before.slice(0, start) + block + before.slice(stop + '# END dsh-control native bridge\n'.length);
  else if (start >= 0) throw new Error('Managed DSH block is unterminated; inspect the profile patch');
  else if (before.includes('dsh-control-desktop-bridge')) throw new Error('Existing unmanaged dsh-control entry requires manual review');
  // A freshly initialized profile patch is the empty document `[]`; a second YAML
  // root would be invalid, so replace the empty document instead of appending.
  else if (before.replace(/#[^\n]*/g, '').trim() === '[]') next = block;
  else next = before.replace(/\s*$/, '') + '\n\n' + block;
  writeAtomic(file, next);
  const check = fs.readFileSync(file, 'utf8');
  if (!check.includes('# END dsh-control native bridge')) throw new Error('DSH profile registration read-back failed');
  return {file, registered,afterSha256:sha256(file)};
}

/** Roll back only a postimage this installation still owns, never another writer's update. */
export function restoreRegistration(before,afterSha256){
  const exists=fs.existsSync(before.file),current=exists?fs.readFileSync(before.file,'utf8'):undefined;
  if((before.exists&&current===before.text)||(!before.exists&&!exists))return true;
  if(!exists||!afterSha256||sha256(before.file)!==afterSha256)return false;
  if(before.exists)writeAtomic(before.file,before.text);else fs.unlinkSync(before.file);
  return true;
}

export function removeProfileBlock(dshHome, profile) {
  const file = path.join(dshHome, 'profiles', profile, 'cordis.patch.yml');
  if (!fs.existsSync(file)) return {removed: false, reason: 'no profile patch'};
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf('# BEGIN dsh-control native bridge');
  if (start < 0) return {removed: false, reason: 'no managed block'};
  const stop = text.indexOf('# END dsh-control native bridge', start);
  if (stop < 0) throw new Error('Managed DSH block is unterminated');
  const rest = text.slice(0, start) + text.slice(stop + '# END dsh-control native bridge\n'.length);
  writeAtomic(file, rest.replace(/#[^\n]*/g, '').trim() ? rest : '[]\n');
  return {removed: true, file};
}

export function bundleRegistered(dshHome, profile) {
  const manifestFile = path.join(dshHome, 'profiles', profile, 'package.json');
  if (!fs.existsSync(manifestFile)) return false;
  const pkg = readJson(manifestFile);
  return (pkg.dsh?.profile?.bundles || []).includes('dsh-control-bridge');
}

function deployDir(source, target, files) {
  fs.mkdirSync(target, {recursive: true});
  for (const file of files) {
    const to = path.join(target, file);
    if (fs.existsSync(to)) {
      if (sha256(to) !== sha256(path.join(source, file))) throw new Error(`Immutable deployment changed: ${to}`);
    } else {
      fs.mkdirSync(path.dirname(to), {recursive: true});
      fs.copyFileSync(path.join(source, file), to);
    }
  }
  return target;
}

function deployServer(p, built, revision) {
  const source = path.join(p.dist, 'codex-plugin', 'server');
  const target = path.join(p.home, 'codex-server', revision);
  if (!fs.existsSync(source)) throw new Error('Build output missing codex-plugin/server');
  const entry = path.join(source, 'mcp.mjs');
  if (fs.existsSync(path.join(target, 'mcp.mjs'))) {
    if (sha256(entry) !== sha256(path.join(target, 'mcp.mjs'))) throw new Error(`Immutable server deployment changed: ${target}`);
    verifyServerSnapshot(target, built); return target;
  }
  fs.mkdirSync(path.join(target, 'node_modules'), {recursive: true});
  for (const item of fs.readdirSync(source, {withFileTypes: true})) {
    const from = path.join(source, item.name);
    const to = path.join(target, item.name);
    if (item.isDirectory()) fs.cpSync(from, to, {recursive: true, force: true, errorOnExist: false});
    else fs.copyFileSync(from, to);
  }
  if (!fs.existsSync(path.join(target, 'mcp.mjs'))) throw new Error('Deployed server is missing mcp.mjs');
  verifyServerSnapshot(target, built);
  return target;
}

function verifyServerSnapshot(serverDir, built) {
  for (const entry of built.packages.codex.files ?? []) {
    if (!entry.path.startsWith('server/')) continue;
    const relative=entry.path.slice(7), target=path.resolve(serverDir,relative), rel=path.relative(serverDir,target);
    if (!rel || rel==='..' || rel.startsWith('..'+path.sep) || path.isAbsolute(rel)) throw new Error('Invalid server manifest path');
    if (!fs.existsSync(target) || sha256(target)!==entry.sha256) throw new Error(`Server snapshot digest mismatch: ${relative}`);
  }
}

function deployNative(p, revision) {
  const source = path.join(root, 'src');
  const target = path.join(p.home, 'native-plugin', revision);
  deployDir(source, target, NATIVE_FILES);
  if (digestOf(target) !== revision) throw new Error('Native snapshot digest mismatch after deployment');
  return target;
}

function skillSource() {
  return path.join(root, 'skill');
}

function installSkill(p, mode) {
  const target = path.join(p.codexRoot, 'skills', 'dsh-control');
  const backup = path.join(backupsRoot(p), 'skill-' + new Date().toISOString().replace(/[:.]/g, '-'));
  if (mode === 'plugin') {
    if (fs.existsSync(target)) {
      fs.mkdirSync(backup, {recursive: true});
      fs.cpSync(target, path.join(backup, 'dsh-control'), {recursive: true});
      fs.rmSync(target, {recursive: true, force: true});
      return {removedStandalone: true, backup};
    }
    return {removedStandalone: false};
  }
  fs.cpSync(skillSource(), target, {recursive: true, force: true});
  return {installedStandalone: true, target};
}

function codexPluginCli(p) {
  if (p.codexCli) return p.codexCli;
  const fromPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .map(dir => path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex'))
    .find(file => fs.existsSync(file));
  if (fromPath) return fromPath;
  const candidate = path.join(process.env.ProgramFiles||'C:\\Program Files','WindowsApps');
  try {
    const dirs = fs.readdirSync(candidate).filter(name => name.startsWith('OpenAI.Codex_')).sort().reverse();
    for (const dir of dirs) {
      const exe = path.join(candidate, dir, 'app', 'resources', 'codex.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* WindowsApps directory listing is ACL-restricted; pass --codex-cli */ }
  return null;
}

function run(cli, args, env) {
  return execFileSync(cli, args, {encoding: 'utf8', env: {...process.env, ...env}});
}

export function installCodexPlugin(p, built) {
  const cli = codexPluginCli(p);
  if (!cli) throw new Error('codex CLI not found; pass --codex-cli <path> or use --codex-mode config');
  fs.mkdirSync(p.codexRoot, {recursive: true});
  const marketplace = path.join(p.home, 'install', 'codex-marketplace');
  fs.rmSync(marketplace, {recursive: true, force: true});
  fs.mkdirSync(path.join(marketplace, '.agents', 'plugins'), {recursive: true});
  fs.cpSync(path.join(p.dist, 'codex-plugin'), path.join(marketplace, 'plugins', 'dsh-control'), {recursive: true});
  const pluginDir = path.join(marketplace, 'plugins', 'dsh-control');
  const serverEntry = path.join(p.home, 'codex-server', built.packages.codex.digest.slice(0, 16), 'mcp.mjs');
  // Deliberate: no `mcpServers` in the plugin manifest. Codex merges plugin-provided
  // MCP servers only through its own app synchronization; `codex mcp list` on
  // codex-cli 0.169.0-alpha.11.1 reads config.toml and showed nothing for a freshly
  // added plugin. config.toml is therefore the single, deterministic registration and
  // the plugin must not declare a second server (that would run two bridges).
  writeAtomic(path.join(marketplace, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
    name: 'dsh-control-local',
    interface: {displayName: 'DSH Control Local'},
    plugins: [{name: 'dsh-control', source: {source: 'local', path: './plugins/dsh-control'}, policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category: 'Developer Tools'}],
  }, null, 2) + '\n');
  const env = {CODEX_HOME: p.codexRoot};
  run(cli, ['plugin', 'marketplace', 'add', marketplace], env);
  // `codex plugin add` does not replace an already installed version; remove first.
  const cacheRoot = path.join(p.codexRoot, 'plugins', 'cache', 'dsh-control-local', 'dsh-control');
  const installed = fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot) : [];
  if (installed.length && !installed.includes(built.packages.codex.version)) {
    try { run(cli, ['plugin', 'remove', 'dsh-control@dsh-control-local'], env); } catch { /* nothing installed under this id */ }
  }
  const added = JSON.parse(run(cli, ['plugin', 'add', 'dsh-control@dsh-control-local', '--json'], env));
  return {cli, marketplace, pluginId: added.pluginId, installedPath: added.installedPath, serverEntry};
}

export function removeCodexPlugin(p) {
  const cli = codexPluginCli(p);
  if (!cli) return {removed: false, reason: 'codex CLI not found'};
  try {
    run(cli, ['plugin', 'remove', 'dsh-control@dsh-control-local'], {CODEX_HOME: p.codexRoot});
    run(cli, ['plugin', 'marketplace', 'remove', 'dsh-control-local'], {CODEX_HOME: p.codexRoot});
    return {removed: true};
  } catch (error) {
    return {removed: false, reason: String(error.message || error).slice(0, 500)};
  }
}

export function plan(options = {}) {
  const p = paths(options);
  const built = manifest(p);
  const runtime = runtimeState(p.home);
  const busy = liveRuns(p.home);
  const codex = readCodexRegistration(p.codexRoot);
  const profile = readProfileBlock(p.dshHome, p.profile);
  const registered = bundleRegistered(p.dshHome, p.profile);
  return {
    paths: p,
    built: {version: built.version, protocolVersion: built.protocolVersion, dshDigest: built.packages.dsh.digest, codexDigest: built.packages.codex.digest},
    runtime,
    busy,
    codex: {file: codex.file, managed: codex.managed, legacy: codex.legacy, mode: codexPluginCli(p) ? 'plugin' : 'config'},
    dsh: {file: profile.file, managed: profile.managed, legacy: profile.legacy, bundleRegistered: registered},
    action: busy.length ? 'refused-busy' : runtime.configured?'ready':'needs-setup',
  };
}

export function apply(options = {}) {
  const p = paths(options);
  const built = manifest(p);
  const busy = liveRuns(p.home);
  if (busy.length) throw new Error(`Managed runs are still live (${busy.map(r => r.runId + ':' + r.status).join(', ')}); finish or hand them off before replacing execution code`);
  const configured=runtimeConfig(p.home),runtime=inspectRuntime(configured);
  if(!runtime.compatible)throw new Error(runtime.warning);
  const mode = options.codexMode || (codexPluginCli(p) ? 'plugin' : 'config');
  if (!['plugin', 'config'].includes(mode)) throw new Error("codexMode must be 'plugin' or 'config'");

  const nativeDigest = digestOf(path.join(root, 'src'));
  const beforeProfile = readProfileBlock(p.dshHome, p.profile);
  const beforeCodex = readCodexRegistration(p.codexRoot);
  const nativeSnapshot = deployNative(p, nativeDigest);
  const serverDir = deployServer(p, built, built.packages.codex.digest.slice(0, 16));
  const registered = bundleRegistered(p.dshHome, p.profile);
  let codex, skill, profileWritten, pluginInstalled = false,codexWrittenHash;
  try {
    profileWritten = writeProfileBlock(p.dshHome, p.profile, {home: p.home, snapshot: nativeSnapshot, registered,previous:beforeProfile.text});
    if (mode === 'plugin') {
      const installed = installCodexPlugin(p, built);
      pluginInstalled = true;
      // The plugin carries skills/interface; config.toml carries the single MCP entry.
      // `codex plugin add` itself writes marketplace/plugins entries, so re-read before
      // touching the file to keep the compare-and-swap honest.
      const serverEntry = path.join(serverDir, 'mcp.mjs');
      const file = writeCodexMcp(p.codexRoot, {command: p.node, args: [serverEntry], env:{DSH_CONTROL_HOME:p.home},previous: readCodexRegistration(p.codexRoot).text});
      codex = {mode, ...installed, file, serverEntry};
    } else {
      const serverEntry = path.join(serverDir, 'mcp.mjs');
      const file = writeCodexMcp(p.codexRoot, {command: p.node, args: [serverEntry], env:{DSH_CONTROL_HOME:p.home},previous: beforeCodex.text});
      codex = {mode, file, serverEntry};
    }
    codexWrittenHash=sha256(beforeCodex.file);skill = installSkill(p, mode);
  } catch (error) {
    // Explicit rollback of this project's own writes only; never touch other content.
    try { if (pluginInstalled) removeCodexPlugin(p); } catch { /* best effort */ }
    const profileRestored=restoreRegistration(beforeProfile,profileWritten?.afterSha256);
    const codexRestored=restoreRegistration(beforeCodex,codexWrittenHash);
    throw new Error(`Install failed; unchanged owned registrations were restored, concurrent changes were preserved (${profileRestored&&codexRestored?'rollback complete':'inspect preserved registrations'}): ${error.message}`);
  }

  const receipt = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    protocolVersion: built.protocolVersion,
    packageVersion: built.version,
    nativeSnapshot,
    nativeRevision: nativeDigest,
    serverDir,
    serverDigest: built.packages.codex.digest,
    codex,
    dsh: {profile: p.profile, file: profileWritten.file, bundleRegistered: registered, blockMode: registered ? 'bundle' : 'file-url'},
    skill,
  };
  const receiptFile = path.join(p.home, 'install', `receipt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeAtomic(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
  return {receipt, receiptFile};
}

/** Prepare immutable candidates while existing tasks keep their original code. */
export function stage(options = {}) {
  const p = paths(options), built = manifest(p);
  const runtime = inspectRuntime(runtimeConfig(p.home));
  if (!runtime.compatible) throw new Error(runtime.warning);
  const nativeRevision = digestOf(path.join(root, 'src'));
  const nativeSnapshot = deployNative(p, nativeRevision);
  const serverDir = deployServer(p, built, built.packages.codex.digest.slice(0, 16));
  // Hash every published server file, including dependencies; an entry file alone
  // is insufficient evidence that a staged candidate is ready to activate.
  verifyServerSnapshot(serverDir, built);
  const candidate = {at:new Date().toISOString(), activated:false, packageVersion:built.version, nativeRevision, nativeSnapshot, serverDir, busy:liveRuns(p.home), next:'apply after managed runs release their leases'};
  const file = path.join(p.home, 'install', 'staged-' + built.packages.codex.digest.slice(0,16) + '.json');
  writeAtomic(file, JSON.stringify(candidate,null,2) + '\n');
  return {...candidate, candidateFile:file};
}

export function uninstall(options = {}) {
  const p = paths(options);
  const busy = liveRuns(p.home);
  if (busy.length) throw new Error(`Refusing to uninstall while managed runs are live: ${busy.map(r => r.runId).join(', ')}`);
  const profile = removeProfileBlock(p.dshHome, p.profile);
  const codexConfig = removeCodexMcp(p.codexRoot);
  const plugin = removeCodexPlugin(p);
  const skillDir = path.join(p.codexRoot, 'skills', 'dsh-control');
  const skill = {removed: false};
  if (fs.existsSync(skillDir) && fs.existsSync(path.join(p.home, 'install'))) {
    fs.rmSync(skillDir, {recursive: true, force: true});
    skill.removed = true;
  }
  return {profile, codexConfig, plugin, skill, keptData: [p.home]};
}

function main(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;
    const equal=arg.indexOf('=');const key=arg.slice(2,equal<0?undefined:equal),inline=equal<0?undefined:arg.slice(equal+1);
    const value = inline ?? rest[++i];
    const map = {home: 'home', 'codex-root': 'codexRoot', 'dsh-home': 'dshHome', profile: 'profile', dist: 'dist', node: 'node', 'codex-cli': 'codexCli', 'codex-mode': 'codexMode'};
    if (!map[key]) throw new Error(`Unknown option --${key}`);
    options[map[key]] = value;
  }
  if (command === 'plan') return plan(options);
  if (command === 'apply') return apply(options);
  if (command === 'stage') return stage(options);
  if (command === 'uninstall') return uninstall(options);
  if (command === 'verify') return verify(options);
  throw new Error(`Unknown command: ${command}`);
}

export function verify(options = {}) {
  const p = paths(options);
  const built = manifest(p);
  const receiptFile = fs.existsSync(path.join(p.home, 'install'))
    ? fs.readdirSync(path.join(p.home, 'install')).filter(name => /^receipt-.*\.json$/.test(name)).sort().at(-1) : null;
  const receipt = receiptFile ? readJson(path.join(p.home, 'install', receiptFile)) : null;
  const checks = [];
  const check = (name, ok, detail) => checks.push({name, ok: Boolean(ok), detail});
  check('build-manifest', true, `${built.version}/protocol ${built.protocolVersion}`);
  if (!receipt) check('install-receipt', false, 'no receipt; run apply');
  else {
    const snapshotOk = fs.existsSync(receipt.nativeSnapshot) && digestOf(receipt.nativeSnapshot) === receipt.nativeRevision;
    check('native-snapshot-digest', snapshotOk, receipt.nativeSnapshot);
    check('server-entry', fs.existsSync(path.join(receipt.serverDir, 'mcp.mjs')), receipt.serverDir);
    try {
      execFileSync(p.node, ['--input-type=module', '-e',
        `await import(${JSON.stringify(pathToFileURL(path.join(receipt.serverDir, 'mcp.mjs')).href)}); await import(${JSON.stringify(pathToFileURL(path.join(receipt.serverDir, 'worker.mjs')).href)});`],
      {windowsHide: true, timeout: 10000, stdio: 'pipe',env:{...process.env,DSH_CONTROL_HOME:p.home}});
      check('server-module-load', true, 'MCP and Worker dependency graphs load without starting a model');
    } catch {
      check('server-module-load', false, 'Deployed MCP/Worker modules cannot load; inspect missing or invalid dependencies before dispatch');
    }
    const codex = readCodexRegistration(p.codexRoot);
    check('codex-config-entry', codex.managed, codex.file);
    check('codex-state-home',codex.text.includes('DSH_CONTROL_HOME = '+JSON.stringify(p.home)),'MCP registration owns its state directory');
    check('installed-package-version',receipt.packageVersion===built.version,`${receipt.packageVersion} / ${built.version}`);
    if (receipt.codex.mode === 'plugin') {
      check('codex-plugin-installed', fs.existsSync(path.join(p.codexRoot, 'plugins', 'cache', 'dsh-control-local', 'dsh-control', built.version)), 'plugin cache');
    }
    const profile = readProfileBlock(p.dshHome, p.profile);
    check('dsh-profile-block', profile.managed, profile.file);
  }
  return {ok: checks.every(c => c.ok), checks, paths: p};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = main(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({error: String(error.message || error)}) + '\n');
    process.exitCode = 1;
  }
}
