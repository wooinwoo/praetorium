import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../routes/directors.js';

let routes;
let service;

function response() {
  return { status: 0, body: null, writeHead(status) { this.status = status; }, end(data) { this.body = JSON.parse(data); } };
}

function setup() {
  routes = {};
  service = {
    summary: () => ({ localOnly: true, directors: [] }),
    syncProjects: () => [],
    getRun: id => id === 'run-1' ? { id } : null,
    getBoard: () => [],
    getBoardStatus: () => ({ refreshing: true }),
    getTaskDetails: async (_id, taskId) => ({ task: { id: taskId }, latest_summary: 'done' }),
    getTaskTrace: async (_id, taskId) => ({ taskId, log: 'live log' }),
    interveneTask: async (_id, taskId, message) => ({ taskId, message, delivered: true }),
    controlTask: async (_id, taskId, action) => ({ taskId, action, accepted: true }),
    submitMessage: (id, prompt) => ({ id: 'run-1', directorId: id, prompt }),
    createObjective: async () => ({ id: 'task-1' }),
    tickDirector: async () => ({ spawned: 1 }),
  };
  register({
    directorService: service,
    addRoute(method, path, handler) { routes[`${method} ${path}`] = handler; },
    json(res, body, status = 200) { res.writeHead(status); res.end(JSON.stringify(body)); },
    readBody: async req => req.body || {},
  });
}

describe('director routes', () => {
  beforeEach(setup);

  it('exposes a local-only system summary', () => {
    const res = response();
    routes['GET /api/directors']({}, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.localOnly, true);
  });

  it('queues a message instead of blocking the HTTP request', async () => {
    const res = response();
    await routes['POST /api/directors/:id/messages']({ params: { id: 'project-director-1' }, body: { prompt: 'go' } }, res);
    assert.equal(res.status, 202);
    assert.equal(res.body.prompt, 'go');
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
    assert.equal(res.body.delivered, true);
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
