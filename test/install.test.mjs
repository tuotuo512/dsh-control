import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fakeInstallation} from './fixtures/installation.mjs';

const install = await import('../scripts/install.mjs');

function workspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-install-'));
  const home = path.join(base, 'home with space');
  const codexRoot = path.join(base, 'codex');
  const dshHome = path.join(base, 'dsh');
  const dist = path.join(base, 'dist');
  fs.mkdirSync(path.join(dshHome, 'profiles', 'p1'), {recursive: true});
  fs.mkdirSync(home,{recursive:true});
  fs.writeFileSync(path.join(home,'config.json'),JSON.stringify(fakeInstallation(base).config));
  fs.mkdirSync(path.join(dist, 'codex-plugin', 'server'), {recursive: true});
  fs.writeFileSync(path.join(dshHome, 'profiles', 'p1', 'package.json'), JSON.stringify({name: 'dsh-profile-p1', private: true, dsh: {profile: {bundles: []}}}, null, 2));
  fs.writeFileSync(path.join(dshHome, 'profiles', 'p1', 'cordis.patch.yml'), '[]\n');
  fs.writeFileSync(path.join(dist, 'codex-plugin', 'server', 'mcp.mjs'), 'export {};\n');
  fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify({
    version: '0.3.0', protocolVersion: 1,
    packages: {dsh: {version: '0.3.0', digest: 'd'.repeat(64)}, codex: {version: '0.3.0', digest: 'c'.repeat(64)}},
  }));
  return {base, home, codexRoot, dshHome, dist};
}

const cleanup = base => fs.rmSync(base, {recursive: true, force: true});

test('supervisor-only activation preserves serving native code and active work',()=>{
 const w=workspace();try{
  const options={home:w.home,codexRoot:w.codexRoot,dshHome:w.dshHome,profile:'p1',dist:w.dist,codexMode:'config'};
  const original=install.apply(options).receipt;
  const profile=path.join(w.dshHome,'profiles','p1','cordis.patch.yml'),profileBefore=fs.readFileSync(profile,'utf8');
  const run=path.join(w.home,'runs','run-'+'b'.repeat(24));fs.mkdirSync(run,{recursive:true});
  const state=JSON.stringify({runId:'run-'+'b'.repeat(24),sessionId:'existing',status:'running'});fs.writeFileSync(path.join(run,'state.json'),state);
  const file=path.join(w.dist,'manifest.json'),built=JSON.parse(fs.readFileSync(file,'utf8'));
  built.version='0.4.0';built.packages.codex.version='0.4.0';built.packages.codex.digest='e'.repeat(64);fs.writeFileSync(file,JSON.stringify(built));
  const cfg=JSON.parse(fs.readFileSync(path.join(w.home,'config.json'),'utf8'));
  const health={ready:true,protocolVersion:1,archiveSha256:cfg.verifiedArchiveSha256,sourceDigest:original.nativeRevision,instanceId:'same',pluginVersion:original.nativeVersion};
  const result=install.apply({...options,component:'supervisor'},{readNativeHealth:()=>health});
  assert.equal(result.receipt.packageVersion,'0.4.0');assert.equal(result.receipt.nativeVersion,original.nativeVersion);
  assert.equal(result.receipt.nativeSnapshot,original.nativeSnapshot);assert.notEqual(result.receipt.serverDir,original.serverDir);
  assert.equal(fs.readFileSync(profile,'utf8'),profileBefore);assert.equal(fs.readFileSync(path.join(run,'state.json'),'utf8'),state);
  assert.throws(()=>install.apply(options),/still live/);
  const before=fs.readFileSync(path.join(w.codexRoot,'config.toml'),'utf8');
  assert.throws(()=>install.apply({...options,component:'supervisor'},{readNativeHealth:()=>({...health,sourceDigest:'drift'})}),/identity\/protocol differs/);
  assert.equal(fs.readFileSync(path.join(w.codexRoot,'config.toml'),'utf8'),before);
 }finally{cleanup(w.base);}
});

