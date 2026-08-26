import { EventEmitter } from 'node:events';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DirectorActivityStream, register } from '../../routes/directors.js';

let routes;
let service;
let activityStream;
let readBodyOptions;
const ATTACHMENT_ID = 'attachment_11111111-1111-4111-8111-111111111111';

function response() {
  return {
    status: 0,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    writeHead(status, headers = {}) {
      this.status = status;
      for (const [name, value] of Object.entries(headers)) this.headers[String(name).toLowerCase()] = value;
    },
    end(data) { this.body = data == null || data === '' ? null : JSON.parse(data); },
  };
}

function streamRequest({ remoteAddress = '127.0.0.1', host = '127.0.0.1:3848', origin, fetchSite } = {}) {
  const req = new EventEmitter();
  req.params = { id: 'project-director-1' };
  req.headers = {
    host,
    ...(origin ? { origin } : {}),
    ...(fetchSite ? { 'sec-fetch-site': fetchSite } : {}),
  };
  req.socket = { remoteAddress, setTimeout() {}, setNoDelay() {} };
  return req;
}

function streamResponse({ writeResults = [] } = {}) {
  const res = new EventEmitter();
  return Object.assign(res, {
    status: 0,
    headers: {},
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    writes: [],
    writeHead(status, headers = {}) {
      this.status = status;
      this.headersSent = true;
      for (const [name, value] of Object.entries(headers)) this.headers[String(name).toLowerCase()] = value;
    },
    write(data) {
      this.writes.push(String(data));
      return writeResults.length ? writeResults.shift() : true;
    },
    end() { this.writableEnded = true; },
  });
}

function binaryResponse() {
  return {
    status: 0,
    body: null,
    headers: {},
    writeHead(status, headers = {}) {
      this.status = status;
      for (const [name, value] of Object.entries(headers)) this.headers[String(name).toLowerCase()] = value;
    },
    end(data) { this.body = data == null ? null : Buffer.from(data); },
  };
}

function sseData(frame) {
  const data = String(frame).split('\n').find(line => line.startsWith('data: '));
  return data ? JSON.parse(data.slice(6)) : null;
}

function setup() {
  routes = {};
  readBodyOptions = null;
  const activeGoal = {
    id: 'goal-1', directorId: 'project-director-1', objective: 'Ship API', status: 'awaiting_owner',
    ownerDecision: { required: true, question: 'Keep compatibility?', options: ['keep', 'change'] },
  };
  service = Object.assign(new EventEmitter(), {
    summary: () => ({ localOnly: true, directors: [], goals: [activeGoal], activeGoals: [activeGoal] }),
    consoleSummary: ({ directorId } = {}) => ({
      schema: 'director-console.v1', revision: 'sha256:console-test', selectedDirectorId: directorId || null,
      localOnly: true, directors: [], goals: [activeGoal], activeGoals: [activeGoal.id], queuedGoals: [],
    }),
    syncProjects: () => [],
    getDirector: id => id === 'project-director-1' ? { id } : null,
    getRun: id => id === 'run-1' ? { id } : null,
    getRunDetailsForDirector: (directorId, runId) => (
      directorId === 'project-director-1' && runId === 'run-1'
        ? { id: runId, directorId, output: 'full', attachments: [{ id: ATTACHMENT_ID, name: 'screen.png' }] }
        : null
    ),
    getAttachmentPreview: (directorId, attachmentId) => (
      directorId === 'project-director-1' && attachmentId === ATTACHMENT_ID
        ? { metadata: { id: attachmentId, mimeType: 'image/png' }, body: Buffer.from('safe-image') }
        : null
    ),
    getGoal: id => id === activeGoal.id ? activeGoal : null,
    getGoalDetailsForDirector: (directorId, id) => (
      directorId === 'project-director-1' && id === activeGoal.id ? activeGoal : null
    ),
    getGoalHistory: (id, options) => ({ items: [{ id: 'goal-old', directorId: id }], total: 1, options }),
    getMessageHistory: (id, options) => ({ items: [{ id: 'run-chat', directorId: id, output: 'full' }], total: 1, options }),
    answerGoalDecision: async (directorId, goalId, payload) => ({ directorId, goalId, ...payload }),
    controlGoal: async (directorId, goalId, action, options) => ({ directorId, goalId, action, ...options }),
    guideGoal: async (directorId, goalId, payload) => ({ directorId, goalId, ...payload }),
    getBoard: () => [],
    getBoardStatus: () => ({ refreshing: true }),
    getTaskDetails: async (_id, taskId) => ({ task: { id: taskId }, latest_summary: 'done' }),
    getTaskTrace: async (_id, taskId) => ({ taskId, log: 'live log' }),
    interveneTask: async (_id, taskId, message) => ({
      taskId, message, accepted: true, persisted: true, workerObserved: false, status: 'accepted_queued',
    }),
    controlTask: async (_id, taskId, action) => ({ taskId, action, accepted: true }),
    submitMessage: (id, prompt) => ({ id: 'run-1', directorId: id, prompt }),
    createObjective: async () => ({ id: 'task-1' }),
    tickDirector: async () => ({ spawned: 1 }),
  });
  activityStream = new DirectorActivityStream({ source: service, heartbeatMs: 60000 });
  register({
    directorService: service,
    activityStream,
    addRoute(method, path, handler) { routes[`${method} ${path}`] = handler; },
    json(res, body, status = 200) { res.writeHead(status); res.end(JSON.stringify(body)); },
    readBody: async (req, options) => {
      readBodyOptions = options || null;
      return req.body || {};
    },
  });
}

