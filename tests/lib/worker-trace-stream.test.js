import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { describe, it } from 'node:test';
import { HermesRuntime } from '../../lib/hermes-runtime.js';
import { WorkerTraceStream, _test } from '../../lib/worker-trace-stream.js';

class FakeRequest extends EventEmitter {
  constructor() {
    super();
    this.aborted = false;
    this.destroyed = false;
    this.socket = { setTimeout() {}, setNoDelay() {} };
  }
}

class FakeResponse extends EventEmitter {
  constructor(writeResults = []) {
    super();
    this.frames = [];
    this.writeResults = [...writeResults];
    this.destroyed = false;
    this.writableEnded = false;
  }
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  flushHeaders() {}
  write(frame) {
    const text = String(frame);
    this.frames.push(text);
    this.emit('frame', text);
    return this.writeResults.length ? this.writeResults.shift() : true;
  }
  end() { this.writableEnded = true; }
}

describe('Worker trace stream', () => {
  it('derives only the managed board Worker log path on Windows', () => {
    const runtime = new HermesRuntime({ hermesBin: 'C:\\runtime\\hermes-agent\\bin\\hermes.exe' });
    assert.equal(
      runtime.taskLogPath({ board: 'project-one', taskId: 't_one', target: { kind: 'windows' } }),
      win32.normalize('C:\\runtime\\kanban\\boards\\project-one\\logs\\t_one.log'),
    );
    assert.equal(
      runtime.taskLogPath({ board: 'default', taskId: 't_one', target: { kind: 'windows' } }),
      win32.normalize('C:\\runtime\\kanban\\logs\\t_one.log'),
    );
    assert.equal(runtime.taskLogPath({ board: 'project-one', taskId: 't_one', target: { kind: 'wsl', distro: 'Ubuntu' } }), null);
    assert.throws(() => runtime.taskLogPath({ board: '../other', taskId: 't_one' }), /Invalid board/);
    assert.throws(() => runtime.taskLogPath({ board: 'project-one', taskId: '../secret' }), /Invalid task/);
  });

  it('reads a bounded tail and identifies reset boundaries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'praetorium-trace-'));
    const path = join(root, 'worker.log');
    try {
      writeFileSync(path, 'abcdef', 'utf8');
      const tail = await _test.readTail(path, 3);
      assert.equal(tail.exists, true);
      assert.equal(tail.size, 6);
      assert.equal(tail.start, 3);
      assert.equal(tail.text, 'def');
      assert.equal(tail.bytes.toString('utf8'), 'def');
      assert.equal(_test.commonPrefixLength('abc-old', 'abc-new'), 4);
      assert.throws(() => _test.assertIdentifier('../task', 'task id'), /Invalid task id/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('streams a snapshot and append without exposing an input channel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'praetorium-stream-'));
    const path = join(root, 'logs', 't_one.log');
    mkdirSync(join(root, 'logs'), { recursive: true });
    writeFileSync(path, 'PLAN: inspect\n', 'utf8');
    const service = {
      getDirector: id => id === 'director-one'
        ? { id, cwd: root, board: 'board-one', runtime: 'windows' }
        : null,
      getTaskDetails: async (_directorId, taskId) => ({ task: { id: taskId } }),
      getTaskTrace: async () => ({ log: '', availability: 'available' }),
    };
    const runtime = { taskLogPath: () => path };
    const stream = new WorkerTraceStream({ service, runtime, heartbeatMs: 60000 });
    const req = new FakeRequest();
    const res = new FakeResponse();
    try {
      const client = await stream.open(req, res, { directorId: 'director-one', taskId: 't_one' });
      assert.equal(res.status, 200);
      assert.match(res.headers['Content-Type'], /text\/event-stream/);
      assert.match(res.frames.join(''), /event: snapshot/);
      assert.match(res.frames.join(''), /PLAN: inspect/);
      assert.equal('stdin' in client, false);
      assert.equal('writeInput' in stream, false);

      appendFileSync(path, 'OBSERVED: file\n', 'utf8');
      await stream._refreshFile(client);
      assert.match(res.frames.join(''), /event: append/);
      assert.match(res.frames.join(''), /OBSERVED: file/);

      const utf8 = Buffer.from('한', 'utf8');
      appendFileSync(path, utf8.subarray(0, 2));
      await stream._refreshFile(client);
      appendFileSync(path, utf8.subarray(2));
      await stream._refreshFile(client);
      assert.match(res.frames.join(''), /한/);

      renameSync(path, `${path}.1`);
      writeFileSync(path, 'PLAN: rotated\n', 'utf8');
      await stream._refreshFile(client);
      assert.match(res.frames.at(-1), /event: reset/);
      assert.match(res.frames.at(-1), /PLAN: rotated/);
    } finally {
      stream.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts ownership checks against connection limits so concurrent opens cannot exceed the cap', async () => {
    let releaseOwnership;
    const ownership = new Promise(resolve => { releaseOwnership = resolve; });
    let ownershipChecks = 0;
    const service = {
      getDirector: id => ({ id, cwd: 'C:\\projects\\one', board: 'board-one', runtime: 'windows' }),
      getTaskDetails: async (_directorId, taskId) => {
        ownershipChecks += 1;
        await ownership;
        return { task: { id: taskId } };
      },
      getTaskTrace: async () => ({ log: '', availability: 'not_started' }),
    };
    const stream = new WorkerTraceStream({
      service,
      runtime: { taskLogPath: () => null },
      maxClients: 1,
      maxClientsPerDirector: 1,
      heartbeatMs: 60000,
    });
    const first = stream.open(new FakeRequest(), new FakeResponse(), {
      directorId: 'director-one', taskId: 't_one',
    });
    await Promise.resolve();

    await assert.rejects(
      stream.open(new FakeRequest(), new FakeResponse(), {
        directorId: 'director-one', taskId: 't_two',
      }),
      error => error.statusCode === 429,
    );
    assert.equal(ownershipChecks, 1, 'the rejected connection must not start another board lookup');

    releaseOwnership();
    await first;
    assert.equal(stream.clientCount, 1);
    stream.close();
  });

  it('does not activate a pending connection after shutdown begins', async () => {
    let releaseOwnership;
    const ownership = new Promise(resolve => { releaseOwnership = resolve; });
    let ownershipStarted;
    const started = new Promise(resolve => { ownershipStarted = resolve; });
    const service = {
      getDirector: id => ({ id, cwd: 'C:\\projects\\one', board: 'board-one', runtime: 'windows' }),
      getTaskDetails: async (_directorId, taskId) => {
        ownershipStarted();
        await ownership;
        return { task: { id: taskId } };
      },
      getTaskTrace: async () => ({ log: '', availability: 'not_started' }),
    };
    const stream = new WorkerTraceStream({
      service,
      runtime: { taskLogPath: () => null },
      heartbeatMs: 60000,
    });
    const res = new FakeResponse();
    const opening = stream.open(new FakeRequest(), res, {
      directorId: 'director-one', taskId: 't_one',
    });
    await started;
    stream.close();
    releaseOwnership();

    await assert.rejects(opening, error => error.statusCode === 503);
    assert.equal(stream.clientCount, 0);
    assert.equal(stream.pendingClients, 0);
    assert.equal(res.status, undefined, 'shutdown must win before SSE headers are committed');
  });

  it('drops incremental frames under backpressure and resynchronizes with one bounded reset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'praetorium-backpressure-'));
    const path = join(root, 'worker.log');
    writeFileSync(path, 'PLAN: initial\n', 'utf8');
    const service = {
      getDirector: id => ({ id, cwd: root, board: 'board-one', runtime: 'windows' }),
      getTaskDetails: async (_directorId, taskId) => ({ task: { id: taskId } }),
      getTaskTrace: async () => ({ log: '', availability: 'available' }),
    };
    const stream = new WorkerTraceStream({
      service,
      runtime: { taskLogPath: () => path },
      heartbeatMs: 60000,
    });
    const res = new FakeResponse();
    try {
      const client = await stream.open(new FakeRequest(), res, {
        directorId: 'director-one', taskId: 't_one',
      });
      res.writeResults.push(false);
      appendFileSync(path, 'OBSERVED: first\n', 'utf8');
      await stream._refreshFile(client);
      assert.equal(client.blocked, true);
      assert.equal(client.needsResync, false, 'the accepted append itself was not dropped');

      appendFileSync(path, 'VERIFY: second\n', 'utf8');
      await stream._refreshFile(client);
      assert.equal(client.needsResync, true, 'a later append attempt while blocked requires one resync');
      let resetCount = 0;
      const reset = new Promise(resolve => {
        const onFrame = frame => {
          if (!frame.includes('event: reset')) return;
          resetCount += 1;
          res.off('frame', onFrame);
          resolve(frame);
        };
        res.on('frame', onFrame);
      });
      // A recovery snapshot can also exceed the response high-water mark. It
      // was accepted, so its own drain must not schedule the same reset again.
      res.writeResults.push(false);
      res.emit('drain');
      const frame = await reset;

      assert.match(frame, /OBSERVED: first/);
      assert.match(frame, /VERIFY: second/);
      assert.equal(client.blocked, true);
      assert.equal(client.needsResync, false);
      res.emit('drain');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(client.blocked, false);
      assert.equal(resetCount, 1, 'one missed append must trigger exactly one recovery snapshot');
      assert.equal(res.frames.filter(item => item.includes('event: reset')).length, 1);
    } finally {
      stream.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not resend an accepted large snapshot merely because write signals backpressure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'praetorium-snapshot-backpressure-'));
    const path = join(root, 'worker.log');
    writeFileSync(path, `PLAN: ${'large '.repeat(12000)}\n`, 'utf8');
    const service = {
      getDirector: id => ({ id, cwd: root, board: 'board-one', runtime: 'windows' }),
      getTaskDetails: async (_directorId, taskId) => ({ task: { id: taskId } }),
      getTaskTrace: async () => ({ log: '', availability: 'available' }),
    };
    const stream = new WorkerTraceStream({
      service,
      runtime: { taskLogPath: () => path },
      heartbeatMs: 60000,
    });
    const res = new FakeResponse([true, false]);
    try {
      const client = await stream.open(new FakeRequest(), res, {
        directorId: 'director-one', taskId: 't_one',
      });
      assert.equal(client.blocked, true);
      assert.equal(client.needsResync, false);
      assert.equal(res.frames.filter(frame => frame.includes('event: snapshot')).length, 1);

      res.emit('drain');
      await new Promise(resolve => setImmediate(resolve));

      assert.equal(client.blocked, false);
      assert.equal(client.needsResync, false);
      assert.equal(res.frames.filter(frame => frame.includes('event: snapshot')).length, 1);
      assert.equal(res.frames.filter(frame => frame.includes('event: reset')).length, 0);
    } finally {
      stream.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not install a polling timer when the response closes during the initial snapshot', async () => {
    let releaseTrace;
    const tracePending = new Promise(resolve => { releaseTrace = resolve; });
    let traceStarted;
    const started = new Promise(resolve => { traceStarted = resolve; });
    const service = {
      getDirector: id => ({ id, cwd: 'C:\\projects\\one', board: 'board-one', runtime: 'wsl' }),
      getTaskDetails: async (_directorId, taskId) => ({ task: { id: taskId } }),
      getTaskTrace: async () => {
        traceStarted();
        await tracePending;
        return { log: 'late snapshot', availability: 'available' };
      },
    };
    const stream = new WorkerTraceStream({
      service,
      runtime: { taskLogPath: () => null },
      heartbeatMs: 60000,
    });
    const req = new FakeRequest();
    const res = new FakeResponse();
    const opening = stream.open(req, res, { directorId: 'director-one', taskId: 't_one' });
    await started;
    res.emit('close');
    releaseTrace();

    const client = await opening;
    assert.equal(stream.clientCount, 0);
    assert.equal(client.pollTimer, null);
    stream.close();
  });
});
