import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { normalizeWslPath } from './wsl-runtime.js';
import { identifierSlug, stableBoardIdentity, uniqueProjectIdentity } from './project-identity.js';

export const MAX_PROJECTS = 3;
export const PORT = Number.parseInt(process.env.PRAETORIUM_PORT, 10) || 3848;
export const PROJECTS_ROOT = resolve(process.env.PRAETORIUM_PROJECTS_ROOT || (process.platform === 'win32' ? 'C:\\projects' : join(homedir(), 'projects')));

const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), '.local', 'share');
export const DATA_DIR = join(localAppData, 'PraetoriumData');
const projectsFile = join(DATA_DIR, 'projects.json');

mkdirSync(DATA_DIR, { recursive: true });

function slug(value, fallback = `project-${Date.now().toString(36)}`) {
  return identifierSlug(value, fallback);
}

function validDirectory(path) {
  try { return (isAbsolute(path) || win32.isAbsolute(path)) && statSync(path).isDirectory(); }
  catch { return false; }
}

function projectRuntime(value) {
  return value === 'wsl' ? 'wsl' : 'windows';
}

function projectSlot(value) {
  const slot = Number(value);
  return Number.isInteger(slot) && slot >= 1 && slot <= MAX_PROJECTS ? slot : null;
}

function projectIdentity(value, entropy = randomUUID()) {
  return uniqueProjectIdentity(value, entropy);
}

function assignProjectSlots(projects) {
  const used = new Set();
  return projects.map(project => {
    let slot = projectSlot(project.slot);
    if (!slot || used.has(slot)) slot = Array.from({ length: MAX_PROJECTS }, (_, index) => index + 1).find(candidate => !used.has(candidate));
    used.add(slot);
    return { ...project, slot };
  });
}

function cleanProject(project, { checkDirectory = project?.runtime !== 'wsl' } = {}) {
  const rawPath = String(project?.path || '');
  if (!rawPath.trim()) return null;
  const runtime = projectRuntime(project.runtime);
  let path;
  let distro = null;
  if (runtime === 'wsl') {
    try { path = normalizeWslPath(rawPath); }
    catch { return null; }
    distro = String(project.distro || '').trim();
    if (!distro) return null;
  } else {
    const windowsPath = rawPath.trim();
    path = win32.isAbsolute(windowsPath) ? win32.normalize(windowsPath) : resolve(windowsPath);
    if (checkDirectory && !validDirectory(path)) return null;
  }
  return {
    id: stableBoardIdentity(project.id || project.name || (runtime === 'wsl' ? posix.basename(path) : basename(path))),
    name: String(project.name || (runtime === 'wsl' ? posix.basename(path) : basename(path))).trim().slice(0, 80),
    path,
    runtime,
    distro,
    slot: projectSlot(project.slot),
  };
}

function load() {
  const candidates = [projectsFile];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      const projects = assignProjectSlots((parsed.projects || parsed || []).map(project => cleanProject(project, {
        checkDirectory: projectRuntime(project?.runtime) !== 'wsl',
      })).filter(Boolean).slice(0, MAX_PROJECTS));
      if (projects.length || candidate === projectsFile) return { projects };
    } catch { /* try the next migration source */ }
  }
  return { projects: [] };
}

const state = load();

if (!state.projects.length && validDirectory(PROJECTS_ROOT)) {
  for (const entry of readdirSync(PROJECTS_ROOT, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (state.projects.length >= MAX_PROJECTS) break;
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = resolve(PROJECTS_ROOT, entry.name);
    if (!existsSync(join(path, '.git'))) continue;
    const project = cleanProject({ id: slug(entry.name, `project-${state.projects.length + 1}`), name: entry.name, path });
    if (project) state.projects.push({ ...project, slot: state.projects.length + 1 });
  }
}

function save() {
  const temp = `${projectsFile}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(temp, projectsFile);
}

if (!existsSync(projectsFile) && state.projects.length) save();

export function getProjects() {
  return state.projects.map(project => ({ ...project })).sort((a, b) => a.slot - b.slot);
}

export function addProject(input) {
  if (state.projects.length >= MAX_PROJECTS) throw new Error(`Project Director는 최대 ${MAX_PROJECTS}개입니다.`);
  if (!String(input?.name || '').trim() || !String(input?.path || '').trim()) throw new Error('name and path required');
  const project = cleanProject({ ...input, name: String(input.name).trim(), id: input.id || slug(input.name, `project-${state.projects.length + 1}`) }, {
    checkDirectory: projectRuntime(input.runtime) !== 'wsl',
  });
  if (!project) throw new Error('존재하는 프로젝트 절대 경로를 입력하세요.');
  const pathKey = `${project.runtime}:${project.distro || ''}:${project.path}`.toLowerCase();
  if (state.projects.some(item => `${item.runtime}:${item.distro || ''}:${item.path}`.toLowerCase() === pathKey)) throw new Error('이미 배정된 프로젝트입니다.');
  const id = projectIdentity(project.id);
  const usedSlots = new Set(state.projects.map(item => item.slot));
  const slot = Array.from({ length: MAX_PROJECTS }, (_, index) => index + 1).find(candidate => !usedSlots.has(candidate));
  const created = { ...project, id, slot };
  state.projects.push(created);
  save();
  return { ...created };
}

export function deleteProject(id) {
  const index = state.projects.findIndex(project => project.id === id);
  if (index < 0) return false;
  state.projects.splice(index, 1);
  save();
  return true;
}

export const _test = { slug, cleanProject, validDirectory, projectRuntime, projectSlot, projectIdentity, assignProjectSlots };
