import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveWorkerLimit, HermesRuntime, _test } from '../../lib/hermes-runtime.js';

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

  it('strips inherited remote surfaces from Hermes child environments', () => {
    const env = _test.localOnlyEnv({
      PATH: 'safe',
      TELEGRAM_BOT_TOKEN: 'secret',
      GATEWAY_PROXY_URL: 'https://remote.invalid',
      API_SERVER_ENABLED: 'true',
      WHATSAPP_ENABLED: 'true',
    });
    assert.equal(env.PATH, 'safe');
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(env.GATEWAY_PROXY_URL, undefined);
    assert.equal(env.API_SERVER_ENABLED, 'false');
    assert.equal(env.WHATSAPP_ENABLED, 'false');
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
    await runtime.unblockTask(base);
    assert.deepEqual(calls.map(args => args[0]), ['log', 'comment', 'reclaim', 'block', 'unblock']);
    assert.ok(calls[1].includes('Owner'));
  });
});
