#!/usr/bin/env node
/**
 * Build the two installable artifacts:
 *   dist/dsh-plugin/            DSH bundle (registered with `dsh plugin add`)
 *   dist/codex-plugin/          Codex plugin template (skills + self-contained MCP server)
 *   dist/manifest.json          versions, per-file SHA-256 and artifact digests
 *
 * Deterministic input only: repository sources and the installed Node dependencies.
 * Never copies state, credentials or reports.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const SERVER_FILES = ['mcp.mjs', 'controller.mjs', 'cli.mjs', 'worker.mjs', 'store.mjs', 'runtime.mjs', 'desktop-client.mjs', 'acp-client.mjs', 'protocol.mjs', 'bindings.mjs'];

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const mkdir = dir => fs.mkdirSync(dir, {recursive: true});

function copyFile(from, to) {
  mkdir(path.dirname(to));
  fs.copyFileSync(from, to);
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function files(dir) {
  return walk(dir).map(rel => {
    const full = path.join(dir, ...rel.split('/'));
    return {path: rel, bytes: fs.statSync(full).size, sha256: sha256(full)};
  });
}

function digestOf(entries) {
  const hash = crypto.createHash('sha256');
  for (const entry of entries) hash.update(entry.path + '\0' + entry.sha256 + '\n');
  return hash.digest('hex');
}

function copyTree(from, to, {skip = () => false} = {}) {
  for (const rel of walk(from)) {
    if (skip(rel)) continue;
    copyFile(path.join(from, ...rel.split('/')), path.join(to, ...rel.split('/')));
  }
}

function gitRev() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  } catch {
    return null;
  }
}

function buildDsh(deps) {
  const src = path.join(root, 'packages', 'dsh-plugin');
  const out = path.join(dist, 'dsh-plugin');
  const pkg = readJson(path.join(src, 'package.json'));
  // The loader must agree with the execution snapshot it will load.
  if (!fs.existsSync(path.join(root, 'src', 'desktop-plugin.mjs'))) throw new Error('src/desktop-plugin.mjs missing');
  copyFile(path.join(src, 'package.json'), path.join(out, 'package.json'));
  copyFile(path.join(src, 'index.js'), path.join(out, 'index.js'));
  copyFile(path.join(src, 'cordis.patch.yml'), path.join(out, 'cordis.patch.yml'));
  copyFile(path.join(src, 'README.md'), path.join(out, 'README.md'));
  const entries = files(out);
  const artifact = {name: 'dsh-plugin', version: pkg.version, engines: pkg.engines, dir: 'dsh-plugin', digest: digestOf(entries), files: entries};
  // Optional tarball; `dsh plugin add <tgz>` is the documented install path.
  try {
    const tgz = path.join(dist, `dsh-control-bridge-${pkg.version}.tgz`);
    execFileSync('tar', ['-czf', tgz, '-C', out, '.'], {stdio: 'ignore'});
    artifact.tarball = {path: path.basename(tgz), bytes: fs.statSync(tgz).size, sha256: sha256(tgz)};
  } catch {
    artifact.tarball = {path: null, reason: 'tar unavailable; install the directory instead'};
  }
  return artifact;
}

function buildCodex(deps) {
  const out = path.join(dist, 'codex-plugin');
  const plugin = readJson(path.join(root, 'packages', 'codex-plugin', 'package.json'));
  for (const manifest of ['plugin.json', path.join('.codex-plugin', 'plugin.json')]) {
    const declared = readJson(path.join(root, 'packages', 'codex-plugin', manifest));
    if (declared.version !== plugin.version) {
      throw new Error(manifest + ' version ' + declared.version + ' != package version ' + plugin.version);
    }
  }
  copyFile(path.join(root, 'packages', 'codex-plugin', 'plugin.json'), path.join(out, 'plugin.json'));
  copyFile(path.join(root, 'packages', 'codex-plugin', '.codex-plugin', 'plugin.json'), path.join(out, '.codex-plugin', 'plugin.json'));
  copyFile(path.join(root, 'packages', 'codex-plugin', 'mcp.template.json'), path.join(out, 'mcp.template.json'));
  // Skills are the versioned source under skill/, never a second copy in git.
  copyTree(path.join(root, 'skill'), path.join(out, 'skills', 'dsh-control'));
  // Self-contained MCP server: sources plus runtime dependencies.
  const server = path.join(out, 'server');
  for (const file of SERVER_FILES) copyFile(path.join(root, 'src', file), path.join(server, file));
  fs.writeFileSync(path.join(server, 'package.json'), JSON.stringify({
    name: 'dsh-control-server', version: plugin.version, private: true, type: 'module',
    description: 'Self-contained stdio MCP server for the dsh-control Codex plugin',
  }, null, 2) + '\n');
  let copied = 0;
  if (fs.existsSync(path.join(root, 'node_modules'))) {
    copyTree(path.join(root, 'node_modules'), path.join(server, 'node_modules'), {
      // .bin holds install-time shims and symlinks; the runtime never needs them.
      skip: rel => rel.split('/')[0] === '.bin',
    });
    copied = fs.readdirSync(path.join(server, 'node_modules')).length;
  }
  // Import the actual packaged entry points without invoking main or any model.
  // A valid entry file alone does not prove its transitive backend modules shipped.
  execFileSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(pathToFileURL(path.join(server, 'mcp.mjs')).href)}); await import(${JSON.stringify(pathToFileURL(path.join(server, 'worker.mjs')).href)});`],
  {cwd: out, windowsHide: true, stdio: 'pipe'});
  // Loader parity check: the bundle loader injects the same services as the snapshot.
  const snapshotSource = fs.readFileSync(path.join(root, 'src', 'desktop-plugin.mjs'), 'utf8');
  const loaderSource = fs.readFileSync(path.join(root, 'packages', 'dsh-plugin', 'index.js'), 'utf8');
  const list = source => JSON.parse(source.match(/export const inject\s*=\s*(\[[\s\S]*?\])/)[1].replace(/'/g, '"').replace(/,(\s*\])/g, '$1'));
  const a = list(snapshotSource);
  const b = list(loaderSource);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Bundle loader inject list drifted from src/desktop-plugin.mjs');
  const entries = files(out);
  return {name: 'codex-plugin', version: plugin.version, dir: 'codex-plugin', digest: digestOf(entries), files: entries, nodeModules: copied};
}

function main() {
  if(path.dirname(dist)!==root||path.basename(dist)!=='dist'||(fs.existsSync(dist)&&(fs.lstatSync(dist).isSymbolicLink()||fs.realpathSync.native(dist)!==dist)))throw new Error('Refusing to replace an unexpected build directory');
  fs.rmSync(dist, {recursive: true, force: true});
  mkdir(dist);
  const protocol = fs.readFileSync(path.join(root, 'src', 'protocol.mjs'), 'utf8');
  const protocolVersion = Number(protocol.match(/export const PROTOCOL_VERSION\s*=\s*(\d+)/)[1]);
  const dsh = buildDsh();
  const codex = buildCodex();
  const manifest = {
    name: 'dsh-control-plugin-suite',
    version: dsh.version,
    protocolVersion,
    gitRevision: gitRev(),
    builtAt: new Date().toISOString(),
    node: process.version,
    packages: {dsh, codex},
  };
  fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({
    ok: true,
    protocolVersion,
    dsh: {version: dsh.version, digest: dsh.digest, tarball: dsh.tarball},
    codex: {version: codex.version, digest: codex.digest, files: codex.files.length, nodeModules: codex.nodeModules},
    manifest: path.join(dist, 'manifest.json'),
  }, null, 2));
}

main();
