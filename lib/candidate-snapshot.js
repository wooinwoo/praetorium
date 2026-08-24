import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, readdir, realpath } from 'node:fs/promises';
import {
  isAbsolute, posix, relative, resolve, sep, win32,
} from 'node:path';

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_HASH_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 20000;
const HASH_DEADLINE_MS = 30000;
const EXCLUDED_FALLBACK_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.next']);
const PROTECTED_DECLARED_DIRS = new Set(['.git', 'node_modules']);

function capture(spawnImpl, command, args, { cwd, timeoutMs = 30000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(command, args, {
      cwd, env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const append = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_CAPTURE_BYTES) {
        child.kill();
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout?.on('data', chunk => append(stdout, chunk));
    child.stderr?.on('data', chunk => append(stderr, chunk));
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (bytes > MAX_CAPTURE_BYTES) return reject(new Error('Candidate snapshot metadata exceeded 16 MiB.'));
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code };
      if (code === 0) resolvePromise(result);
      else reject(Object.assign(new Error(result.stderr.toString('utf8').trim() || `${command} exited with code ${code}`), { result }));
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Candidate snapshot command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
}

function assertHashDeadline(budget) {
  if (Date.now() > budget.deadline) {
    throw new Error('Candidate snapshot hashing exceeded its 30 second deadline.');
  }
}

function slashPath(value) {
  return String(value).replaceAll('\\', '/');
}

function pathKey(value, caseSensitive = process.platform !== 'win32') {
  const normalized = slashPath(value);
  return caseSensitive ? normalized : normalized.toLowerCase();
}

function hasProtectedSegment(value) {
  return slashPath(value).split('/').some(segment => PROTECTED_DECLARED_DIRS.has(segment.toLowerCase()));
}

export function normalizeDeclaredPaths(
  declaredPaths = [], { caseSensitive = process.platform !== 'win32' } = {},
) {
  if (declaredPaths === null || declaredPaths === undefined) return [];
  if (!Array.isArray(declaredPaths)) throw new TypeError('Candidate declaredPaths must be an array of repository-relative literal paths.');
  if (typeof caseSensitive !== 'boolean') throw new TypeError('Candidate path case-sensitivity must be boolean.');
  const normalized = [];
  const seen = new Set();
  for (const value of declaredPaths) {
    if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) {
      throw new Error('Each candidate declared path must be a non-empty repository-relative literal path.');
    }
    const slashed = slashPath(value);
    if (slashed.startsWith('/') || posix.isAbsolute(slashed) || win32.isAbsolute(value)
      || /^[a-z]:/i.test(slashed)) {
      throw new Error(`Candidate declared path must be repository-relative: ${value}`);
    }
    const rawSegments = slashed.split('/');
    if (rawSegments.includes('..')) throw new Error(`Candidate declared path must not traverse outside the repository: ${value}`);
    const candidate = posix.normalize(slashed).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!candidate || candidate === '.' || candidate === '..' || candidate.startsWith('../')) {
      throw new Error(`Candidate declared path must name a repository entry: ${value}`);
    }
    if (candidate.split('/').some(segment => segment.includes(':'))) {
      throw new Error(`Candidate declared path must not use drive or stream syntax: ${value}`);
    }
    if (hasProtectedSegment(candidate)) {
      throw new Error(`Candidate declared path must not enter .git or node_modules: ${value}`);
    }
    const key = pathKey(candidate, caseSensitive);
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(candidate);
    }
  }
  return normalized.sort();
}