describe('director routes', () => {
  beforeEach(setup);
  afterEach(() => activityStream.close());

  it('exposes a local-only system summary', () => {
    const res = response();
    routes['GET /api/directors']({}, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.localOnly, true);
    assert.equal(res.body.activeGoals.length, 1);
    assert.equal(res.body.activeGoals[0].id, 'goal-1');
  });

  it('serves a compact conditional console snapshot without changing the default response', () => {
    const first = response();
    routes['GET /api/directors']({
      query: { view: 'compact', directorId: 'project-director-1' }, headers: {},
    }, first);
    assert.equal(first.status, 200);
    assert.equal(first.body.schema, 'director-console.v1');
    assert.equal(first.body.selectedDirectorId, 'project-director-1');
    assert.deepEqual(first.body.activeGoals, ['goal-1']);
    assert.equal(first.headers.etag, '"sha256:console-test"');

    const unchanged = response();
    routes['GET /api/directors']({
      query: { view: 'compact', revision: 'sha256:console-test' }, headers: {},
    }, unchanged);
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.body, null);
    assert.equal(unchanged.headers.etag, '"sha256:console-test"');
  });

  it('serves the durable Goal independently from Director turns', () => {
    const res = response();
    routes['GET /api/directors/:id/goals/:goalId']({ params: { id: 'project-director-1', goalId: 'goal-1' } }, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'awaiting_owner');
    assert.equal(res.body.objective, 'Ship API');
  });

  it('serves full Run output only through its owning Director and omits local attachment paths', () => {
    const owned = response();
    routes['GET /api/directors/:id/runs/:runId']({
      params: { id: 'project-director-1', runId: 'run-1' },
    }, owned);
    assert.equal(owned.status, 200);
    assert.equal(owned.body.output, 'full');
    assert.equal('path' in owned.body.attachments[0], false);
    assert.equal('manifestPath' in owned.body.attachments[0], false);

    const foreign = response();
    routes['GET /api/directors/:id/runs/:runId']({
      params: { id: 'project-director-2', runId: 'run-1' },
    }, foreign);
    assert.equal(foreign.status, 404);
  });

  it('does not fall back to a stale directorId when project-scoped Goal ownership rejects access', () => {
    service.getGoal = () => ({
      id: 'goal-stale', directorId: 'project-director-1', projectId: 'former-project', status: 'completed',
    });
    service.getGoalDetailsForDirector = () => null;
    const res = response();
    routes['GET /api/directors/:id/goals/:goalId']({
      params: { id: 'project-director-1', goalId: 'goal-stale' },
    }, res);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Goal not found');
  });

  it('serves an owned verified image with non-cacheable nosniff headers', () => {
    const req = streamRequest({ origin: 'http://127.0.0.1:3848' });
    req.params = { id: 'project-director-1', attachmentId: ATTACHMENT_ID };
    const res = binaryResponse();
    routes['GET /api/directors/:id/attachments/:attachmentId'](req, res);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(res.headers['content-length'], Buffer.byteLength('safe-image'));
    assert.deepEqual(res.body, Buffer.from('safe-image'));
  });

  it('rejects cross-origin and malformed attachment preview requests before storage lookup', () => {
    let lookups = 0;
    service.getAttachmentPreview = () => { lookups += 1; return null; };
    const crossOrigin = streamRequest({ origin: 'https://attacker.example' });
    crossOrigin.params = { id: 'project-director-1', attachmentId: ATTACHMENT_ID };
    const forbidden = response();
    routes['GET /api/directors/:id/attachments/:attachmentId'](crossOrigin, forbidden);
    assert.equal(forbidden.status, 403);

    const malformed = streamRequest();
    malformed.params = { id: 'project-director-1', attachmentId: '../../secret.png' };
    const invalid = response();
    routes['GET /api/directors/:id/attachments/:attachmentId'](malformed, invalid);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'INVALID_ATTACHMENT_ID');
    assert.equal(lookups, 0);
  });

  it('does not disclose an attachment outside the selected Director ownership boundary', () => {
    service.getDirector = id => ['project-director-1', 'project-director-2'].includes(id) ? { id } : null;
    const req = streamRequest();
    req.params = { id: 'project-director-2', attachmentId: ATTACHMENT_ID };
    const res = response();
    routes['GET /api/directors/:id/attachments/:attachmentId'](req, res);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Attachment not found');
  });

  it('streams only public Director activity and never raw model output', () => {
    const req = streamRequest({ origin: 'http://127.0.0.1:3848' });
    const res = streamResponse();
    routes['GET /api/directors/:id/activity'](req, res);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/event-stream/);
    assert.equal(sseData(res.writes.find(frame => frame.includes('event: ready'))).resyncRequired, true);

    service.emit('run', {
      id: 'run-live', directorId: 'project-director-1', goalId: 'goal-live', kind: 'supervision',
      status: 'running', phase: 'assessing_evidence', prompt: 'SECRET OWNER PROMPT',
      output: 'PRIVATE CHAIN OF THOUGHT', analysis: { hidden: 'SECRET ANALYSIS' },
      attachments: [{ name: 'secret.png', dataBase64: 'RAW_IMAGE_BASE64' }],
      progressEvents: [{ at: '2026-08-26T00:00:00.000Z', phase: 'assessing_evidence', message: '공개 증거를 평가하고 있습니다.', details: { secret: 'HIDDEN' } }],
    });
    service.emit('output', {
      runId: 'run-live', directorId: 'project-director-1', goalId: 'goal-live',
      channel: 'stdout', text: 'SECRET STREAMED REASONING\nsecond line',
    });
    service.emit('goal', {
      id: 'goal-live', directorId: 'project-director-1', status: 'executing', phase: 'monitoring',
      objective: 'SECRET OBJECTIVE', analysis: { hidden: 'SECRET GOAL ANALYSIS' },
      events: [{ at: '2026-08-26T00:00:01.000Z', kind: 'worker', phase: 'monitoring', message: 'Worker 완료 신호를 확인했습니다.', details: { secret: 'HIDDEN GOAL DETAIL' } }],
    });
    service.emit('tick', [{
      directorId: 'project-director-1', ready: 2, running: 1, allocated: 1, spawned: ['task-1'],
      error: 'SECRET TICK ERROR', supervision: { state: 'executing', privateEvidence: 'HIDDEN TICK DETAIL' },
    }]);
    activityStream.heartbeat();

    const joined = res.writes.join('');
    assert.doesNotMatch(joined, /SECRET|PRIVATE|HIDDEN|RAW_IMAGE_BASE64/);
    const run = sseData(res.writes.find(frame => frame.includes('event: run')));
    assert.equal(run.schema, 'director-activity.v1');
    assert.equal(run.activity.phase, 'assessing_evidence');
    assert.equal(run.activity.checkpoint.message, '공개 증거를 평가하고 있습니다.');
    const output = sseData(res.writes.find(frame => frame.includes('event: output')));
    assert.equal(output.activity.channel, 'stdout');
    assert.equal(output.activity.chunkBytes, Buffer.byteLength('SECRET STREAMED REASONING\nsecond line'));
    assert.equal('text' in output.activity, false);
    const goal = sseData(res.writes.find(frame => frame.includes('event: goal')));
    assert.equal(goal.activity.checkpoint.message, 'Worker 완료 신호를 확인했습니다.');
    const tick = sseData(res.writes.find(frame => frame.includes('event: tick')));
    assert.equal(tick.activity.status, 'error');
    assert.equal(tick.activity.spawnedCount, 1);
    assert.ok(res.writes.some(frame => frame.startsWith(': heartbeat ')));

    const writesBeforeOtherDirector = res.writes.length;
    service.emit('run', { id: 'run-other', directorId: 'project-director-2', status: 'running', phase: 'planning' });
    assert.equal(res.writes.length, writesBeforeOtherDirector);

    res.emit('close');
    assert.equal(activityStream.clientCount, 0);
    const writesAfterClose = res.writes.length;
    service.emit('goal', { id: 'goal-live', directorId: 'project-director-1', status: 'completed' });
    assert.equal(res.writes.length, writesAfterClose);
  });

  it('rejects non-loopback, rebound Host, and cross-origin activity streams', () => {
    for (const req of [
      streamRequest({ remoteAddress: '192.168.1.8' }),
      streamRequest({ host: 'attacker.example:3848' }),
      streamRequest({ origin: 'https://attacker.example' }),
      streamRequest({ fetchSite: 'cross-site' }),
    ]) {
      const res = response();
      routes['GET /api/directors/:id/activity'](req, res);
      assert.equal(res.status, 403);
      assert.match(res.body.error, /same-origin loopback/i);
    }
  });

  it('drops activity for a slow client and emits one bounded resync receipt after drain', () => {
    const req = streamRequest();
    const res = streamResponse({ writeResults: [true, false] });
    routes['GET /api/directors/:id/activity'](req, res);
    service.emit('run', { id: 'run-slow', directorId: 'project-director-1', status: 'running', phase: 'planning' });
    service.emit('goal', { id: 'goal-slow', directorId: 'project-director-1', status: 'executing', phase: 'monitoring' });
    service.emit('output', { runId: 'run-slow', directorId: 'project-director-1', channel: 'stdout', text: 'hidden' });
    assert.equal(res.writes.filter(frame => frame.includes('event: goal') || frame.includes('event: output')).length, 0);

    res.emit('drain');
    const receipt = sseData(res.writes.find(frame => frame.includes('event: resync')));
    assert.equal(receipt.resyncRequired, true);
    assert.equal(receipt.droppedEvents, 2);
  });

  it('pages durable Goal and project conversation history', () => {
    const goals = response();
    routes['GET /api/directors/:id/goals']({
      params: { id: 'project-director-1' }, query: { offset: '24', limit: '12', query: 'api', filter: 'completed' },
    }, goals);
    assert.equal(goals.status, 200);
    assert.equal(goals.body.items[0].id, 'goal-old');
    assert.deepEqual(goals.body.options, { offset: '24', limit: '12', query: 'api', filter: 'completed' });

    const messages = response();
    routes['GET /api/directors/:id/messages']({
      params: { id: 'project-director-1' }, query: { offset: '20', limit: '20', known: 'run-chat,run-old' },
    }, messages);
    assert.equal(messages.status, 200);
    assert.equal(messages.body.items[0].output, 'full');
    assert.deepEqual(messages.body.options, { offset: '20', limit: '20', knownIds: 'run-chat,run-old' });
  });

  it('passes the exact Owner answer and selected option to the durable Goal', async () => {
    let captured = null;
    service.answerGoalDecision = async (directorId, goalId, payload) => {
      captured = { directorId, goalId, payload };
      return { id: goalId, status: 'evaluating' };
    };
    const res = response();
    await routes['POST /api/directors/:id/goals/:goalId/decision']({
      params: { id: 'project-director-1', goalId: 'goal-1' },
      body: { answer: '기존 호환성을 유지해.', selectedOption: 'keep' },
    }, res);
    assert.equal(res.status, 202);
    assert.deepEqual(captured, {
      directorId: 'project-director-1', goalId: 'goal-1',
      payload: { answer: '기존 호환성을 유지해.', selectedOption: 'keep' },
    });
  });

  it('returns conflict for a duplicate Owner decision submission', async () => {
    let accepted = false;
    service.answerGoalDecision = async () => {
      if (accepted) throw new Error('Goal is not awaiting an Owner decision');
      accepted = true;
      return { id: 'goal-1', status: 'evaluating' };
    };
    const request = {
      params: { id: 'project-director-1', goalId: 'goal-1' },
      body: { answer: 'keep', selectedOption: 'keep' },
    };
    const first = response();
    const duplicate = response();
    await routes['POST /api/directors/:id/goals/:goalId/decision'](request, first);
    await routes['POST /api/directors/:id/goals/:goalId/decision'](request, duplicate);
    assert.equal(first.status, 202);
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.error, /not awaiting/i);
  });

  it('passes queue and lifecycle controls to the durable Goal service', async () => {
    let captured = null;
    service.controlGoal = async (directorId, goalId, action, options) => {
      captured = { directorId, goalId, action, options };
      return { id: goalId, status: 'queued', queuePosition: 1, controlAction: action };
    };
    const res = response();
    await routes['POST /api/directors/:id/goals/:goalId/control']({
      params: { id: 'project-director-1', goalId: 'goal-queued' },
      body: { action: 'reorder', position: 'front', reason: 'urgent' },
    }, res);
    assert.equal(res.status, 202);
    assert.deepEqual(captured, {
      directorId: 'project-director-1', goalId: 'goal-queued', action: 'reorder',
      options: { position: 'front', reason: 'urgent' },
    });
  });

  it('returns explicit Goal-control 4xx responses', async () => {
    service.controlGoal = async () => {
      throw Object.assign(new Error('Cannot control Goal while 1 Worker is running'), {
        statusCode: 409, code: 'GOAL_CONTROL_CONFLICT',
      });
    };
    const res = response();
    await routes['POST /api/directors/:id/goals/:goalId/control']({
      params: { id: 'project-director-1', goalId: 'goal-1' }, body: { action: 'cancel' },
    }, res);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'GOAL_CONTROL_CONFLICT');
    assert.match(res.body.error, /Worker is running/);
  });

  it('passes bounded image guidance to an active durable Goal', async () => {
    let captured = null;
    service.guideGoal = async (directorId, goalId, payload) => {
      captured = { directorId, goalId, payload };
      return { accepted: true, persisted: true, goalId, receipts: [], errors: [] };
    };
    const attachments = [{ name: 'screen.png', mimeType: 'image/png', dataBase64: 'encoded' }];
    const res = response();
    await routes['POST /api/directors/:id/goals/:goalId/guidance']({
      params: { id: 'project-director-1', goalId: 'goal-1' },
      body: { message: 'use this layout', attachments },
    }, res);
    assert.equal(res.status, 202);
    assert.deepEqual(captured, {
      directorId: 'project-director-1', goalId: 'goal-1',
      payload: { message: 'use this layout', attachments },
    });
    assert.equal(readBodyOptions.maxBytes, 17 * 1024 * 1024);
  });

  it('preserves Goal guidance attachment validation status and code', async () => {
    service.guideGoal = async () => {
      throw Object.assign(new Error('Image content does not match image/png.'), {
        statusCode: 415, code: 'IMAGE_CONTENT_MISMATCH',
      });
    };
    const res = response();
    await routes['POST /api/directors/:id/goals/:goalId/guidance']({
      params: { id: 'project-director-1', goalId: 'goal-1' },
      body: { message: 'inspect', attachments: [] },
    }, res);
    assert.equal(res.status, 415);
    assert.equal(res.body.code, 'IMAGE_CONTENT_MISMATCH');
  });

  it('queues a message with bounded image attachments instead of blocking the HTTP request', async () => {
    let captured = null;
    service.submitMessage = (directorId, prompt, options) => {
      captured = { directorId, prompt, options };
      return { id: 'run-1', directorId, prompt, attachments: [{ id: 'attachment-1' }] };
    };
    const res = response();
    const attachments = [{ name: 'screen.png', mimeType: 'image/png', dataBase64: 'encoded' }];
    await routes['POST /api/directors/:id/messages']({
      params: { id: 'project-director-1' }, body: { prompt: 'go', mode: 'auto', attachments },
    }, res);
    assert.equal(res.status, 202);
    assert.equal(res.body.prompt, 'go');
    assert.deepEqual(captured, {
      directorId: 'project-director-1', prompt: 'go', options: { mode: 'auto', attachments },
    });
    assert.equal(readBodyOptions.maxBytes, 17 * 1024 * 1024);
  });

  it('preserves attachment validation status and code', async () => {
    service.submitMessage = () => {
      throw Object.assign(new Error('Image content does not match image/png.'), {
        statusCode: 415, code: 'IMAGE_CONTENT_MISMATCH',
      });
    };
    const res = response();
    await routes['POST /api/directors/:id/messages']({
      params: { id: 'project-director-1' }, body: { prompt: 'go', attachments: [] },
    }, res);
    assert.equal(res.status, 415);
    assert.equal(res.body.code, 'IMAGE_CONTENT_MISMATCH');
  });

  it('serves a cache-only board snapshot with refresh status', () => {
    const res = response();
    routes['GET /api/directors/:id/board']({ params: { id: 'project-director-1' } }, res);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.tasks, []);
    assert.equal(res.body.status.refreshing, true);
  });

  it('serves worker task evidence for the one-screen inspector', async () => {
    const res = response();
    await routes['GET /api/directors/:id/tasks/:taskId']({ params: { id: 'project-director-1', taskId: 't_one' } }, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.task.id, 't_one');
    assert.equal(res.body.latest_summary, 'done');
  });

  it('serves the live worker execution log', async () => {
    const res = response();
    await routes['GET /api/directors/:id/tasks/:taskId/trace']({ params: { id: 'project-director-1', taskId: 't_one' } }, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.log, 'live log');
  });

  it('injects an Owner intervention into a running worker', async () => {
    const res = response();
    await routes['POST /api/directors/:id/tasks/:taskId/interventions']({ params: { id: 'project-director-1', taskId: 't_one' }, body: { message: 'change direction' } }, res);
    assert.equal(res.status, 202);
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.workerObserved, false);
  });

  it('preserves the durable-intervention conflict code for orphan or legacy cards', async () => {
    service.interveneTask = async () => {
      throw Object.assign(new Error('Worker intervention requires a durable Goal task record.'), {
        statusCode: 409,
        code: 'INTERVENTION_NOT_DURABLE',
      });
    };
    const res = response();
    await routes['POST /api/directors/:id/tasks/:taskId/interventions']({
      params: { id: 'project-director-1', taskId: 't_legacy_orphan' },
      body: { message: 'change direction' },
    }, res);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'INTERVENTION_NOT_DURABLE');
  });

  it('controls worker execution lifecycle', async () => {
    const res = response();
    await routes['POST /api/directors/:id/tasks/:taskId/control']({ params: { id: 'project-director-1', taskId: 't_one' }, body: { action: 'pause' } }, res);
    assert.equal(res.status, 202);
    assert.equal(res.body.action, 'pause');
  });

  it('requires objective title', async () => {
    const res = response();
    await routes['POST /api/directors/:id/objectives']({ params: { id: 'project-director-1' }, body: {} }, res);
    assert.equal(res.status, 400);
  });
});
