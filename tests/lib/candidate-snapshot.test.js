import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  appendFile, lstat, mkdir, mkdtemp, open, readlink, rm, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import { snapshotWindowsCandidate, _test } from '../../lib/candidate-snapshot.js';

const execFileAsync = promisify(execFile);

async function temporaryDirectory(t, label) {
  // Keep child-process cwd inside the checked-out workspace. Managed Windows
  // test sandboxes may allow file I/O in OS temp while denying process spawn.
  const root = await mkdtemp(join(resolve(process.cwd(), '..'), `.praetorium-${label}-`));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true,
  });
  return stdout.trim();
}

async function initializeRepository(t, label = 'candidate') {
  const root = await temporaryDirectory(t, label);
  const repo = join(root, 'repository with spaces');
  await mkdir(repo);
  await execFileAsync('git', ['init', '--quiet', repo], { windowsHide: true });
  await git(repo, 'config', 'user.name', 'Praetorium Test');
  await git(repo, 'config', 'user.email', 'praetorium-test@example.invalid');
  await writeFile(join(repo, 'tracked.txt'), 'tracked-v1\n');
  await git(repo, 'add', '--', 'tracked.txt');
  await git(repo, 'commit', '--quiet', '-m', 'initial candidate');
  return { root, repo };
}

function snapshot(cwd) {
  return snapshotWindowsCandidate({ cwd, spawnImpl: spawn });
}

