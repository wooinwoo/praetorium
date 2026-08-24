import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, readdir } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_HASH_BYTES = 512 * 1024 * 1024;
const HASH_DEADLINE_MS = 30000;
const EXCLUDED_FALLBACK_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.next']);

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

async function fallbackFiles(root, directory = root, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_FALLBACK_DIRS.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await fallbackFiles(root, path, files);
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(relative(root, path).replaceAll(sep, '/'));
    if (files.length > 20000) throw new Error('Candidate snapshot exceeds 20000 files.');
  }
  return files;
}

async function hashFile(hash, root, relativePath, budget) {
  if (Date.now() > budget.deadline) throw new Error('Candidate snapshot hashing exceeded its 30 second deadline.');
  const absolute = resolve(root, relativePath);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith('..') || resolve(root, rel) !== absolute) throw new Error(`Unsafe candidate path: ${relativePath}`);
  hash.update(`path\0${relativePath.replaceAll('\\', '/')}\0`);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      hash.update(`symlink\0${target}\0`);
      const after = await lstat(absolute);
      const afterTarget = await readlink(absolute);
      if (!after.isSymbolicLink() || afterTarget !== target
        || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
        throw new Error(`Candidate symlink changed while hashing: ${relativePath}`);
      }
      budget.observed?.set(relativePath, {
        type: 'symlink', target, size: after.size, mtimeMs: after.mtimeMs,
        ctimeMs: after.ctimeMs, ino: after.ino, dev: after.dev,
      });
      return;
    }
    if (!info.isFile()) {
      hash.update(`not-file\0${info.mode}\0`);
      budget.observed?.set(relativePath, {
        type: 'other', mode: info.mode, size: info.size, mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs, ino: info.ino, dev: info.dev,
      });
      return;
    }
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
    if (!after.isFile() || after.size !== info.size || after.mtimeMs !== info.mtimeMs
      || after.ctimeMs !== info.ctimeMs || after.ino !== info.ino || after.dev !== info.dev) {
      throw new Error(`Candidate file changed while hashing: ${relativePath}`);
    }
    budget.observed?.set(relativePath, {
      type: 'file', size: after.size, mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs, ino: after.ino, dev: after.dev,
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      hash.update('missing\0');
      budget.observed?.set(relativePath, { type: 'missing' });
    }
    else throw error;
  }
}

function sameFileIdentity(info, observed) {
  return info.size === observed.size && info.mtimeMs === observed.mtimeMs
    && info.ctimeMs === observed.ctimeMs && info.ino === observed.ino && info.dev === observed.dev;
}

async function verifyObservedFiles(root, observed, deadline) {
  for (const [relativePath, expected] of observed) {
    if (Date.now() > deadline) throw new Error('Candidate snapshot hashing exceeded its 30 second deadline.');
    const absolute = resolve(root, relativePath);
    try {
      const info = await lstat(absolute);
      if (expected.type === 'missing') throw new Error(`Candidate path appeared while hashing: ${relativePath}`);
      if (expected.type === 'file' && (!info.isFile() || !sameFileIdentity(info, expected))) {
        throw new Error(`Candidate file changed while hashing: ${relativePath}`);
      }
      if (expected.type === 'symlink') {
        const target = info.isSymbolicLink() ? await readlink(absolute) : null;
        if (!info.isSymbolicLink() || target !== expected.target || !sameFileIdentity(info, expected)) {
          throw new Error(`Candidate symlink changed while hashing: ${relativePath}`);
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

export async function snapshotWindowsCandidate({ cwd, spawnImpl }) {
  const root = resolve(cwd);
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
  const hash = createHash('sha256');
  hash.update('praetorium-candidate-v1\0');
  hash.update(statusBytes);
  hash.update(indexBytes);
  hash.update(submoduleBytes);
  const budget = {
    bytes: 0, maxBytes: MAX_HASH_BYTES,
    deadline: Date.now() + HASH_DEADLINE_MS, observed: new Map(),
  };
  for (const path of paths) await hashFile(hash, root, path, budget);
  await verifyObservedFiles(root, budget.observed, budget.deadline);
  if (initialGitState) {
    const finalGitState = await gitCandidateState(root, spawnImpl);
    assertNoDirtySubmodule(finalGitState);
    if (!sameGitCandidateState(initialGitState, finalGitState)) {
      throw new Error('Git candidate metadata changed while hashing.');
    }
  }
  return {
    schema: 'candidate-snapshot.v1',
    revision,
    digest: `sha256:${hash.digest('hex')}`,
    dirty,
    fileCount: paths.length,
    observedAt: new Date().toISOString(),
  };
}

export const _test = {
  capture, fallbackFiles, hashFile, verifyObservedFiles, gitCandidateState, sameGitCandidateState,
  hasDirtySubmodule, assertNoDirtySubmodule,
  MAX_HASH_BYTES, HASH_DEADLINE_MS,
};
