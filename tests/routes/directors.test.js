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
  const activeGoal = {
    id: 'goal-1', directorId: 'project-director-1', objective: 'Ship API', status: 'awaiting_owner',
    ownerDecision: { required: true, question: 'Keep compatibility?', options: ['keep', 'change'] },
  };
  service = {
    summary: () => ({ localOnly: true, directors: [], goals: [activeGoal], activeGoals: [activeGoal] }),
    syncProjects: () => [],
    getRun: id => id === 'run-1' ? { id } : null,
    getGoal: id => id === activeGoal.id ? activeGoal : null,
    answerGoalDecision: async (directorId, goalId, payload) => ({ directorId, goalId, ...payload }),
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
    assert.equal(res.body.activeGoals.length, 1);
    assert.equal(res.body.activeGoals[0].id, 'goal-1');
  });

  it('serves the durable Goal independently from Director turns', () => {
    const res = response();
    routes['GET /api/directors/:id/goals/:goalId']({ params: { id: 'project-director-1', goalId: 'goal-1' } }, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'awaiting_owner');
    assert.equal(res.body.objective, 'Ship API');
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
