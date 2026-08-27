import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireProcessLease, adaptiveWorkerLimit, HermesRuntime, _test } from '../../lib/hermes-runtime.js';

describe('HermesRuntime helpers', () => {
  it('extracts the last JSON line from Hermes output', () => {
    assert.deepEqual(_test.parseLastJson('notice\n{"ok":true,"spawned":2}\n'), { ok: true, spawned: 2 });
  });

  it('extracts a durable Hermes session ID without leaking it into chat output', () => {
    assert.deepEqual(
      _test.parseChatOutput('session_id: 20260822_171703_6cf842\nPROJECT_READY\n'),
      { sessionId: '20260822_171703_6cf842', output: 'PROJECT_READY' },
    );
    assert.deepEqual(
      _test.parseChatOutput('OWNER_CONSOLE_READY\nSESSION_ID=93890\n'),
      { sessionId: '93890', output: 'OWNER_CONSOLE_READY' },
    );
  });

  it('rejects identifiers that could become CLI option injection', () => {
    assert.throws(() => _test.assertSafeId('--profile', 'profile'), /Invalid profile/);
    assert.doesNotThrow(() => _test.assertSafeId('project-director-1', 'profile'));
  });

  it('converts local attachment paths into absolute WSL-readable paths without shell interpolation', async () => {
    const conversions = [];
    const runtime = new HermesRuntime({
      wslRuntime: {
        toWslPath: async (distro, path) => {
          conversions.push({ distro, path });
          return '/mnt/c/Users/Owner/PraetoriumData/attachments/screen.png';
        },
      },
    });
    const source = 'C:\\Users\\Owner\\PraetoriumData\\attachments\\screen.png';
    assert.equal(await runtime.resolveReadOnlyPath({
      path: source, target: { kind: 'wsl', distro: 'Ubuntu-24.04' },
    }), '/mnt/c/Users/Owner/PraetoriumData/attachments/screen.png');
    assert.deepEqual(conversions, [{ distro: 'Ubuntu-24.04', path: source }]);
    await assert.rejects(
      runtime.resolveReadOnlyPath({ path: '..\\screen.png', target: { kind: 'windows' } }),
      /must be absolute/,
    );
  });

  it('adapts parallelism to ready work and available resources', () => {
    assert.equal(adaptiveWorkerLimit({ ready: 0, cpuCount: 16, memoryBytes: 64 * 1024 ** 3 }), 0);
    assert.equal(adaptiveWorkerLimit({ ready: 20, running: 0, cpuCount: 8, memoryBytes: 64 * 1024 ** 3 }), 6);
    assert.equal(adaptiveWorkerLimit({ ready: 20, running: 5, cpuCount: 8, memoryBytes: 64 * 1024 ** 3 }), 1);
    assert.equal(adaptiveWorkerLimit({ ready: 20, running: 20, cpuCount: 8, memoryBytes: 64 * 1024 ** 3 }), 0);
  });

  it('allows a zero-spawn dispatch pass for orphan reconciliation', async () => {
    const runtime = new HermesRuntime();
    runtime.kanban = async options => options;
    const result = await runtime.dispatch({
      profile: 'project-director-1', board: 'project-1', cwd: 'C:\\projects\\one', max: 0,
    });
    assert.deepEqual(result.args.slice(-3), ['--max', '0', '--json']);
  });

  it('caches and single-flights runtime diagnostics until a forced refresh', async () => {
    const runtime = new HermesRuntime();
    let probes = 0;
    const forces = [];
    let releaseFirstProbe;
    const firstProbe = new Promise(resolve => { releaseFirstProbe = resolve; });
    runtime._describeTargetsFresh = async ({ force }) => {
      probes += 1;
      forces.push(force);
      if (probes === 1) await firstProbe;
      return { targets: [{ id: 'windows', probe: probes }], wslAvailable: false, wslError: null };
    };

    const first = runtime.describeTargets();
    const concurrent = runtime.describeTargets();
    const forcedDuringProbe = runtime.describeTargets({ force: true });
    assert.equal(probes, 1);
    releaseFirstProbe();
    const [firstResult, concurrentResult, forcedResult] = await Promise.all([first, concurrent, forcedDuringProbe]);
    assert.deepEqual(firstResult, concurrentResult);
    assert.notEqual(firstResult, concurrentResult, 'callers must not share a mutable response object');
    assert.deepEqual(forces, [false, true]);
    assert.equal(forcedResult.targets[0].probe, 2);

    const cached = await runtime.describeTargets();
    assert.equal(probes, 2);
    assert.equal(cached.targets[0].probe, 2);

    const refreshed = await runtime.describeTargets({ force: true });
    assert.equal(probes, 3);
    assert.equal(refreshed.targets[0].probe, 3);
  });

  it('forwards declared candidate deliverables across the WSL runtime boundary', async () => {
    let received = null;
    const expected = { schema: 'candidate-snapshot.v1', digest: `sha256:${'a'.repeat(64)}` };
    const runtime = new HermesRuntime({
      wslRuntime: {
        candidateSnapshot: async options => {
          received = options;
          return expected;
        },
      },
    });
    const result = await runtime.candidateSnapshot({
      cwd: '/home/owner/app', target: { kind: 'wsl', distro: 'Ubuntu' },
      declaredPaths: ['dist/app.js', 'reports/review.json'],
    });

    assert.equal(result, expected);
    assert.deepEqual(received, {
      distro: 'Ubuntu', path: '/home/owner/app',
      declaredPaths: ['dist/app.js', 'reports/review.json'],
    });
  });

  it('strips inherited remote surfaces and ambient credentials while preserving runtime essentials', () => {
    const env = _test.localOnlyEnv({
      PATH: 'safe',
      HOME: 'C:\\Users\\owner',
      LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local',
      CODEX_HOME: 'C:\\Users\\owner\\.codex',
      HERMES_HOME: 'C:\\Users\\owner\\.hermes',
      TELEGRAM_BOT_TOKEN: 'secret',
      GATEWAY_PROXY_URL: 'https://remote.invalid',
      GITHUB_TOKEN: 'github-secret',
      GH_TOKEN: 'gh-secret',
      AWS_REGION: 'ap-northeast-2',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      NPM_TOKEN: 'npm-secret',
      OPENAI_API_KEY: 'openai-secret',
      DATABASE_URL: 'postgres://secret',
      API_SERVER_ENABLED: 'true',
      WHATSAPP_ENABLED: 'true',
    });
    assert.equal(env.PATH, 'safe');
    assert.equal(env.HOME, 'C:\\Users\\owner');
    assert.equal(env.LOCALAPPDATA, 'C:\\Users\\owner\\AppData\\Local');
    assert.equal(env.CODEX_HOME, 'C:\\Users\\owner\\.codex');
    assert.equal(env.HERMES_HOME, 'C:\\Users\\owner\\.hermes');
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(env.GATEWAY_PROXY_URL, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.AWS_REGION, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.NPM_TOKEN, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.API_SERVER_ENABLED, 'false');
    assert.equal(env.WHATSAPP_ENABLED, 'false');
  });

  it('holds one atomic process lease, recovers a stale PID, and releases only its own token', () => {
    const directory = mkdtempSync(join(tmpdir(), 'praetorium-lease-'));
    const leaseFile = join(directory, 'server.lease');
    const alive = new Set([101]);
    const first = acquireProcessLease({ leaseFile, pid: 101, isAlive: pid => alive.has(Number(pid)) });
    assert.throws(
      () => acquireProcessLease({ leaseFile, pid: 202, isAlive: pid => alive.has(Number(pid)) }),
      error => error?.code === 'PRAETORIUM_LEASE_HELD',
    );
    assert.equal(JSON.parse(readFileSync(leaseFile, 'utf8')).token, first.owner.token);

    alive.delete(101);
    alive.add(202);
    const recovered = acquireProcessLease({ leaseFile, pid: 202, isAlive: pid => alive.has(Number(pid)) });
    assert.equal(recovered.recovered.pid, 101);
    assert.equal(first.release(), false, 'the stale owner must not unlink its replacement');
    assert.equal(JSON.parse(readFileSync(leaseFile, 'utf8')).token, recovered.owner.token);
    assert.equal(recovered.release(), true);
    assert.equal(recovered.release(), false);
  });

  it('distinguishes a reused live PID by process creation identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'praetorium-pid-reuse-'));
    const leaseFile = join(directory, 'server.lease');
    const identities = new Map([[515, 'windows-start-ticks:100']]);
    const options = {
      leaseFile,
      pid: 515,
      isAlive: candidate => Number(candidate) === 515,
      getIdentity: candidate => identities.get(Number(candidate)) || null,
    };
    const first = acquireProcessLease(options);
    assert.equal(first.owner.processIdentity, 'windows-start-ticks:100');

    identities.set(515, 'windows-start-ticks:200');
    const replacement = acquireProcessLease(options);
    assert.equal(replacement.recovered.token, first.owner.token);
    assert.equal(replacement.owner.processIdentity, 'windows-start-ticks:200');
    assert.equal(first.release(), false, 'the old PID generation must not release the replacement');
    assert.equal(replacement.release(), true);
  });

  it('recovers a legacy v2.1 lease when its live PID was created after the lease', () => {
    const directory = mkdtempSync(join(tmpdir(), 'praetorium-legacy-pid-reuse-'));
    const leaseFile = join(directory, 'server.lease');
    const legacyCreatedAt = '2026-01-01T00:00:00.000Z';
    const toWindowsTicks = iso => (
      (BigInt(Date.parse(iso)) * 10000n) + 621355968000000000n
    ).toString();
    writeFileSync(leaseFile, `${JSON.stringify({
      schema: 'praetorium-process-lease.v1', kind: 'server', pid: 616,
      token: 'legacy-owner', createdAt: legacyCreatedAt,
    })}\n`, 'utf8');
    const starts = new Map([
      [616, `windows-start-ticks:${toWindowsTicks('2026-01-01T00:01:00.000Z')}`],
      [717, `windows-start-ticks:${toWindowsTicks('2025-12-31T23:59:00.000Z')}`],
    ]);
    const lease = acquireProcessLease({
      leaseFile,
      pid: 717,
      isAlive: candidate => starts.has(Number(candidate)),
      getIdentity: candidate => starts.get(Number(candidate)) || null,
    });
    assert.equal(lease.recovered.token, 'legacy-owner');
    assert.equal(lease.release(), true);
  });

  it('keeps a legacy v2.1 lease fail-closed when the PID predates its lease', () => {
    const owner = {
      schema: 'praetorium-process-lease.v1', kind: 'server', pid: 818,
      token: 'legacy-live-owner', createdAt: '2026-01-01T00:01:00.000Z',
    };
    const startTicks = (
      (BigInt(Date.parse('2026-01-01T00:00:00.000Z')) * 10000n) + 621355968000000000n
    ).toString();
    assert.equal(_test.ownerIsAlive(owner, {
      isAlive: () => true,
      getIdentity: () => `windows-start-ticks:${startTicks}`,
    }), true);
  });

  it('linearizes competing stale-guard recoveries without unlinking either owner record', () => {
    const directory = mkdtempSync(join(tmpdir(), 'praetorium-guard-journal-'));
    const guardFile = join(directory, 'server.lease.guard');
    const base = {
      schema: 'praetorium-process-lease.v1', kind: 'guard', op: 'claim',
      pid: 601, token: 'stale-owner', expectedToken: null,
    };
    _test.appendGuardRecord(guardFile, base);
    _test.appendGuardRecord(guardFile, {
      ...base, pid: 602, token: 'recovery-winner', expectedToken: 'stale-owner',
    });
    _test.appendGuardRecord(guardFile, {
      ...base, pid: 603, token: 'recovery-loser', expectedToken: 'stale-owner',
    });

    const journal = _test.readGuardJournal(guardFile);
    assert.equal(journal.active.token, 'recovery-winner');
    assert.deepEqual(
      journal.records.map(record => record.token),
      ['stale-owner', 'recovery-winner', 'recovery-loser'],
    );
    const raw = readFileSync(guardFile, 'utf8');
    assert.match(raw, /stale-owner/);
    assert.match(raw, /recovery-winner/);
    assert.match(raw, /recovery-loser/);
  });

  it('allows exactly one contender to win a concurrent stale-lease recovery', { timeout: 15000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'praetorium-concurrent-recovery-'));
    const leaseFile = join(directory, 'server.lease');
    writeFileSync(leaseFile, `${JSON.stringify({
      schema: 'praetorium-process-lease.v1', kind: 'server',
      pid: 2147480000, token: 'dead-server', createdAt: new Date(0).toISOString(),
    })}\n`, 'utf8');
    const runtimeUrl = new URL('../../lib/hermes-runtime.js', import.meta.url).href;
    const contender = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { acquireProcessLease } = await import(workerData.runtimeUrl);
        try {
          const lease = acquireProcessLease({
            leaseFile: workerData.leaseFile,
            pid: workerData.pid,
            isAlive: candidate => workerData.livePids.includes(Number(candidate)),
            getIdentity: candidate => 'thread-start:' + Number(candidate),
          });
          parentPort.postMessage('ACQUIRED');
          setTimeout(() => { lease.release(); process.exit(0); }, 400);
        } catch (error) {
          parentPort.postMessage(String(error.code || 'ERROR'));
        }
      })().catch(error => { throw error; });
    `;
    const run = pid => new Promise((resolve, reject) => {
      const worker = new Worker(contender, {
        eval: true,
        workerData: { runtimeUrl, leaseFile, pid, livePids: [901, 902] },
      });
      worker.once('message', resolve);
      worker.once('error', reject);
    });

    const results = await Promise.all([run(901), run(902)]);
    assert.equal(results.filter(result => result === 'ACQUIRED').length, 1, JSON.stringify(results));
    assert.equal(results.filter(result => result === 'PRAETORIUM_LEASE_HELD').length, 1, JSON.stringify(results));
  });

  it('acquires the server lease before constructing the durable Director service', () => {
    const source = readFileSync(join(process.cwd(), 'server.js'), 'utf8');
    const lease = source.indexOf('acquireProcessLease({ leaseFile:');
    const stateRecovery = source.indexOf('new DirectorService({');
    assert.ok(lease >= 0 && stateRecovery >= 0 && lease < stateRecovery);
  });

  it('recovers an incomplete stale lease document under the guard', () => {
    const directory = mkdtempSync(join(tmpdir(), 'praetorium-corrupt-lease-'));
    const leaseFile = join(directory, 'server.lease');
    writeFileSync(leaseFile, '{"schema":', 'utf8');
    const lease = acquireProcessLease({ leaseFile, pid: 303, isAlive: () => false });
    assert.equal(lease.recovered.corrupt, true);
    assert.equal(JSON.parse(readFileSync(leaseFile, 'utf8')).pid, 303);
    assert.equal(lease.release(), true);
  });

  it('fails closed instead of racing recovery through a corrupt guard', () => {
    const directory = mkdtempSync(join(tmpdir(), 'praetorium-corrupt-guard-'));
    const leaseFile = join(directory, 'server.lease');
    writeFileSync(`${leaseFile}.guard`, '{"schema":', 'utf8');
    assert.throws(
      () => acquireProcessLease({ leaseFile, pid: 404, isAlive: () => false }),
      error => error?.code === 'PRAETORIUM_LEASE_GUARD_CORRUPT',
    );
  });

  it('derives the narrow Hermes data root used for board sandbox access', () => {
    assert.equal(
      _test.hermesRootFromExecutable('C:\\Users\\owner\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe'),
      'C:\\Users\\owner\\AppData\\Local\\hermes',
    );
    assert.equal(
      _test.hermesRootFromExecutable('C:\\Users\\owner\\AppData\\Local\\hermes\\hermes-agent\\bin\\hermes.exe'),
      'C:\\Users\\owner\\AppData\\Local\\hermes',
    );
  });

  it('rejects a zero-exit Hermes turn that produced no Director answer', async () => {
    const fakeChild = new (await import('node:events')).EventEmitter();
    fakeChild.stdout = new (await import('node:stream')).PassThrough();
    fakeChild.stderr = new (await import('node:stream')).PassThrough();
    fakeChild.stdin = new (await import('node:stream')).PassThrough();
    fakeChild.kill = () => {};
    const { HermesRuntime } = await import('../../lib/hermes-runtime.js');
    const runtime = new HermesRuntime({ spawnImpl: () => {
      queueMicrotask(() => fakeChild.emit('close', 0, null));
      return fakeChild;
    } });
    await assert.rejects(
      runtime.chat({ profile: 'project-director-1', cwd: 'C:\\projects\\alpha', board: 'alpha', prompt: 'work' }),
      /returned no output/,
    );
  });

  it('settles from process exit when inherited stdio prevents close', async () => {
    const fakeChild = new (await import('node:events')).EventEmitter();
    fakeChild.stdout = new (await import('node:stream')).PassThrough();
    fakeChild.stderr = new (await import('node:stream')).PassThrough();
    fakeChild.stdin = new (await import('node:stream')).PassThrough();
    fakeChild.kill = () => {};
    const runtime = new HermesRuntime({ spawnImpl: () => {
      queueMicrotask(() => {
        fakeChild.stdout.write('finished');
        fakeChild.emit('exit', 0, null);
      });
      return fakeChild;
    } });
    const result = await runtime.run(['--version']);
    assert.equal(result.stdout, 'finished');
  });

  it('pins the nested Codex app-server thread to the selected project', async () => {
    const fakeChild = new (await import('node:events')).EventEmitter();
    fakeChild.stdout = new (await import('node:stream')).PassThrough();
    fakeChild.stderr = new (await import('node:stream')).PassThrough();
    fakeChild.stdin = new (await import('node:stream')).PassThrough();
    fakeChild.kill = () => {};
    let spawnOptions;
    const { HermesRuntime } = await import('../../lib/hermes-runtime.js');
    const runtime = new HermesRuntime({
      hermesBin: 'C:\\Users\\owner\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe',
      spawnImpl: (_command, _args, options) => {
        spawnOptions = options;
        queueMicrotask(() => fakeChild.emit('close', 0, null));
        return fakeChild;
      },
    });

    await runtime.run(['--version'], { cwd: 'C:\\projects\\alpha', board: 'alpha' });

    assert.equal(spawnOptions.cwd, 'C:\\projects\\alpha');
    assert.equal(spawnOptions.env.TERMINAL_CWD, 'C:\\projects\\alpha');
    assert.equal(spawnOptions.env.PRAETORIUM_PROJECT_CWD, 'C:\\projects\\alpha');
  });

  it('marks Director chats for the structural read-only runtime bridge', async () => {
    const fakeChild = new (await import('node:events')).EventEmitter();
    fakeChild.stdout = new (await import('node:stream')).PassThrough();
    fakeChild.stderr = new (await import('node:stream')).PassThrough();
    fakeChild.stdin = new (await import('node:stream')).PassThrough();
    fakeChild.kill = () => {};
    let spawnOptions;
    const runtime = new HermesRuntime({
      hermesBin: 'C:\\Users\\owner\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe',
      spawnImpl: (_command, _args, options) => {
        spawnOptions = options;
        queueMicrotask(() => {
          fakeChild.stdout.write('answer');
          fakeChild.emit('close', 0, null);
        });
        return fakeChild;
      },
    });
    await runtime.chat({ profile: 'project-director-1', cwd: 'C:\\projects\\alpha', board: 'alpha', prompt: 'status?' });
    assert.equal(spawnOptions.env.PRAETORIUM_DIRECTOR_MODE, 'true');
  });

  it('creates dependency-bound worker tasks with approved skills', async () => {
    const runtime = new HermesRuntime();
    runtime.kanban = async options => options;
    const result = await runtime.createTask({
      profile: 'project-director-1', board: 'alpha', cwd: 'C:\\projects\\alpha',
      title: 'Review change', body: 'review it', assignee: 'adversarial-reviewer',
      skills: ['adversarial-review'], parents: ['t_parent'], idempotencyKey: 'run-action',
    });
    assert.ok(result.args.includes('adversarial-reviewer'));
    assert.ok(result.args.includes('adversarial-review'));
    assert.ok(result.args.includes('t_parent'));
    assert.ok(result.args.includes('run-action'));
  });

  it('loads structured worker evidence for the task inspector', async () => {
    const runtime = new HermesRuntime();
    runtime.kanban = async options => ({ ...options, json: { task: { id: 't_one' }, events: [] } });
    const result = await runtime.taskDetails({
      profile: 'project-director-1', board: 'alpha', cwd: 'C:\\projects\\alpha', taskId: 't_one',
    });
    assert.equal(result.task.id, 't_one');
    await assert.rejects(
      runtime.taskDetails({ profile: 'project-director-1', board: 'alpha', cwd: 'C:\\projects\\alpha', taskId: '--help' }),
      /Invalid task/,
    );
  });

  it('exposes live logs and Owner intervention commands', async () => {
    const runtime = new HermesRuntime();
    const calls = [];
    runtime.kanban = async options => {
      calls.push(options.args);
      return { stdout: options.args[0] === 'log' ? 'worker trace' : 'ok' };
    };
    const base = { profile: 'project-director-1', board: 'alpha', cwd: 'C:\\projects\\alpha', taskId: 't_one' };
    assert.equal(await runtime.taskLog(base), 'worker trace');
    await runtime.commentTask({ ...base, message: 'check the parser', author: 'Owner' });
    await runtime.reclaimTask({ ...base, reason: 'pause' });
    await runtime.blockTask({ ...base, reason: 'pause' });
    await runtime.scheduleTask({ ...base, reason: 'owner pause' });
    await runtime.unblockTask(base);
    assert.deepEqual(calls.map(args => args[0]), ['log', 'comment', 'reclaim', 'block', 'schedule', 'unblock']);
    assert.ok(calls[1].includes('Owner'));
  });
});
