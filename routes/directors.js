import { Buffer } from 'node:buffer';
import { DIRECTOR_ATTACHMENT_LIMITS, isDirectorAttachmentId } from '../lib/director-attachments.js';
import { isLoopbackAddress, isLoopbackHost } from '../lib/local-only.js';

export function register(ctx) {
  const { addRoute, json, readBody, directorService, activityStream } = ctx;
  if (!directorService) return;

  addRoute('GET', '/api/directors', (req, res) => {
    if (req.query?.view !== 'compact') return json(res, directorService.summary());
    const snapshot = directorService.consoleSummary({ directorId: req.query?.directorId });
    const etag = `"${snapshot.revision}"`;
    const conditional = String(req.query?.revision || req.headers?.['if-none-match'] || '')
      .trim().replace(/^W\//, '').replace(/^"|"$/g, '');
    if (conditional && conditional === snapshot.revision) {
      res.writeHead(304, { 'Cache-Control': 'no-store', ETag: etag });
      res.end();
      return;
    }
    res.setHeader?.('ETag', etag);
    json(res, snapshot);
  });

  addRoute('POST', '/api/directors/sync', (_req, res) => {
    try { json(res, { directors: directorService.syncProjects() }); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('GET', '/api/directors/:id/runs/:runId', (req, res) => {
    const run = directorService.getRunDetailsForDirector(req.params.id, req.params.runId);
    if (!run) return json(res, { error: 'Run not found' }, 404);
    json(res, run);
  });

  addRoute('GET', '/api/directors/:id/attachments/:attachmentId', (req, res) => {
    if (!isLocalDirectorRequest(req)) {
      return json(res, { error: 'Attachment preview accepts same-origin loopback requests only.' }, 403);
    }
    if (!directorService.getDirector?.(req.params.id)) return json(res, { error: 'Director not found' }, 404);
    if (!isDirectorAttachmentId(req.params.attachmentId)) {
      return json(res, { error: 'Invalid attachment id.', code: 'INVALID_ATTACHMENT_ID' }, 400);
    }
    try {
      const result = directorService.getAttachmentPreview?.(req.params.id, req.params.attachmentId);
      if (!result) return json(res, { error: 'Attachment not found' }, 404);
      const { body, metadata } = result;
      if (!Buffer.isBuffer(body) || !DIRECTOR_ATTACHMENT_LIMITS.allowedMimeTypes.includes(metadata?.mimeType)) {
        return json(res, { error: 'Attachment preview is not a supported image.' }, 415);
      }
      res.writeHead(200, {
        'Content-Type': metadata.mimeType,
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      });
      res.end(body);
    } catch (err) {
      const status = Number(err.statusCode) || (/not found/i.test(err.message) ? 404 : 409);
      json(res, { error: err.message, ...(err.code ? { code: err.code } : {}) }, status);
    }
  });

  addRoute('GET', '/api/directors/:id/activity', (req, res) => {
    if (!isLocalActivityRequest(req)) return json(res, { error: 'Activity stream accepts same-origin loopback requests only.' }, 403);
    if (!directorService.getDirector?.(req.params.id)) return json(res, { error: 'Director not found' }, 404);
    if (!activityStream) return json(res, { error: 'Activity stream unavailable.' }, 503);
    try {
      activityStream.open(req, res, { directorId: req.params.id });
    } catch (err) {
      if (!res.headersSent) json(res, { error: err.message }, Number(err.statusCode) || 500);
      else res.end();
    }
  });

  addRoute('GET', '/api/directors/:id/goals/:goalId', (req, res) => {
    const goal = directorService.getGoalDetailsForDirector(req.params.id, req.params.goalId);
    if (!goal) return json(res, { error: 'Goal not found' }, 404);
    json(res, goal);
  });

  addRoute('GET', '/api/directors/:id/goals', (req, res) => {
    try {
      json(res, directorService.getGoalHistory(req.params.id, {
        offset: req.query?.offset,
        limit: req.query?.limit,
        query: req.query?.query,
        filter: req.query?.filter,
      }));
    } catch (err) {
      json(res, { error: err.message }, /not found/i.test(err.message) ? 404 : 400);
    }
  });

  addRoute('GET', '/api/directors/:id/messages', (req, res) => {
    try {
      json(res, directorService.getMessageHistory(req.params.id, {
        offset: req.query?.offset,
        limit: req.query?.limit,
        knownIds: req.query?.known,
      }));
    } catch (err) {
      json(res, { error: err.message }, /not found/i.test(err.message) ? 404 : 400);
    }
  });

  addRoute('POST', '/api/directors/:id/goals/:goalId/decision', async (req, res) => {
    try {
      const body = await readBody(req);
      json(res, await directorService.answerGoalDecision(req.params.id, req.params.goalId, body), 202);
    } catch (err) {
      const status = /not found/i.test(err.message) ? 404
        : /already running|not awaiting/i.test(err.message) ? 409 : 400;
      json(res, { error: err.message }, status);
    }
  });

  addRoute('POST', '/api/directors/:id/goals/:goalId/control', async (req, res) => {
    try {
      const body = await readBody(req);
      json(res, await directorService.controlGoal(
        req.params.id,
        req.params.goalId,
        body.action,
        { position: body.position, reason: body.reason },
      ), 202);
    } catch (err) {
      const status = Number(err.statusCode) || (/not found/i.test(err.message) ? 404
        : /unsupported|position/i.test(err.message) ? 400 : 409);
      json(res, { error: err.message, code: err.code || null }, status);
    }
  });

  addRoute('POST', '/api/directors/:id/goals/:goalId/guidance', async (req, res) => {
    try {
      const body = await readBody(req, { maxBytes: DIRECTOR_ATTACHMENT_LIMITS.maxRequestBytes });
      json(res, await directorService.guideGoal(req.params.id, req.params.goalId, {
        message: body.message,
        attachments: body.attachments,
        deliveryMode: body.deliveryMode,
      }), 202);
    } catch (err) {
      const status = Number(err.statusCode) || (/not found/i.test(err.message) ? 404 : 400);
      json(res, { error: err.message, ...(err.code ? { code: err.code } : {}) }, status);
    }
  });

  addRoute('GET', '/api/directors/:id/board', (req, res) => {
    try {
      json(res, {
        tasks: directorService.getBoard(req.params.id),
        status: directorService.getBoardStatus?.(req.params.id) || null,
      });
    }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('GET', '/api/directors/:id/tasks/:taskId', async (req, res) => {
    try { json(res, await directorService.getTaskDetails(req.params.id, req.params.taskId)); }
    catch (err) { json(res, { error: err.message }, /not found/i.test(err.message) ? 404 : 400); }
  });

  addRoute('GET', '/api/directors/:id/tasks/:taskId/trace', async (req, res) => {
    try { json(res, await directorService.getTaskTrace(req.params.id, req.params.taskId)); }
    catch (err) { json(res, { error: err.message }, /not found/i.test(err.message) ? 404 : 400); }
  });

  addRoute('POST', '/api/directors/:id/tasks/:taskId/interventions', async (req, res) => {
    try {
      const body = await readBody(req);
      json(res, await directorService.interveneTask(req.params.id, req.params.taskId, body.message), 202);
    } catch (err) {
      const status = Number(err.statusCode) || (/not found/i.test(err.message) ? 404 : 400);
      json(res, { error: err.message, ...(err.code ? { code: err.code } : {}) }, status);
    }
  });

  addRoute('POST', '/api/directors/:id/tasks/:taskId/control', async (req, res) => {
    try {
      const body = await readBody(req);
      json(res, await directorService.controlTask(req.params.id, req.params.taskId, body.action, body.reason), 202);
    } catch (err) {
      const status = /not found/i.test(err.message) ? 404
        : /already running|terminal task|reached terminal state/i.test(err.message) ? 409 : 400;
      json(res, { error: err.message }, status);
    }
  });

  addRoute('POST', '/api/directors/:id/messages', async (req, res) => {
    try {
      const body = await readBody(req, { maxBytes: DIRECTOR_ATTACHMENT_LIMITS.maxRequestBytes });
      json(res, directorService.submitMessage(req.params.id, body.prompt, {
        mode: body.mode,
        attachments: body.attachments,
      }), 202);
    } catch (err) {
      const status = Number(err.statusCode) || (/not found/i.test(err.message) ? 404
        : /already running|already supervises active Goal/i.test(err.message) ? 409 : 400);
      json(res, { error: err.message, ...(err.code ? { code: err.code } : {}) }, status);
    }
  });

  addRoute('POST', '/api/directors/:id/objectives', async (req, res) => {
    try {
      const body = await readBody(req);
      if (!body.title) return json(res, { error: 'title required' }, 400);
      json(res, await directorService.createObjective(req.params.id, body), 202);
    } catch (err) { json(res, { error: err.message }, 400); }
  });

  addRoute('POST', '/api/directors/:id/dispatch', async (req, res) => {
    try {
      const body = await readBody(req);
      json(res, await directorService.tickDirector(req.params.id, body.max));
    } catch (err) { json(res, { error: err.message }, 400); }
  });
}

const SCHEMA = 'director-activity.v1';
const DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_MAX_CLIENTS = 24;
const DEFAULT_MAX_CLIENTS_PER_DIRECTOR = 6;
const MAX_EVENT_BYTES = 8 * 1024;
const MAX_MESSAGE_CHARS = 2000;
const MAX_IDENTIFIER_CHARS = 160;

function cleanText(value, limit = MAX_MESSAGE_CHARS) {
  return String(value ?? '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, limit)
    .trim();
}

function cleanIdentifier(value) {
  const cleaned = cleanText(value, MAX_IDENTIFIER_CHARS);
  return cleaned || null;
}

function cleanTimestamp(value) {
  const cleaned = cleanText(value, 64);
  return cleaned || null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function latestPublicCheckpoint(events) {
  const event = Array.isArray(events) ? events.at(-1) : null;
  if (!event || typeof event !== 'object') return null;
  const checkpoint = {
    at: cleanTimestamp(event.at),
    phase: cleanIdentifier(event.phase),
    message: cleanText(event.message),
  };
  if ('kind' in event) checkpoint.kind = cleanIdentifier(event.kind);
  return checkpoint.message || checkpoint.phase ? checkpoint : null;
}

function sanitizeRun(run) {
  if (!run || typeof run !== 'object') return null;
  const directorId = cleanIdentifier(run.directorId);
  const runId = cleanIdentifier(run.id || run.runId);
  if (!directorId || !runId) return null;
  return {
    directorId,
    runId,
    goalId: cleanIdentifier(run.goalId),
    activity: {
      kind: cleanIdentifier(run.kind),
      status: cleanIdentifier(run.status),
      phase: cleanIdentifier(run.phase),
      startedAt: cleanTimestamp(run.startedAt),
      completedAt: cleanTimestamp(run.completedAt),
      checkpoint: latestPublicCheckpoint(run.progressEvents),
    },
  };
}

function sanitizeGoal(goal) {
  if (!goal || typeof goal !== 'object') return null;
  const directorId = cleanIdentifier(goal.directorId);
  const goalId = cleanIdentifier(goal.id || goal.goalId);
  if (!directorId || !goalId) return null;
  return {
    directorId,
    goalId,
    activity: {
      status: cleanIdentifier(goal.status),
      phase: cleanIdentifier(goal.phase),
      updatedAt: cleanTimestamp(goal.updatedAt),
      completedAt: cleanTimestamp(goal.completedAt),
      queuePosition: finiteNumber(goal.queuePosition),
      currentWaveIndex: finiteNumber(goal.currentWaveIndex),
      ownerActionRequired: Boolean(goal.status === 'awaiting_owner' && goal.ownerDecision?.required),
      checkpoint: latestPublicCheckpoint(goal.events),
    },
  };
}

function sanitizeOutput(output) {
  if (!output || typeof output !== 'object') return null;
  const directorId = cleanIdentifier(output.directorId);
  const runId = cleanIdentifier(output.runId);
  if (!directorId || !runId) return null;
  const text = String(output.text ?? '');
  const sampled = text.slice(0, 64 * 1024);
  return {
    directorId,
    runId,
    goalId: cleanIdentifier(output.goalId),
    activity: {
      channel: ['stdout', 'stderr'].includes(output.channel) ? output.channel : 'other',
      chunkBytes: Buffer.byteLength(text, 'utf8'),
      chunkCharacters: text.length,
      sampledLineBreaks: (sampled.match(/\n/g) || []).length,
      lineCountSampled: sampled.length !== text.length,
    },
  };
}

function spawnedCount(value) {
  if (Array.isArray(value)) return value.length;
  const number = finiteNumber(value);
  return number == null ? null : Math.max(0, number);
}

function sanitizeTickResult(result) {
  if (!result || typeof result !== 'object') return null;
  const directorId = cleanIdentifier(result.directorId);
  if (!directorId) return null;
  return {
    directorId,
    goalId: cleanIdentifier(result.supervision?.goalId),
    activity: {
      status: result.error ? 'error' : result.skipped ? 'skipped' : 'completed',
      spawnedCount: spawnedCount(result.spawned),
      ready: finiteNumber(result.ready),
      running: finiteNumber(result.running),
      allocated: finiteNumber(result.allocated),
      skipped: Boolean(result.skipped),
      dispatchSkipped: Boolean(result.dispatchSkipped),
      awaitingOwner: Boolean(result.awaitingOwner),
      supervisionState: cleanIdentifier(result.supervision?.state),
    },
  };
}

/**
 * Re-assert the HTTP boundary at the long-lived endpoint itself. Browser
 * requests must be same-origin; local non-browser clients may omit Origin.
 */
export function isLocalDirectorRequest(req) {
  const headers = req?.headers || {};
  if (!isLoopbackAddress(req?.socket?.remoteAddress) || !isLoopbackHost(headers.host)) return false;
  const source = headers.origin || headers.referer;
  if (source) {
    try {
      const sourceUrl = new URL(source);
      return sourceUrl.protocol === 'http:'
        && sourceUrl.host.toLowerCase() === String(headers.host).trim().toLowerCase();
    } catch {
      return false;
    }
  }
  const fetchSite = String(headers['sec-fetch-site'] || '').trim().toLowerCase();
  return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
}

export function isLocalActivityRequest(req) {
  return isLocalDirectorRequest(req);
}

export class DirectorActivityStream {
  constructor({
    source,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    maxClients = DEFAULT_MAX_CLIENTS,
    maxClientsPerDirector = DEFAULT_MAX_CLIENTS_PER_DIRECTOR,
  } = {}) {
    if (!source?.on || !source?.off) throw new Error('DirectorActivityStream requires an EventEmitter source');
    this.source = source;
    this.sequence = 0;
    this.clients = new Set();
    this.maxClients = Math.max(1, Number(maxClients) || DEFAULT_MAX_CLIENTS);
    this.maxClientsPerDirector = Math.max(1, Number(maxClientsPerDirector) || DEFAULT_MAX_CLIENTS_PER_DIRECTOR);
    this.closed = false;
    this.listeners = {
      run: run => this._publish('run', sanitizeRun(run)),
      goal: goal => this._publish('goal', sanitizeGoal(goal)),
      output: output => this._publish('output', sanitizeOutput(output)),
      tick: results => {
        for (const result of Array.isArray(results) ? results : []) {
          this._publish('tick', sanitizeTickResult(result));
        }
      },
    };
    for (const [name, listener] of Object.entries(this.listeners)) source.on(name, listener);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), Math.max(1000, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS));
    this.heartbeatTimer.unref?.();
    this.heartbeatMs = Math.max(1000, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS);
  }

  get clientCount() { return this.clients.size; }

  open(req, res, { directorId } = {}) {
    if (this.closed) throw Object.assign(new Error('Activity stream is shutting down.'), { statusCode: 503 });
    const normalizedDirectorId = cleanIdentifier(directorId);
    if (!normalizedDirectorId) throw Object.assign(new Error('Director id is required.'), { statusCode: 400 });
    const directorClients = [...this.clients].filter(client => client.directorId === normalizedDirectorId).length;
    if (this.clients.size >= this.maxClients || directorClients >= this.maxClientsPerDirector) {
      throw Object.assign(new Error('Too many live activity connections.'), { statusCode: 429 });
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
      directorId: normalizedDirectorId,
      req,
      res,
      blocked: false,
      dropped: 0,
      drainListener: null,
      cleanup: null,
    };
    client.cleanup = () => this._removeClient(client, false);
    req.on?.('aborted', client.cleanup);
    res.on?.('close', client.cleanup);
    res.on?.('error', client.cleanup);
    this.clients.add(client);

    const ready = this._frame('ready', {
      schema: SCHEMA,
      type: 'ready',
      sequence: this.sequence,
      at: new Date().toISOString(),
      directorId: normalizedDirectorId,
      resyncRequired: true,
      heartbeatMs: this.heartbeatMs,
    }, { includeId: false });
    this._write(client, `retry: 3000\n${ready}`);
    return client;
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
    for (const [name, listener] of Object.entries(this.listeners)) this.source.off(name, listener);
    for (const client of [...this.clients]) this._removeClient(client, true);
  }

  _publish(type, sanitized) {
    if (this.closed || !sanitized) return;
    const sequence = ++this.sequence;
    const envelope = {
      schema: SCHEMA,
      type,
      sequence,
      at: new Date().toISOString(),
      ...sanitized,
    };
    const frame = this._frame(type, envelope);
    if (!frame) return;
    for (const client of this.clients) {
      if (client.directorId === sanitized.directorId) this._write(client, frame);
    }
  }

  _frame(type, envelope, { includeId = true } = {}) {
    const json = JSON.stringify(envelope);
    if (Buffer.byteLength(json, 'utf8') > MAX_EVENT_BYTES) return null;
    return `${includeId ? `id: ${envelope.sequence}\n` : ''}event: ${type}\ndata: ${json}\n\n`;
  }

  _write(client, frame, { countDrop = true } = {}) {
    if (!frame || !this.clients.has(client) || client.res.destroyed || client.res.writableEnded) return false;
    if (client.blocked) {
      if (countDrop) client.dropped += 1;
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
    client.drainListener = () => {
      client.blocked = false;
      client.drainListener = null;
      if (!this.clients.has(client) || !client.dropped) return;
      const dropped = client.dropped;
      client.dropped = 0;
      const envelope = {
        schema: SCHEMA,
        type: 'resync',
        sequence: this.sequence,
        at: new Date().toISOString(),
        directorId: client.directorId,
        droppedEvents: dropped,
        resyncRequired: true,
      };
      this._write(client, this._frame('resync', envelope, { includeId: false }));
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
    if (endResponse && !client.res.destroyed && !client.res.writableEnded) {
      try { client.res.end(); } catch { /* disconnected client */ }
    }
  }
}
