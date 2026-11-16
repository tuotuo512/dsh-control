import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const readJson = rel => JSON.parse(read(rel));

const NATIVE_FILES = ['desktop-plugin.mjs', 'desktop-host.mjs', 'store.mjs', 'protocol.mjs'];
const digestOf = dir => {
  const hash = crypto.createHash('sha256');
  for (const file of NATIVE_FILES) hash.update(fs.readFileSync(path.join(dir, file)));
  return hash.digest('hex');
};

test('bundle manifest declares an installable DSH layer', () => {
  const pkg = readJson('packages/dsh-plugin/package.json');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(pkg.files.includes('cordis.patch.yml'));
  assert.ok(pkg.files.includes('index.js'));
  assert.match(pkg.engines.dsh, /^>=0\.2\.0/);
  const patch = read('packages/dsh-plugin/cordis.patch.yml');
  assert.match(patch, /- insert:/);
  assert.match(patch, new RegExp(`name: ${pkg.name}`));
  assert.match(patch, /id: dsh-control-bridge/);
});

test('bundle loader injects exactly the services the execution snapshot needs', () => {
  const list = source => JSON.parse(source.match(/export const inject\s*=\s*(\[[\s\S]*?\])/)[1].replace(/'/g, '"').replace(/,(\s*\])/g, '$1'));
  const loader = list(read('packages/dsh-plugin/index.js'));
  const snapshot = list(read('src/desktop-plugin.mjs'));
  assert.deepEqual(loader, snapshot);
  assert.ok(loader.includes('sessionController') && loader.includes('connection'));
});

test('loader resolves only a digest-verified snapshot', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-loader-'));
  try {
    const dir = path.join(home, 'native-plugin', 'x');
    fs.mkdirSync(dir, {recursive: true});
    for (const file of NATIVE_FILES) fs.copyFileSync(path.join(root, 'src', file), path.join(dir, file));
    const digest = digestOf(dir);
    const target = path.join(home, 'native-plugin', digest);
    fs.renameSync(dir, target);
    const {resolveSnapshot, resolveHome} = await import('../packages/dsh-plugin/index.js');
    assert.equal(resolveSnapshot(home), target);
    assert.equal(resolveHome({home}), home);
    // A tampered snapshot is refused instead of being loaded.
    fs.appendFileSync(path.join(target, 'store.mjs'), '\n// tampered\n');
    assert.throws(() => resolveSnapshot(home), /No digest-verified|changed/);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('protocol rejects a mismatched plugin version and marks legacy descriptors explicitly', async () => {
  const {assertDescriptor, assertHealth, PROTOCOL_VERSION, LEGACY_PROTOCOL} = await import('../src/protocol.mjs');
  const base = {schemaVersion: 1, protocolVersion: PROTOCOL_VERSION, url: 'http://127.0.0.1:4100', token: 't'};
  assert.equal(assertDescriptor(base), base);
  // A pre-0.3.0 descriptor is accepted only as a labelled legacy deployment.
  const legacy = assertDescriptor({...base, protocolVersion: undefined});
  assert.equal(legacy.legacyProtocol, true);
  assert.throws(() => assertDescriptor({...base, protocolVersion: 99}), /does not match/);
  assert.throws(() => assertDescriptor({...base, url: 'http://10.0.0.1:4100'}), /Invalid/);
  assert.throws(() => assertHealth({protocolVersion: undefined}), /requires/);
  const health = assertHealth({protocolVersion: undefined, instanceId: 'i'}, {legacy: true});
  assert.equal(health.protocolVersion, LEGACY_PROTOCOL);
  assert.equal(health.legacyProtocol, true);
  assert.equal(assertHealth({protocolVersion: PROTOCOL_VERSION}).protocolVersion, PROTOCOL_VERSION);
});

test('Codex plugin manifests stay versioned, skill-scoped and path-free', () => {
  const plugin = readJson('packages/codex-plugin/.codex-plugin/plugin.json');
  const marketplacePlugin = readJson('packages/codex-plugin/plugin.json');
  assert.equal(plugin.name, 'dsh-control');
  assert.equal(plugin.skills, './skills/');
  assert.equal(plugin.version, marketplacePlugin.version);
  assert.ok(plugin.interface?.displayName);
  // A shipped package must not embed this machine or a checkout path.
  for (const file of ['packages/codex-plugin/plugin.json', 'packages/codex-plugin/.codex-plugin/plugin.json', 'packages/codex-plugin/mcp.template.json']) {
    const text = read(file);
    assert.ok(!/["'](?:[a-z]:[\\/]|\/(?:Users|home)\/)/i.test(text), `${file} leaks an absolute local path`);
    assert.ok(!/sk-[a-zA-Z0-9]/.test(text), `${file} looks like it contains a secret`);
  }
});

test('skill links a packaged API reference covering every registered operation',async()=>{
  const skill=read('skill/SKILL.md');assert.ok(skill.includes('references/operations.md'));
  const reference=read('skill/references/operations.md'),{schemas}=await import('../src/mcp.mjs');
  for(const operation of Object.keys(schemas))assert.ok(reference.includes(operation),`API reference omits ${operation}`);
});
