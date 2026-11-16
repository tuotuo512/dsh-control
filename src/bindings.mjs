import fs from 'node:fs';
import path from 'node:path';
import {readJson, writeJson, locked, id} from './store.mjs';

export const bindingsPath = home => path.join(home, 'conversation-bindings.json');
const keyPath = value => process.platform === 'win32' ? value.toLowerCase() : value;
const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid connection note ${name}`);
  return value;
};
const directory = value => {
  required(value,'cwd');
  if(!path.isAbsolute(value))throw new Error('Connection note cwd must be absolute');
  return value;
};
const projectOf = link => ({
  ...(link.workspaceId ? {workspaceId: id(link.workspaceId, 'workspaceId')} : {}),
  title: required(link.workspaceTitle || path.basename(directory(link.cwd)) || link.cwd,'project title'),
  cwd: directory(link.cwd), conversations: [],
});
const conversationOf = link => ({
  sessionId: id(link.sessionId, 'sessionId'), title: required(link.title || '未命名','conversation title'),
  backend: required(link.backend, 'backend'),
  linkedAt: required(link.linkedAt || new Date().toISOString(),'linkedAt'),
});
function put(note, link) {
  const previous = note.projects.flatMap(p => p.conversations).find(c => c.sessionId === link.sessionId);
  for (const project of note.projects) project.conversations = project.conversations.filter(c => c.sessionId !== link.sessionId);
  let project = note.projects.find(p => p.workspaceId && link.workspaceId
    ? p.workspaceId === link.workspaceId : keyPath(p.cwd) === keyPath(link.cwd));
  if (!project) { project = projectOf(link); note.projects.push(project); }
  else Object.assign(project, {...projectOf(link), conversations: project.conversations});
  project.conversations.push(conversationOf({...link, linkedAt: previous?.linkedAt || link.linkedAt}));
}

/** This file records connections only. Runs, status and chat content stay elsewhere. */
export function readBindings(home) {
  const file = bindingsPath(home);
  if (!fs.existsSync(file)) return {schemaVersion: 2, projects: []};
  const raw = readJson(file), note = {schemaVersion: 2, projects: []};
  if (raw.schemaVersion === 1 && raw.conversations && typeof raw.conversations === 'object') {
    for (const link of Object.values(raw.conversations)) put(note, {...link, backend:link.backend||'sdk', linkedAt: link.registeredAt});
  } else if (raw.schemaVersion === 2 && Array.isArray(raw.projects)) {
    for (const project of raw.projects) {
      required(project.cwd, 'cwd');
      if (!Array.isArray(project.conversations)) throw new Error('Invalid connection note conversations');
      if (project.conversations.length === 0) note.projects.push(projectOf({...project, workspaceTitle: project.title}));
      for (const link of project.conversations) put(note, {...link, cwd: project.cwd,
        workspaceId: project.workspaceId, workspaceTitle: project.title});
    }
  } else throw new Error('Unsupported connection note schema; existing notes were not overwritten');
  return note;
}

async function change(home, edit) {
  return locked(home, async () => {
    const note = readBindings(home);
    if (edit(note)) writeJson(bindingsPath(home), note);
    return note;
  }, 'bindings.lock');
}
export async function recordBinding(home, link) {
  return change(home, note => { put(note, link); return true; });
}
export async function forgetBinding(home, sessionId) {
  id(sessionId, 'sessionId');
  return change(home, note => {
    let removed = false;
    for (const project of note.projects) {
      const before = project.conversations.length;
      project.conversations = project.conversations.filter(c => c.sessionId !== sessionId);
      removed ||= before !== project.conversations.length;
    }
    return removed;
  });
}
export async function refreshBinding(home, info) {
  if (typeof info.exists !== 'boolean' || typeof info.archived !== 'boolean') {
    throw new Error('Native session state is unknown; connection notes were preserved');
  }
  return change(home, note => {
    const link = note.projects.flatMap(p => p.conversations).find(c => c.sessionId === info.sessionId);
    if (!link || link.backend !== 'desktop') return false; // Native absence cannot revoke an SDK/ACP identity.
    if (!info.exists || info.archived) {
      for (const project of note.projects) project.conversations = project.conversations.filter(c => c.sessionId !== info.sessionId);
      return true;
    }
    put(note, {...link, ...info, backend: link.backend});
    return true;
  });
}