test('stage prepares candidates during live work without activating registrations or changing the run',()=>{
 const w=workspace();try{
  const runDir=path.join(w.home,'runs','run-'+'a'.repeat(24));fs.mkdirSync(runDir,{recursive:true});
  const state=JSON.stringify({runId:'run-'+'a'.repeat(24),status:'running',sessionId:'fixture-active'});fs.writeFileSync(path.join(runDir,'state.json'),state);
  const profile=path.join(w.dshHome,'profiles','p1','cordis.patch.yml'),before=fs.readFileSync(profile,'utf8');
  const result=install.stage({home:w.home,codexRoot:w.codexRoot,dshHome:w.dshHome,profile:'p1',dist:w.dist});
  assert.equal(result.activated,false);assert.equal(result.busy.length,1);assert.ok(fs.existsSync(result.serverDir));
  assert.equal(fs.readFileSync(profile,'utf8'),before);assert.equal(fs.existsSync(path.join(w.codexRoot,'config.toml')),false);
  assert.equal(fs.readFileSync(path.join(runDir,'state.json'),'utf8'),state);
  const manifestFile=path.join(w.dist,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  manifest.packages.codex.files=[{path:'server/mcp.mjs',sha256:crypto.createHash('sha256').update('export {};\n').digest('hex')}];
  fs.writeFileSync(manifestFile,JSON.stringify(manifest));fs.writeFileSync(path.join(result.serverDir,'mcp.mjs'),'tampered');
  assert.throws(()=>install.stage({home:w.home,codexRoot:w.codexRoot,dshHome:w.dshHome,profile:'p1',dist:w.dist}),/deployment changed/);
  assert.throws(()=>install.apply({home:w.home,codexRoot:w.codexRoot,dshHome:w.dshHome,profile:'p1',dist:w.dist}),/still live/);
 }finally{cleanup(w.base);}
});

test('profile patch replaces an empty document instead of appending a second one', () => {
  const w = workspace();
  try {
    install.writeProfileBlock(w.dshHome, 'p1', {home: w.home, snapshot: path.join(w.home, 'native-plugin', 'a'.repeat(64)), registered: false});
    const text = fs.readFileSync(path.join(w.dshHome, 'profiles', 'p1', 'cordis.patch.yml'), 'utf8');
    assert.ok(!/^\s*\[\]\s*$/m.test(text), 'empty list document must be replaced');
    assert.match(text, /# BEGIN dsh-control native bridge/);
    assert.match(text, /- insert:/);
    const removed = install.removeProfileBlock(w.dshHome, 'p1');
    assert.equal(removed.removed, true);
    assert.equal(fs.readFileSync(path.join(w.dshHome, 'profiles', 'p1', 'cordis.patch.yml'), 'utf8').trim(), '[]');
  } finally { cleanup(w.base); }
});

test('registered bundle gets an id-targeted override row, not a file url', () => {
  const w = workspace();
  try {
    fs.writeFileSync(path.join(w.dshHome, 'profiles', 'p1', 'package.json'), JSON.stringify({name: 'p', dsh: {profile: {bundles: ['dsh-control-bridge']}}}));
    const snapshot = path.join(w.home, 'native-plugin', 'b'.repeat(64));
    install.writeProfileBlock(w.dshHome, 'p1', {home: w.home, snapshot, registered: true});
    const text = fs.readFileSync(path.join(w.dshHome, 'profiles', 'p1', 'cordis.patch.yml'), 'utf8');
    assert.match(text, /- id: dsh-control-bridge/);
    assert.match(text, /name: dsh-control-bridge/);
    assert.ok(!text.includes('file:///'), 'bundle registration must not create a second file-url bridge');
    assert.ok(text.includes(snapshot.replace(/\\/g, '\\\\')));
  } finally { cleanup(w.base); }
});

test('legacy Codex MCP section is migrated to one managed block', () => {
  const w = workspace();
  try {
    const file = path.join(w.codexRoot, 'config.toml');
    fs.mkdirSync(w.codexRoot, {recursive: true});
    fs.writeFileSync(file, "[model]\nname = 'x'\n\n[mcp_servers.dsh-control]\ncommand = 'node'\nargs = ['old.mjs']\n\n[other]\nkey = 1\n");
    const before = install.readCodexRegistration(w.codexRoot);
    assert.equal(before.legacy, true);
    install.writeCodexMcp(w.codexRoot, {command: 'C:\\node.exe', args: ['C:\\server\\mcp.mjs'], previous: before.text});
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.match(/\[mcp_servers\.dsh-control\]/g).length, 1);
    assert.match(text, /BEGIN dsh-control managed block/);
    assert.match(text, /\[other\]/);
    assert.match(text, /key = 1/);
    assert.equal(install.readCodexRegistration(w.codexRoot).managed, true);
    install.removeCodexMcp(w.codexRoot);
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(!after.includes('mcp_servers.dsh-control'));
    assert.ok(after.includes('[other]'));
  } finally { cleanup(w.base); }
});

test('apply is idempotent, keeps data and refuses while a managed run is live', () => {
  const w = workspace();
  try {
    const first = install.apply({home: w.home, codexRoot: w.codexRoot, dshHome: w.dshHome, profile: 'p1', dist: w.dist, codexMode: 'config'});
    assert.equal(first.receipt.codex.mode, 'config');
    const snapshot = first.receipt.nativeSnapshot;
    assert.ok(fs.existsSync(path.join(snapshot, 'desktop-plugin.mjs')));
    const config = fs.readFileSync(path.join(w.codexRoot, 'config.toml'), 'utf8');
    assert.match(config, /mcp_servers\.dsh-control/);
    assert.match(config,/\[mcp_servers\.dsh-control\.env\]/);assert.ok(config.includes('DSH_CONTROL_HOME = '+JSON.stringify(w.home)));
    const second = install.apply({home: w.home, codexRoot: w.codexRoot, dshHome: w.dshHome, profile: 'p1', dist: w.dist, codexMode: 'config'});
    assert.equal(second.receipt.nativeRevision, first.receipt.nativeRevision);
    assert.equal(fs.readFileSync(path.join(w.codexRoot, 'config.toml'), 'utf8').match(/BEGIN dsh-control/g).length, 1);

    const runDir = path.join(w.home, 'runs', 'run-' + 'a'.repeat(24));
    fs.mkdirSync(runDir, {recursive: true});
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({runId: 'run-' + 'a'.repeat(24), status: 'running', leaseHeld: true, sessionId: 's'}));
    assert.throws(() => install.apply({home: w.home, codexRoot: w.codexRoot, dshHome: w.dshHome, profile: 'p1', dist: w.dist, codexMode: 'config'}), /still live/);
    assert.throws(() => install.uninstall({home: w.home, codexRoot: w.codexRoot, dshHome: w.dshHome, profile: 'p1'}), /live/);
    const report = path.join(runDir, 'report.md');
    fs.writeFileSync(report, '# report\n');
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({runId: 'run-' + 'a'.repeat(24), status: 'completed', leaseHeld: false, sessionId: 's'}));
    const removed = install.uninstall({home: w.home, codexRoot: w.codexRoot, dshHome: w.dshHome, profile: 'p1'});
    assert.equal(removed.profile.removed, true);
    assert.ok(fs.existsSync(report), 'run data must survive uninstall');
    const patch = fs.readFileSync(path.join(w.dshHome, 'profiles', 'p1', 'cordis.patch.yml'), 'utf8');
    assert.ok(!patch.includes('dsh-control'));
  } finally { cleanup(w.base); }
});

