import fs from 'node:fs';
import path from 'node:path';
import {locked, readJson, writeJson} from './store.mjs';

export const PERMISSIONS = Object.freeze(['read-only', 'workspace-write', 'danger-full-access']);
export const isWriter = permission => permission !== 'read-only';
export function checkPermission(permission) {
  if (!PERMISSIONS.includes(permission)) throw new Error('Invalid permission: choose read-only, workspace-write or danger-full-access');
  return permission;
}
export function workspacePath(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute workspace path');
  const value = fs.realpathSync.native(cwd);
  if (!fs.statSync(value).isDirectory()) throw new Error('cwd must be an existing directory');
  return value;
}
const key = cwd => process.platform === 'win32' ? cwd.toLowerCase() : cwd;
export const policyPath = home => path.join(home, 'workspace-permissions.json');
function readPolicies(home) {
  if (!fs.existsSync(policyPath(home))) return {schemaVersion: 1, revision: 0, projects: []};
  const value = readJson(policyPath(home));
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.projects)) throw new Error('Invalid workspace permission policy; inspect before sending');
  const seen = new Set();
  for (const entry of value.projects) {
    if (typeof entry.cwd !== 'string' || !path.isAbsolute(entry.cwd) || seen.has(key(entry.cwd))) throw new Error('Invalid workspace permission entry');
    checkPermission(entry.permission); seen.add(key(entry.cwd));
  }
  return value;
}
export function workspacePolicy(home, cwd) {
  const canonical = workspacePath(cwd), value = readPolicies(home);
  const entry = value.projects.find(p => key(p.cwd) === key(canonical));
  return {cwd: canonical, revision: value.revision, permission: entry?.permission ?? 'read-only', source: entry ? 'project' : 'default', path: policyPath(home)};
}
export async function updateWorkspacePolicy(home, {cwd, permission, expectedRevision}) {
  const canonical = workspacePath(cwd);
  if (permission !== null) checkPermission(permission);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Policy write requires expectedRevision');
  return locked(home, async () => {
    const value = readPolicies(home);
    if (value.revision !== expectedRevision) throw new Error('Workspace policy revision changed; re-read before saving');
    value.projects = value.projects.filter(p => key(p.cwd) !== key(canonical));
    if (permission !== null) value.projects.push({cwd: canonical, permission});
    value.revision++; writeJson(policyPath(home), value);
    return workspacePolicy(home, canonical);
  }, 'workspace-policy.lock');
}
