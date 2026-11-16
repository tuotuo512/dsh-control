/**
 * DSH bundle entry for the dsh-control native bridge.
 *
 * The bundle is deliberately a thin, dependency-free registration layer:
 * `dsh plugin add` owns the profile dependency and the bundle list, while this
 * module owns nothing except resolving and loading the digest-pinned execution
 * snapshot produced by `scripts/install.mjs`.
 *
 * Why not compile desktop-plugin.mjs into this package: the native bridge must be
 * replaceable without restarting the Desktop Host, and a package installed through
 * pnpm keeps a stable module identity. Loading an immutable snapshot keeps the
 * "one entry per deployment digest" contract from docs/contract.md while still
 * letting DSH's own plugin manager register the bundle.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const name = 'dsh-control-desktop-bridge';

/** Must stay identical to the execution snapshot's inject list; checked below. */
export const inject = [
  'sessionController',
  'workspaceRegistry',
  'permissionPresets',
  'connection',
  'typertGateway',
  'agents',
  'sessions',
  'sessionPersistence',
  'sessionProjections',
  'llm',
];

const SNAPSHOT_FILES = ['desktop-plugin.mjs', 'desktop-host.mjs', 'store.mjs', 'protocol.mjs'];

export function resolveHome(options = {}) {
  const home = options.home || process.env.DSH_CONTROL_HOME || path.join(os.homedir(), '.codex', 'dsh-control-state');
  if (!path.isAbsolute(home)) throw new Error('DSH control home must be absolute');
  return home;
}

function digestOf(dir) {
  const hash = crypto.createHash('sha256');
  for (const file of SNAPSHOT_FILES) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) throw new Error(`Native bridge snapshot is missing ${file}: ${dir}`);
    hash.update(fs.readFileSync(full));
  }
  return hash.digest('hex');
}

/**
 * Snapshot selection is explicit by default. Without an explicit snapshot the
 * newest digest directory is used, but only after its content re-hashes to the
 * directory name; a mismatching directory is never loaded.
 */
export function resolveSnapshot(home, requested) {
  if (requested) {
    const dir = path.resolve(requested);
    if (!path.isAbsolute(requested)) throw new Error('snapshot must be absolute');
    if (path.basename(dir) !== digestOf(dir)) throw new Error(`Snapshot content changed: ${dir}`);
    return dir;
  }
  const root = path.join(home, 'native-plugin');
  if (!fs.existsSync(root)) throw new Error(`No native bridge deployment under ${root}; run the installer`);
  const candidates = fs.readdirSync(root, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map(entry => ({name: entry.name, at: fs.statSync(path.join(root, entry.name)).mtimeMs}))
    .sort((a, b) => b.at - a.at);
  for (const candidate of candidates) {
    const dir = path.join(root, candidate.name);
    if (digestOf(dir) === candidate.name) return dir;
  }
  throw new Error(`No digest-verified native bridge snapshot under ${root}`);
}

export async function apply(ctx, options = {}) {
  const home = resolveHome(options);
  const snapshot = resolveSnapshot(home, options.snapshot);
  const impl = await import(pathToFileURL(path.join(snapshot, 'desktop-plugin.mjs')).href);
  if (JSON.stringify(impl.inject) !== JSON.stringify(inject)) {
    throw new Error('Native bridge snapshot declares a different service injection set; rebuild and reinstall both sides');
  }
  if (options.revision && options.revision !== path.basename(snapshot)) {
    throw new Error(`Configured revision ${options.revision} does not match loaded snapshot ${path.basename(snapshot)}`);
  }
  return impl.apply(ctx, {...options, home, snapshot});
}