test('plan reports readiness and busy state without writing', () => {
  const w = workspace();
  try {
    const before = fs.readFileSync(path.join(w.dshHome, 'profiles', 'p1', 'cordis.patch.yml'), 'utf8');
    const result = install.plan({home: w.home, codexRoot: w.codexRoot, dshHome: w.dshHome, profile: 'p1', dist: w.dist});
    assert.equal(result.action, 'ready');
    assert.equal(result.codex.managed, false);
    assert.equal(fs.readFileSync(path.join(w.dshHome, 'profiles', 'p1', 'cordis.patch.yml'), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(w.home, 'native-plugin')), false);
  } finally { cleanup(w.base); }
});

test('verify refuses an installed entry with a missing Worker backend dependency', () => {
  const w = workspace();
  try {
    fs.writeFileSync(path.join(w.dist, 'codex-plugin', 'server', 'worker.mjs'), "import './acp-client.mjs';\nexport {};\n");
    const applied = install.apply({home: w.home, codexRoot: w.codexRoot, dshHome: w.dshHome, profile: 'p1', dist: w.dist, codexMode: 'config'});
    const options = {home: w.home, codexRoot: w.codexRoot, dshHome: w.dshHome, profile: 'p1', dist: w.dist};
    const broken = install.verify(options);
    assert.equal(broken.ok, false);
    assert.equal(broken.checks.find(c => c.name === 'server-entry').ok, true);
    assert.equal(broken.checks.find(c => c.name === 'server-module-load').ok, false);
    fs.writeFileSync(path.join(applied.receipt.serverDir, 'acp-client.mjs'), 'export {};\n');
    assert.equal(install.verify(options).checks.find(c => c.name === 'server-module-load').ok, true);
  } finally { cleanup(w.base); }
});