function candidateAbsolute(root, relativePath) {
  const absolute = resolve(root, ...slashPath(relativePath).split('/'));
  const rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Unsafe candidate path: ${relativePath}`);
  }
  return absolute;
}

function relativeInside(root, absolute) {
  const rel = relative(root, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return slashPath(rel);
}

async function fallbackFiles(root, directory = root, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_FALLBACK_DIRS.has(entry.name.toLowerCase())) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await fallbackFiles(root, path, files);
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(slashPath(relative(root, path)));
    if (files.length > MAX_FILES) throw new Error(`Candidate snapshot exceeds ${MAX_FILES} files.`);
  }
  return files;
}

async function assertDeclaredAncestors(root, rootRealPath, relativePath, budget) {
  let current = root;
  const segments = slashPath(relativePath).split('/');
  for (const segment of segments.slice(0, -1)) {
    assertHashDeadline(budget);
    current = resolve(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      let resolved;
      try { resolved = await realpath(current); }
      catch (error) {
        throw new Error(`Declared candidate path traverses an unresolved symlink: ${relativePath}`, { cause: error });
      }
      if (relativeInside(rootRealPath, resolved) === null) {
        throw new Error(`Declared candidate path resolves outside the candidate root: ${relativePath}`);
      }
      throw new Error(`Declared candidate path traverses a symlinked directory: ${relativePath}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Declared candidate path has a non-directory ancestor: ${relativePath}`);
    }
  }
}

async function declaredSymlinkState(rootRealPath, absolute, relativePath) {
  const target = await readlink(absolute);
  let resolvedTarget;
  try {
    resolvedTarget = await realpath(absolute);
  } catch (error) {
    throw new Error(`Declared candidate symlink is broken or cyclic: ${relativePath}`, { cause: error });
  }
  const resolvedPath = relativeInside(rootRealPath, resolvedTarget);
  if (resolvedPath === null) {
    throw new Error(`Declared candidate symlink resolves outside the candidate root: ${relativePath}`);
  }
  if (!resolvedPath || hasProtectedSegment(resolvedPath)) {
    throw new Error(`Declared candidate symlink resolves into an excluded candidate path: ${relativePath}`);
  }
  const targetInfo = await lstat(resolvedTarget);
  if (!targetInfo.isFile()) {
    throw new Error(`Declared candidate symlink must resolve to an in-root regular file: ${relativePath}`);
  }
  return { type: 'symlink', target, resolvedPath };
}

function recordDeclaredEntry(state, relativePath, entry) {
  const key = pathKey(relativePath);
  if (state.keys.has(key)) return;
  if (state.entries.size >= MAX_FILES) throw new Error(`Candidate snapshot exceeds ${MAX_FILES} declared entries.`);
  state.keys.add(key);
  state.entries.set(relativePath, entry);
}

async function collectDeclaredState(root, declaredPaths, budget) {
  const rootRealPath = budget.rootRealPath || await realpath(root);
  budget.rootRealPath = rootRealPath;
  const state = { entries: new Map(), keys: new Set(), bindings: [] };

  const visit = async (relativePath, { allowMissing = false } = {}) => {
    if (state.keys.has(pathKey(relativePath))) return;
    assertHashDeadline(budget);
    await assertDeclaredAncestors(root, rootRealPath, relativePath, budget);
    const absolute = candidateAbsolute(root, relativePath);
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error.code === 'ENOENT' && allowMissing) {
        recordDeclaredEntry(state, relativePath, { type: 'missing' });
        return;
      }
      if (error.code === 'ENOENT') throw new Error(`Declared candidate tree changed while enumerating: ${relativePath}`);
      throw error;
    }

    if (info.isSymbolicLink()) {
      recordDeclaredEntry(state, relativePath, await declaredSymlinkState(rootRealPath, absolute, relativePath));
      return;
    }
    if (info.isFile()) {
      const resolvedPath = relativeInside(rootRealPath, await realpath(absolute));
      if (resolvedPath === null) throw new Error(`Declared candidate path resolves outside the candidate root: ${relativePath}`);
      recordDeclaredEntry(state, relativePath, { type: 'file', resolvedPath });
      return;
    }
    if (!info.isDirectory()) {
      throw new Error(`Declared candidate path is not a regular file, directory, or safe symlink: ${relativePath}`);
    }

    recordDeclaredEntry(state, relativePath, { type: 'directory' });
    const children = await readdir(absolute, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      assertHashDeadline(budget);
      const childPath = `${relativePath}/${child.name}`;
      if (PROTECTED_DECLARED_DIRS.has(child.name.toLowerCase())) {
        recordDeclaredEntry(state, childPath, { type: 'excluded-directory' });
        continue;
      }
      await visit(childPath);
    }
  };

  for (const declaredPath of declaredPaths) await visit(declaredPath, { allowMissing: true });
  for (const declaredPath of declaredPaths) {
    const entry = [...state.entries].find(([path]) => pathKey(path) === pathKey(declaredPath))?.[1];
    const prefix = `${pathKey(declaredPath)}/`;
    const entryCount = [...state.entries.keys()].filter(path => {
      const key = pathKey(path);
      return key === pathKey(declaredPath) || key.startsWith(prefix);
    }).length;
    state.bindings.push({ path: declaredPath, state: entry?.type || 'missing', entryCount });
  }
  return state;
}

function declaredStateBytes(state) {
  const hash = createHash('sha256');
  for (const [path, entry] of [...state.entries].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(`entry\0${path}\0${entry.type}\0${entry.target || ''}\0${entry.resolvedPath || ''}\0`);
  }
  return hash.digest();
}

function sameDeclaredState(left, right) {
  return declaredStateBytes(left).equals(declaredStateBytes(right));
}

function bindDeclaredState(hash, declaredPaths, state) {
  if (!declaredPaths.length) return;
  hash.update('declared-paths-v1\0');
  for (const path of declaredPaths) hash.update(`declared-path\0${path}\0`);
  for (const [path, entry] of [...state.entries].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(`declared-entry\0${path}\0${entry.type}\0${entry.target || ''}\0${entry.resolvedPath || ''}\0`);
  }
}

function sameFileIdentity(info, observed) {
  return info.size === observed.size && info.mtimeMs === observed.mtimeMs
    && info.ctimeMs === observed.ctimeMs && info.ino === observed.ino && info.dev === observed.dev;
}

async function hashRegularFile(hash, absolute, relativePath, info, budget) {
  if (budget.bytes + info.size > budget.maxBytes) throw new Error('Candidate snapshot file content exceeds 512 MiB.');
  hash.update(`size\0${info.size}\0`);
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(absolute);
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(error);
    };
    stream.on('data', chunk => {
      budget.bytes += chunk.length;
      if (budget.bytes > budget.maxBytes) return fail(new Error('Candidate snapshot file content exceeds 512 MiB.'));
      if (Date.now() > budget.deadline) return fail(new Error('Candidate snapshot hashing exceeded its 30 second deadline.'));
      hash.update(chunk);
    });
    stream.once('error', fail);
    stream.once('end', () => { if (!settled) { settled = true; resolvePromise(); } });
  });
  const after = await lstat(absolute);
  if (!after.isFile() || !sameFileIdentity(after, info)) {
    throw new Error(`Candidate file changed while hashing: ${relativePath}`);
  }
  return after;
}

async function hashFile(hash, root, relativePath, budget) {
  assertHashDeadline(budget);
  const absolute = candidateAbsolute(root, relativePath);
  hash.update(`path\0${slashPath(relativePath)}\0`);
  const declaredEntry = budget.declaredEntries?.get(relativePath);
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (declaredEntry && declaredEntry.type !== 'missing') {
      throw new Error(`Declared candidate path disappeared while hashing: ${relativePath}`);
    }
    hash.update('missing\0');
    budget.observed?.set(relativePath, { type: 'missing' });
    return;
  }

  if (declaredEntry?.type === 'missing') {
    throw new Error(`Declared candidate path appeared while hashing: ${relativePath}`);
  }
  if (info.isSymbolicLink()) {
    const target = await readlink(absolute);
    hash.update(`symlink\0${target}\0`);
    let resolvedAbsolute = null;
    let resolvedPath = null;
    let resolvedInfo = null;
    if (declaredEntry) {
      if (declaredEntry.type !== 'symlink' || target !== declaredEntry.target) {
        throw new Error(`Declared candidate symlink changed while hashing: ${relativePath}`);
      }
      resolvedAbsolute = await realpath(absolute);
      resolvedPath = relativeInside(budget.rootRealPath, resolvedAbsolute);
      if (resolvedPath === null || !resolvedPath || hasProtectedSegment(resolvedPath)) {
        throw new Error(`Declared candidate symlink resolves outside the bound candidate tree: ${relativePath}`);
      }
      if (resolvedPath !== declaredEntry.resolvedPath) {
        throw new Error(`Declared candidate symlink changed while hashing: ${relativePath}`);
      }
      resolvedInfo = await lstat(resolvedAbsolute);
      if (!resolvedInfo.isFile()) {
        throw new Error(`Declared candidate symlink must resolve to an in-root regular file: ${relativePath}`);
      }
      hash.update(`resolved-file\0${resolvedPath}\0`);
      resolvedInfo = await hashRegularFile(hash, resolvedAbsolute, relativePath, resolvedInfo, budget);
    }
    const after = await lstat(absolute);
    const afterTarget = await readlink(absolute);
    if (!after.isSymbolicLink() || afterTarget !== target || !sameFileIdentity(after, info)) {
      throw new Error(`Candidate symlink changed while hashing: ${relativePath}`);
    }
    if (resolvedAbsolute && await realpath(absolute) !== resolvedAbsolute) {
      throw new Error(`Declared candidate symlink changed while hashing: ${relativePath}`);
    }
    budget.observed?.set(relativePath, {
      type: 'symlink', target, size: after.size, mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs, ino: after.ino, dev: after.dev,
      resolvedAbsolute, resolvedPath, resolvedInfo,
    });
    return;
  }
  if (!info.isFile()) {
    if (declaredEntry) throw new Error(`Declared candidate path is no longer a regular file: ${relativePath}`);
    hash.update(`not-file\0${info.mode}\0`);
    budget.observed?.set(relativePath, {
      type: 'other', mode: info.mode, size: info.size, mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs, ino: info.ino, dev: info.dev,
    });
    return;
  }

  let readAbsolute = absolute;
  let resolvedPath = null;
  if (declaredEntry) {
    if (declaredEntry.type !== 'file') throw new Error(`Declared candidate path changed while hashing: ${relativePath}`);
    readAbsolute = await realpath(absolute);
    resolvedPath = relativeInside(budget.rootRealPath, readAbsolute);
    if (resolvedPath === null || resolvedPath !== declaredEntry.resolvedPath || hasProtectedSegment(resolvedPath)) {
      throw new Error(`Declared candidate path resolves outside the bound candidate tree: ${relativePath}`);
    }
    info = await lstat(readAbsolute);
    if (!info.isFile()) throw new Error(`Declared candidate path is no longer a regular file: ${relativePath}`);
    hash.update(`resolved-file\0${resolvedPath}\0`);
  }
  const after = await hashRegularFile(hash, readAbsolute, relativePath, info, budget);
  if (declaredEntry && await realpath(absolute) !== readAbsolute) {
    throw new Error(`Declared candidate path changed while hashing: ${relativePath}`);
  }
  budget.observed?.set(relativePath, {
    type: 'file', size: after.size, mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs, ino: after.ino, dev: after.dev,
    resolvedAbsolute: declaredEntry ? readAbsolute : null, resolvedPath,
  });
}

async function verifyObservedFiles(root, observed, deadline) {
  for (const [relativePath, expected] of observed) {
    if (Date.now() > deadline) throw new Error('Candidate snapshot hashing exceeded its 30 second deadline.');
    const absolute = candidateAbsolute(root, relativePath);
    try {
      const info = await lstat(absolute);
      if (expected.type === 'missing') throw new Error(`Candidate path appeared while hashing: ${relativePath}`);
      if (expected.type === 'file' && (!info.isFile() || !sameFileIdentity(info, expected))) {
        throw new Error(`Candidate file changed while hashing: ${relativePath}`);
      }
      if (expected.type === 'file' && expected.resolvedAbsolute) {
        const resolved = await realpath(absolute);
        const resolvedInfo = await lstat(resolved);
        if (resolved !== expected.resolvedAbsolute || !resolvedInfo.isFile() || !sameFileIdentity(resolvedInfo, expected)) {
          throw new Error(`Declared candidate file changed while hashing: ${relativePath}`);
        }
      }
      if (expected.type === 'symlink') {
        const target = info.isSymbolicLink() ? await readlink(absolute) : null;
        if (!info.isSymbolicLink() || target !== expected.target || !sameFileIdentity(info, expected)) {
          throw new Error(`Candidate symlink changed while hashing: ${relativePath}`);
        }
        if (expected.resolvedAbsolute) {
          const resolved = await realpath(absolute);
          const resolvedInfo = await lstat(resolved);
          if (resolved !== expected.resolvedAbsolute || !resolvedInfo.isFile()
            || !sameFileIdentity(resolvedInfo, expected.resolvedInfo)) {
            throw new Error(`Declared candidate symlink target changed while hashing: ${relativePath}`);
          }
        }
      }
      if (expected.type === 'other'
        && (info.isFile() || info.isSymbolicLink() || info.mode !== expected.mode || !sameFileIdentity(info, expected))) {
        throw new Error(`Candidate path changed while hashing: ${relativePath}`);
      }
    } catch (error) {
      if (error.code === 'ENOENT' && expected.type === 'missing') continue;
      if (error.code === 'ENOENT') throw new Error(`Candidate path disappeared while hashing: ${relativePath}`);
      throw error;
    }
  }
}

async function gitCandidateState(root, spawnImpl) {
  const [head, listed, status, index, submodules] = await Promise.all([
    capture(spawnImpl, 'git', ['-C', root, 'rev-parse', 'HEAD']),
    capture(spawnImpl, 'git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z']),
    capture(spawnImpl, 'git', ['-C', root, 'status', '--porcelain=v2', '-z', '--untracked-files=all']),
    capture(spawnImpl, 'git', ['-C', root, 'ls-files', '-s', '-z']),
    capture(spawnImpl, 'git', ['-C', root, 'submodule', 'status', '--recursive'])
      .catch(() => ({ stdout: Buffer.from('submodule-status-unavailable') })),
  ]);
  return {
    revision: head.stdout.toString('utf8').trim() || null,
    paths: listed.stdout.toString('utf8').split('\0').filter(Boolean).sort(),
    headBytes: head.stdout,
    listedBytes: listed.stdout,
    statusBytes: status.stdout,
    indexBytes: index.stdout,
    submoduleBytes: submodules.stdout,
  };
}

function hasDirtySubmodule(statusBytes) {
  return statusBytes.toString('utf8').split('\0').some(record => {
    if (!record || !['1', '2', 'u'].includes(record[0])) return false;
    const submodule = record.split(' ')[2] || '';
    // Porcelain v2 encodes submodules as S<c><m><u>. A different checked-out
    // commit (<c>) is already bound by `git submodule status`; uncommitted or
    // untracked child content (<m>/<u>) is not, so fail closed instead of
    // granting a reusable digest to opaque mutable bytes.
    return submodule.startsWith('S') && (submodule[2] !== '.' || submodule[3] !== '.');
  });
}

function assertNoDirtySubmodule(state) {
  if (hasDirtySubmodule(state.statusBytes)) {
    throw new Error('Candidate snapshot refuses a dirty initialized submodule; commit or clean the submodule before verification.');
  }
}

function sameGitCandidateState(left, right) {
  return ['headBytes', 'listedBytes', 'statusBytes', 'indexBytes', 'submoduleBytes']
    .every(key => left[key].equals(right[key]));
}

function mergedCandidatePaths(paths, declaredState) {
  const merged = new Map();
  const add = (path, prefer = false) => {
    const key = pathKey(path);
    if (prefer || !merged.has(key)) merged.set(key, slashPath(path));
    if (merged.size > MAX_FILES) throw new Error(`Candidate snapshot exceeds ${MAX_FILES} files.`);
  };
  for (const path of paths) add(path);
  for (const [path, entry] of declaredState.entries) {
    if (['file', 'symlink', 'missing'].includes(entry.type)) add(path, true);
  }
  return [...merged.values()].sort();
}

export async function snapshotWindowsCandidate({ cwd, spawnImpl, declaredPaths = [] }) {
  const root = resolve(cwd);
  const normalizedDeclaredPaths = normalizeDeclaredPaths(declaredPaths, { caseSensitive: false });
  let revision = null;
  let dirty = true;
  let paths = [];
  let statusBytes = Buffer.from('non-git');
  let indexBytes = Buffer.alloc(0);
  let submoduleBytes = Buffer.alloc(0);
  let initialGitState = null;
  try {
    const inside = await capture(spawnImpl, 'git', ['-C', root, 'rev-parse', '--is-inside-work-tree']);
    if (inside.stdout.toString('utf8').trim() !== 'true') throw Object.assign(new Error('not a Git work tree'), { nonGit: true });
    initialGitState = await gitCandidateState(root, spawnImpl);
    assertNoDirtySubmodule(initialGitState);
    revision = initialGitState.revision;
    paths = initialGitState.paths;
    statusBytes = initialGitState.statusBytes;
    indexBytes = initialGitState.indexBytes;
    submoduleBytes = initialGitState.submoduleBytes;
    dirty = statusBytes.length > 0;
  } catch (error) {
    let hasGitMarker = false;
    try { await lstat(resolve(root, '.git')); hasGitMarker = true; } catch (markerError) {
      if (markerError.code !== 'ENOENT') throw markerError;
    }
    if (hasGitMarker && !error.nonGit) throw error;
    paths = (await fallbackFiles(root)).sort();
  }

  const budget = {
    bytes: 0, maxBytes: MAX_HASH_BYTES,
    deadline: Date.now() + HASH_DEADLINE_MS, observed: new Map(),
    rootRealPath: await realpath(root),
  };
  const initialDeclaredState = await collectDeclaredState(root, normalizedDeclaredPaths, budget);
  paths = mergedCandidatePaths(paths, initialDeclaredState);
  budget.declaredEntries = initialDeclaredState.entries;

  const hash = createHash('sha256');
  hash.update('praetorium-candidate-v1\0');
  hash.update(statusBytes);
  hash.update(indexBytes);
  hash.update(submoduleBytes);
  bindDeclaredState(hash, normalizedDeclaredPaths, initialDeclaredState);
  for (const path of paths) await hashFile(hash, root, path, budget);
  await verifyObservedFiles(root, budget.observed, budget.deadline);

  const finalDeclaredState = await collectDeclaredState(root, normalizedDeclaredPaths, budget);
  if (!sameDeclaredState(initialDeclaredState, finalDeclaredState)) {
    throw new Error('Declared candidate paths changed while hashing.');
  }
  if (initialGitState) {
    const finalGitState = await gitCandidateState(root, spawnImpl);
    assertNoDirtySubmodule(finalGitState);
    if (!sameGitCandidateState(initialGitState, finalGitState)) {
      throw new Error('Git candidate metadata changed while hashing.');
    }
  }
  const declaredFileCount = [...initialDeclaredState.entries.values()]
    .filter(entry => ['file', 'symlink', 'missing'].includes(entry.type)).length;
  return {
    schema: 'candidate-snapshot.v1',
    revision,
    digest: `sha256:${hash.digest('hex')}`,
    dirty,
    fileCount: paths.length,
    declaredPaths: normalizedDeclaredPaths,
    declaredPathCount: normalizedDeclaredPaths.length,
    declaredEntryCount: initialDeclaredState.entries.size,
    declaredFileCount,
    declaredBindings: initialDeclaredState.bindings,
    bindingMode: 'declared-paths.v1',
    observedAt: new Date().toISOString(),
  };
}

export const _test = {
  capture, fallbackFiles, hashFile, verifyObservedFiles, gitCandidateState, sameGitCandidateState,
  hasDirtySubmodule, assertNoDirtySubmodule, normalizeDeclaredPaths, collectDeclaredState,
  sameDeclaredState, mergedCandidatePaths,
  MAX_HASH_BYTES, MAX_FILES, HASH_DEADLINE_MS,
};
