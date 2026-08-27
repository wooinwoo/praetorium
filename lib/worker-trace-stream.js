import { watchFile, unwatchFile } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const SCHEMA = 'worker-trace.v1';
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_WATCH_INTERVAL_MS = 500;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const MAX_TAIL_BYTES = 240000;
const MAX_APPEND_BYTES = 64000;

function assertIdentifier(value, label) {
  if (!SAFE_ID.test(String(value || ''))) {
    throw Object.assign(new Error(`Invalid ${label}`), { statusCode: 400 });
  }
}

function runtimeTarget(director) {
  return director?.runtime === 'wsl'
    ? { kind: 'wsl', distro: director.distro }
    : { kind: 'windows', distro: null };
}

function statIdentity(info) {
  if (!info) return null;
  return `${String(info.dev ?? '')}:${String(info.ino ?? '')}:${String(info.birthtimeMs ?? '')}`;
}

async function readRange(path, start, length) {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readTail(path, maxBytes = MAX_TAIL_BYTES) {
  try {
    const info = await stat(path);
    const size = Number(info.size) || 0;
    const start = Math.max(0, size - maxBytes);
    const bytes = await readRange(path, start, size - start);
    return { exists: true, size, start, identity: statIdentity(info), bytes, text: bytes.toString('utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return {
      exists: false, size: 0, start: 0, identity: null, bytes: Buffer.alloc(0), text: '',
    };
    throw error;
  }
}

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

export class WorkerTraceStream {
  constructor({
    service,
    runtime,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    watchIntervalMs = DEFAULT_WATCH_INTERVAL_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxClients = 12,
    maxClientsPerDirector = 4,
  } = {}) {
    if (!service || !runtime) throw new Error('WorkerTraceStream requires DirectorService and HermesRuntime');
    this.service = service;
    this.runtime = runtime;
    this.clients = new Set();
    this.pendingClients = 0;
    this.pendingClientsByDirector = new Map();
    this.sequence = 0;
    this.closed = false;
    this.maxClients = Math.max(1, Number(maxClients) || 12);
    this.maxClientsPerDirector = Math.max(1, Number(maxClientsPerDirector) || 4);
    this.heartbeatMs = Math.max(1000, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS);
    this.watchIntervalMs = Math.max(200, Number(watchIntervalMs) || DEFAULT_WATCH_INTERVAL_MS);
    this.pollIntervalMs = Math.max(500, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  get clientCount() { return this.clients.size; }

  _reserveConnection(directorId) {
    const activeForDirector = [...this.clients].filter(client => client.directorId === directorId).length;
    const pendingForDirector = this.pendingClientsByDirector.get(directorId) || 0;
    if (this.clients.size + this.pendingClients >= this.maxClients
      || activeForDirector + pendingForDirector >= this.maxClientsPerDirector) {
      throw Object.assign(new Error('Too many live Worker trace connections.'), { statusCode: 429 });
    }
    this.pendingClients += 1;
    this.pendingClientsByDirector.set(directorId, pendingForDirector + 1);
  }

  _releaseConnectionReservation(directorId) {
    this.pendingClients = Math.max(0, this.pendingClients - 1);
    const remaining = Math.max(0, (this.pendingClientsByDirector.get(directorId) || 0) - 1);
    if (remaining) this.pendingClientsByDirector.set(directorId, remaining);
    else this.pendingClientsByDirector.delete(directorId);
  }

  async open(req, res, { directorId, taskId } = {}) {
    if (this.closed) throw Object.assign(new Error('Worker trace stream is shutting down.'), { statusCode: 503 });
    assertIdentifier(directorId, 'director id');
    assertIdentifier(taskId, 'task id');
    const director = this.service.getDirector?.(directorId);
    if (!director?.cwd) throw Object.assign(new Error('Director not found'), { statusCode: 404 });
    this._reserveConnection(directorId);
    let reservationHeld = true;

    try {
      // Validate ownership before a long-lived response is opened. This prevents
      // a guessed task id from reading another board's local log file.
      await this.service.getTaskDetails(directorId, taskId);
      if (this.closed) {
        throw Object.assign(new Error('Worker trace stream is shutting down.'), { statusCode: 503 });
      }
      if (req.aborted || req.destroyed || res.destroyed || res.writableEnded) {
        throw Object.assign(new Error('Worker trace client disconnected.'), {
          statusCode: 499,
          code: 'TRACE_CLIENT_CLOSED',
        });
      }
      const target = runtimeTarget(director);
      let path = null;
      try {
        path = this.runtime.taskLogPath?.({ board: director.board, taskId, target }) || null;
      } catch {
        // Custom development runtimes can lack the managed on-disk layout. They
        // retain the slower, bounded Hermes CLI snapshot fallback.
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      res.flushHeaders?.();
      req.socket?.setTimeout?.(0);
      req.socket?.setNoDelay?.(true);

      const client = {
        directorId,
        taskId,
        director,
        target,
        path,
        req,
        res,
        offset: 0,
        fileIdentity: null,
        decoder: new StringDecoder('utf8'),
        lastText: '',
        blocked: false,
        needsResync: false,
        refreshing: false,
        refreshAgain: false,
        watchListener: null,
        pollTimer: null,
        drainListener: null,
        cleanup: null,
      };
      client.cleanup = () => this._removeClient(client, false);
      req.on?.('aborted', client.cleanup);
      res.on?.('close', client.cleanup);
      res.on?.('error', client.cleanup);
      this.clients.add(client);
      this._releaseConnectionReservation(directorId);
      reservationHeld = false;

      this._send(client, 'ready', {
        transport: path ? 'local-file-watch' : 'bounded-snapshot-poll',
        heartbeatMs: this.heartbeatMs,
        readOnly: true,
      });
      try {
        if (path) {
          client.watchListener = () => this._queueFileRefresh(client);
          watchFile(path, { interval: this.watchIntervalMs, persistent: false }, client.watchListener);
          await this._snapshotFile(client, 'snapshot');
        } else {
          await this._pollSnapshot(client, true);
          if (this.clients.has(client)) {
            client.pollTimer = setInterval(() => void this._pollSnapshot(client, false), this.pollIntervalMs);
            client.pollTimer.unref?.();
          }
        }
      } catch (error) {
        this._removeClient(client, true);
        throw error;
      }
      return client;
    } finally {
      if (reservationHeld) this._releaseConnectionReservation(directorId);
    }
  }

  heartbeat() {
    const frame = `: heartbeat ${new Date().toISOString()}\n\n`;
    for (const client of this.clients) {
      if (!client.blocked) this._write(client, frame, { countDrop: false });
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    for (const client of [...this.clients]) this._removeClient(client, true);
  }

  _queueFileRefresh(client) {
    if (!this.clients.has(client)) return;
    if (client.refreshing) {
      client.refreshAgain = true;
      return;
    }
    client.refreshing = true;
    void this._refreshFile(client).catch(error => {
      this._send(client, 'status', { availability: 'error', error: String(error?.message || error).slice(0, 1000) });
    }).finally(() => {
      client.refreshing = false;
      if (client.refreshAgain) {
        client.refreshAgain = false;
        this._queueFileRefresh(client);
      }
    });
  }

  async _refreshFile(client) {
    if (!this.clients.has(client) || client.blocked) {
      if (client.blocked) client.needsResync = true;
      return;
    }
    let info;
    try { info = await stat(client.path); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        if (client.offset || client.lastText) await this._snapshotFile(client, 'reset');
        else this._send(client, 'status', { availability: 'not_started' });
        return;
      }
      throw error;
    }
    const size = Number(info.size) || 0;
    const identity = statIdentity(info);
    if ((client.fileIdentity && identity !== client.fileIdentity)
      || size < client.offset || size - client.offset > MAX_APPEND_BYTES) {
      await this._snapshotFile(client, 'reset');
      return;
    }
    if (size === client.offset) return;
    const bytes = await readRange(client.path, client.offset, size - client.offset);
    const from = client.offset;
    client.offset = size;
    client.fileIdentity = identity;
    const text = client.decoder.write(bytes);
    client.lastText = `${client.lastText}${text}`.slice(-MAX_TAIL_BYTES);
    this._send(client, 'append', { from, to: size, log: text, availability: 'available' });
  }

  async _snapshotFile(client, type = 'snapshot') {
    const snapshot = await readTail(client.path);
    client.offset = snapshot.size;
    client.fileIdentity = snapshot.identity;
    client.decoder = new StringDecoder('utf8');
    const text = client.decoder.write(snapshot.bytes);
    client.lastText = text;
    this._send(client, snapshot.exists ? type : 'status', snapshot.exists
      ? { from: snapshot.start, to: snapshot.size, log: text, availability: 'available' }
      : { availability: 'not_started' });
  }

  async _pollSnapshot(client, initial) {
    if (!this.clients.has(client) || client.refreshing || client.blocked) {
      if (client.blocked) client.needsResync = true;
      return;
    }
    client.refreshing = true;
    try {
      const trace = await this.service.getTaskTrace(client.directorId, client.taskId);
      const next = String(trace?.log || '');
      const previous = client.lastText;
      client.lastText = next;
      if (initial || !previous || !next.startsWith(previous)) {
        const common = commonPrefixLength(previous, next);
        this._send(client, initial ? 'snapshot' : 'reset', {
          log: next,
          commonPrefixCharacters: common,
          availability: trace?.availability || 'available',
          observedAt: trace?.observedAt || null,
        });
      } else if (next.length > previous.length) {
        this._send(client, 'append', {
          log: next.slice(previous.length),
          availability: trace?.availability || 'available',
          observedAt: trace?.observedAt || null,
        });
      } else {
        this._send(client, 'status', {
          availability: trace?.availability || 'available',
          observedAt: trace?.observedAt || null,
        });
      }
    } catch (error) {
      this._send(client, 'status', { availability: 'error', error: String(error?.message || error).slice(0, 1000) });
    } finally {
      client.refreshing = false;
    }
  }

  _send(client, type, payload) {
    if (!this.clients.has(client)) return false;
    const envelope = {
      schema: SCHEMA,
      type,
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      directorId: client.directorId,
      taskId: client.taskId,
      ...payload,
    };
    return this._write(client, `id: ${envelope.sequence}\nevent: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`);
  }

  _write(client, frame, { countDrop = true } = {}) {
    if (!frame || !this.clients.has(client) || client.res.destroyed || client.res.writableEnded) return false;
    if (client.blocked) {
      if (countDrop) client.needsResync = true;
      return false;
    }
    let writable;
    try { writable = client.res.write(frame); }
    catch {
      this._removeClient(client, true);
      return false;
    }
    if (writable !== false) return true;
    client.blocked = true;
    // Node accepted this frame even when write() returns false; false only
    // means the transport buffer crossed its high-water mark. Resync is needed
    // only if another frame is attempted while blocked and therefore skipped.
    // Marking this accepted snapshot as dropped creates an endless
    // snapshot -> drain -> snapshot feedback loop for frames over 16 KiB.
    client.needsResync = false;
    client.drainListener = () => {
      client.blocked = false;
      client.drainListener = null;
      if (!this.clients.has(client) || !client.needsResync) return;
      client.needsResync = false;
      if (client.path) void this._snapshotFile(client, 'reset');
      else void this._pollSnapshot(client, true);
    };
    client.res.once?.('drain', client.drainListener);
    return false;
  }

  _removeClient(client, endResponse) {
    if (!this.clients.delete(client)) return;
    client.req.off?.('aborted', client.cleanup);
    client.res.off?.('close', client.cleanup);
    client.res.off?.('error', client.cleanup);
    if (client.drainListener) client.res.off?.('drain', client.drainListener);
    if (client.watchListener && client.path) unwatchFile(client.path, client.watchListener);
    if (client.pollTimer) clearInterval(client.pollTimer);
    if (endResponse && !client.res.destroyed && !client.res.writableEnded) {
      try { client.res.end(); } catch { /* disconnected client */ }
    }
  }
}

export const _test = {
  assertIdentifier, runtimeTarget, statIdentity, readRange, readTail, commonPrefixLength,
};