test('a failing Codex step restores both registration files', () => {
  const w = workspace();
  try {
    const profileFile = path.join(w.dshHome, 'profiles', 'p1', 'cordis.patch.yml');
    const configFile = path.join(w.codexRoot, 'config.toml');
    fs.mkdirSync(w.codexRoot, {recursive: true});
    fs.writeFileSync(configFile, "[model]\nname = 'keep-me'\n");
    const beforeProfile = fs.readFileSync(profileFile, 'utf8');
    const beforeConfig = fs.readFileSync(configFile, 'utf8');
    assert.throws(
      () => install.apply({home: w.home, codexRoot: w.codexRoot, dshHome: w.dshHome, profile: 'p1', dist: w.dist, codexMode: 'plugin', codexCli: path.join(w.base, 'missing-codex.exe')}),
      /restored/,
    );
    assert.equal(fs.readFileSync(profileFile, 'utf8'), beforeProfile, 'profile patch must be restored');
    assert.equal(fs.readFileSync(configFile, 'utf8'), beforeConfig, 'config.toml must be restored');
    assert.ok(!fs.readFileSync(configFile, 'utf8').includes('mcp_servers.dsh-control'));
  } finally { cleanup(w.base); }
});

test('a concurrent change to config.toml is refused instead of overwritten', () => {
  const w = workspace();
  try {
    const file = path.join(w.codexRoot, 'config.toml');
    fs.mkdirSync(w.codexRoot, {recursive: true});
    fs.writeFileSync(file, "[model]\nname = 'x'\n");
    const before = install.readCodexRegistration(w.codexRoot);
    fs.appendFileSync(file, "[other]\nkey = 2\n");
    assert.throws(
      () => install.writeCodexMcp(w.codexRoot, {command: 'node', args: ['mcp.mjs'], previous: before.text}),
      /changed during install/,
    );
    assert.ok(fs.readFileSync(file, 'utf8').includes('[other]'), 'the other writer keeps its change');
  } finally { cleanup(w.base); }
});

test('backups live beside the managed home and unsafe homes are refused', () => {
  const w = workspace();
  try {
    const root = install.backupsRoot({home: w.home});
    assert.equal(path.dirname(root), path.dirname(w.home));
    assert.ok(!root.startsWith(w.home + path.sep), 'backups must not live inside the home they protect');
    assert.throws(() => install.paths({home: path.parse(w.home).root}), /unsafe home/);
    const resolved = install.paths({home: w.home, codexRoot: w.codexRoot, dshHome: w.dshHome});
    assert.equal(resolved.home, w.home);
  } finally { cleanup(w.base); }
});
test('an unconfigured first installation is rejected before either application registration is written',()=>{
  const w=workspace();try{
    fs.unlinkSync(path.join(w.home,'config.json'));
    const patch=fs.readFileSync(path.join(w.dshHome,'profiles','p1','cordis.patch.yml'),'utf8');
    assert.equal(install.plan({home:w.home,codexRoot:w.codexRoot,dshHome:w.dshHome,profile:'p1',dist:w.dist}).action,'needs-setup');
    assert.throws(()=>install.apply({home:w.home,codexRoot:w.codexRoot,dshHome:w.dshHome,profile:'p1',dist:w.dist,codexMode:'config'}),/config.json/);
    assert.equal(fs.readFileSync(path.join(w.dshHome,'profiles','p1','cordis.patch.yml'),'utf8'),patch);assert.ok(!fs.existsSync(path.join(w.codexRoot,'config.toml')));
  }finally{cleanup(w.base);}
});
test('profile CAS and rollback preserve a concurrent writer instead of restoring a stale preimage',()=>{
  const w=workspace();try{
    const file=path.join(w.dshHome,'profiles','p1','cordis.patch.yml'),text=fs.readFileSync(file,'utf8');
    fs.writeFileSync(file,'# another writer\n[]\n');
    assert.throws(()=>install.writeProfileBlock(w.dshHome,'p1',{home:w.home,snapshot:path.join(w.home,'native-plugin','a'.repeat(64)),registered:false,previous:text}),/changed during install/);
    const before={file,exists:true,text};assert.equal(install.restoreRegistration(before,undefined),false);assert.match(fs.readFileSync(file,'utf8'),/another writer/);
    const ownHash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');assert.equal(install.restoreRegistration(before,ownHash),true);assert.equal(fs.readFileSync(file,'utf8'),text);
  }finally{cleanup(w.base);}
});