describe('Windows candidate snapshot', () => {
  it('produces a stable digest for unchanged dirty content and changes it with the content', async t => {
    const { repo } = await initializeRepository(t, 'dirty');
    await writeFile(join(repo, 'tracked.txt'), 'dirty tracked content\n');
    await writeFile(join(repo, 'untracked.txt'), 'stable untracked content\n');

    const first = await snapshot(repo);
    const second = await snapshot(repo);
    assert.equal(first.schema, 'candidate-snapshot.v1');
    assert.equal(first.dirty, true);
    assert.match(first.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(second.digest, first.digest);
    assert.equal(second.revision, first.revision);
    assert.equal(second.fileCount, first.fileCount);

    await writeFile(join(repo, 'untracked.txt'), 'different untracked content\n');
    const changed = await snapshot(repo);
    assert.notEqual(changed.digest, first.digest);
    assert.equal(changed.revision, first.revision);
  });

  it('hashes a symlink target string without reading the external target file', async t => {
    const { root, repo } = await initializeRepository(t, 'symlink');
    const outsideOne = join(root, 'outside-one.txt');
    const outsideTwo = join(root, 'outside-two.txt');
    const link = join(repo, 'external-link.txt');
    await writeFile(outsideOne, 'external secret version one\n');
    await writeFile(outsideTwo, 'external secret version two\n');

    try {
      await symlink('../outside-one.txt', link, 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error.code)) {
        t.skip(`filesystem symlinks are unavailable in this Windows environment (${error.code})`);
        return;
      }
      throw error;
    }

    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readlink(link), '../outside-one.txt');
    const linked = await snapshot(repo);
    await writeFile(outsideOne, 'external content changed but must not be followed\n');
    const targetContentChanged = await snapshot(repo);
    assert.equal(targetContentChanged.digest, linked.digest);

    await unlink(link);
    await symlink('../outside-two.txt', link, 'file');
    const linkTargetChanged = await snapshot(repo);
    assert.notEqual(linkTargetChanged.digest, linked.digest);
  });

  it('rejects a candidate over 512 MiB from file metadata before reading its sparse content', async t => {
    const { repo } = await initializeRepository(t, 'budget');
    const sparse = join(repo, 'oversized-sparse.bin');
    const handle = await open(sparse, 'w');
    try {
      await handle.truncate(_test.MAX_HASH_BYTES + 1);
    } catch (error) {
      if (['ENOSPC', 'EFBIG', 'ENOTSUP'].includes(error.code)) {
        t.skip(`sparse file creation is unavailable (${error.code})`);
        return;
      }
      throw error;
    } finally {
      await handle.close();
    }
    assert.equal((await lstat(sparse)).size, _test.MAX_HASH_BYTES + 1);

    const startedAt = Date.now();
    await assert.rejects(snapshot(repo), /Candidate snapshot file content exceeds 512 MiB/);
    assert.ok(Date.now() - startedAt < 5000, 'size budget should reject before streaming 512 MiB');
  });

  it('includes gitlink/submodule index metadata in the candidate digest', async t => {
    const { repo } = await initializeRepository(t, 'gitlink');
    const firstCommit = await git(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'tracked.txt'), 'tracked-v2\n');
    await git(repo, 'add', '--', 'tracked.txt');
    await git(repo, 'commit', '--quiet', '-m', 'second candidate');
    const secondCommit = await git(repo, 'rev-parse', 'HEAD');
    assert.notEqual(secondCommit, firstCommit);

    await git(repo, 'update-index', '--add', '--cacheinfo', `160000,${firstCommit},vendor/submodule`);
    const firstIndex = await snapshot(repo);
    await git(repo, 'update-index', '--add', '--cacheinfo', `160000,${secondCommit},vendor/submodule`);
    const secondIndex = await snapshot(repo);

    assert.equal(firstIndex.revision, secondCommit);
    assert.equal(secondIndex.revision, secondCommit);
    assert.equal(firstIndex.fileCount, secondIndex.fileCount);
    assert.notEqual(secondIndex.digest, firstIndex.digest);
  });

  it('fails closed when an initialized submodule has opaque dirty content', () => {
    const cleanDifferentCommit = Buffer.from('1 .M SC.. 160000 160000 160000 a b vendor/submodule\0');
    const dirtyTracked = Buffer.from('1 .M S.M. 160000 160000 160000 a b vendor/submodule\0');
    const dirtyUntracked = Buffer.from('1 .M S..U 160000 160000 160000 a b vendor/submodule\0');

    assert.equal(_test.hasDirtySubmodule(cleanDifferentCommit), false);
    assert.equal(_test.hasDirtySubmodule(dirtyTracked), true);
    assert.equal(_test.hasDirtySubmodule(dirtyUntracked), true);
    assert.throws(
      () => _test.assertNoDirtySubmodule({ statusBytes: dirtyTracked }),
      /refuses a dirty initialized submodule/,
    );
  });

  it('rejects paths that escape the candidate root', async t => {
    const root = await temporaryDirectory(t, 'unsafe-path');
    const outside = resolve(root, '..', 'outside-candidate.txt');
    const unsafeRelative = relative(root, outside);
    const budget = {
      bytes: 0,
      maxBytes: _test.MAX_HASH_BYTES,
      deadline: Date.now() + _test.HASH_DEADLINE_MS,
    };
    await assert.rejects(
      _test.hashFile(createHash('sha256'), root, unsafeRelative, budget),
      /Unsafe candidate path/,
    );
  });

  it('detects a file that changes while its content is being hashed', async t => {
    const root = await temporaryDirectory(t, 'changing-file');
    const relativePath = 'changing.bin';
    const file = join(root, relativePath);
    await writeFile(file, Buffer.alloc(64 * 1024 * 1024, 0x61));
    const budget = {
      bytes: 0,
      maxBytes: _test.MAX_HASH_BYTES,
      deadline: Date.now() + _test.HASH_DEADLINE_MS,
    };
    let mutationError = null;
    const mutator = setInterval(() => {
      appendFile(file, Buffer.from([0x62])).catch(error => { mutationError ||= error; });
    }, 1);
    try {
      await assert.rejects(
        _test.hashFile(createHash('sha256'), root, relativePath, budget),
        /Candidate file changed while hashing/,
      );
      if (mutationError) throw mutationError;
    } finally {
      clearInterval(mutator);
    }
  });

  it('rejects a Git candidate whose tracked/untracked metadata changes across the snapshot', async t => {
    const { repo } = await initializeRepository(t, 'metadata-race');
    let statusCalls = 0;
    const racingSpawn = (command, args, options) => {
      if (command === 'git' && args[2] === 'status' && ++statusCalls === 2) {
        writeFileSync(join(repo, 'appeared-during-snapshot.txt'), 'late candidate content\n');
      }
      return spawn(command, args, options);
    };

    await assert.rejects(
      snapshotWindowsCandidate({ cwd: repo, spawnImpl: racingSpawn }),
      /Git candidate metadata changed while hashing/,
    );
  });
});
