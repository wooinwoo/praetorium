import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectorService } from '../../lib/director-service.js';

function conversationOutput(text = 'done') {
  return `${text}\n<PRAETORIUM_CONTROL>${JSON.stringify({
    schema: 'director-action.v1', mode: 'conversation', workflow_id: null, state: 'complete',
    requirements: [], decisions: [], actions: [],
    owner_decision: { required: false, question: null, options: [], evidence: [] },
  })}</PRAETORIUM_CONTROL>`;
}

function delegationOutput() {
  return `위임합니다.\n<PRAETORIUM_CONTROL>${JSON.stringify({
    schema: 'director-action.v1', mode: 'delegate', workflow_id: 'quick-fix', state: 'executing',
    requirements: ['tests pass'], decisions: ['small isolated change'],
    actions: [{
      id: 'implement', title: 'Implement fix', target: 'codex-implementer', task: 'Implement the fix.',
      skills: [], dependencies: [], write_scope: ['src/'], acceptance: ['tests pass'], wake_on: ['completion'],
    }], owner_decision: { required: false, question: null, options: [], evidence: [] },
  })}</PRAETORIUM_CONTROL>`;
}

function analysisOutput() {
  return `<PRAETORIUM_ANALYSIS>${JSON.stringify({
    schema: 'director-analysis.v1', request_summary: 'Apply a small fix',
    success_criteria: ['tests pass'], constraints: ['bounded write scope'], evidence: ['current repository'],
    risks: ['regression'], unknowns: [],
    workflow_candidates: [{ id: 'quick-fix', fit: 'small isolated change', tradeoff: 'narrow review' }],
    recommended_workflow: 'quick-fix', worker_strategy: ['one writer'],
    review_strategy: ['risk-based review'], stop_conditions: ['tests fail twice'],
  })}</PRAETORIUM_ANALYSIS>`;
}

function runtime(overrides = {}) {
  let taskNumber = 0;
  return {
    chat: async () => ({ stdout: conversationOutput() }),
    listTasks: async () => [],
    dispatch: async () => ({ json: { spawned: 0 } }),
    createObjective: async () => ({ json: { id: 'task-1' } }),
    createTask: async () => ({ json: { id: `t_test_${++taskNumber}` } }),
    ...overrides,
  };
}

function service(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'director-service-'));
  return new DirectorService({
    runtime: opts.runtime || runtime(),
    stateFile: join(dir, 'directors.json'),
    projectsRoot: 'C:\\projects',
    getProjects: opts.getProjects || (() => [{ id: 'alpha', name: 'Alpha', path: 'C:\\projects\\alpha' }]),
  });
}

describe('DirectorService', () => {
  it('creates three project Director slots and one Skill Director', () => {
    const svc = service();
    const directors = svc.listDirectors();
    assert.equal(directors.filter(d => d.kind === 'project').length, 3);
    assert.equal(directors.filter(d => d.kind === 'skill').length, 1);
    assert.equal(directors[0].projectId, 'alpha');
    assert.equal(directors[1].status, 'unassigned');
  });

  it('limits the owner console to three project Directors', () => {
    const svc = service({ getProjects: () => Array.from({ length: 6 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      path: `C:\\projects\\project-${index + 1}`,
    })) });
    assert.equal(svc.listDirectors().filter(d => d.kind === 'project').length, 3);
  });

  it('persists registry state atomically', () => {
    const svc = service();
    const parsed = JSON.parse(readFileSync(svc.stateFile, 'utf8'));
    assert.equal(parsed.schema, 1);
    assert.equal(parsed.directors.length, 4);
  });

  it('recovers queued and running Director turns after a process restart', () => {
    const first = service();
    const state = JSON.parse(readFileSync(first.stateFile, 'utf8'));
    state.directors[0].status = 'running';
    state.runs.push({
      id: 'interrupted-run', directorId: 'project-director-1', status: 'running',
      prompt: 'keep going', output: '', error: null, createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(), completedAt: null,
    });
    writeFileSync(first.stateFile, JSON.stringify(state), 'utf8');

    const restarted = new DirectorService({
      runtime: runtime(), stateFile: first.stateFile, projectsRoot: 'C:\\projects',
      getProjects: () => [{ id: 'alpha', name: 'Alpha', path: 'C:\\projects\\alpha' }],
    });
    assert.equal(restarted.getDirector('project-director-1').status, 'idle');
    assert.equal(restarted.getRun('interrupted-run').status, 'failed');
    assert.match(restarted.getRun('interrupted-run').error, /previous Praetorium shutdown/);
    assert.ok(restarted.getRun('interrupted-run').completedAt);
  });

  it('dispatches an adaptive number of ready tasks', async () => {
    let dispatched = null;
    const svc = service({ runtime: runtime({
      listTasks: async () => [
        { status: 'ready' }, { status: 'ready' }, { status: 'ready' }, { status: 'running' },
      ],
      dispatch: async ({ max }) => { dispatched = max; return { json: { spawned: max } }; },
    }) });
    const result = await svc.tickDirector('project-director-1');
    assert.ok(dispatched >= 1 && dispatched <= 3);
    assert.equal(result.spawned, dispatched);
  });

  it('runs a zero-spawn dispatch pass to reconcile exited workers', async () => {
    let dispatched = null;
    const svc = service({ runtime: runtime({
      listTasks: async () => [{ status: 'running' }],
      dispatch: async ({ max }) => { dispatched = max; return { json: { crashed: ['worker-1'], spawned: [] } }; },
    }) });
    const result = await svc.tickDirector('project-director-1');
    assert.equal(dispatched, 0);
    assert.deepEqual(result.dispatch.crashed, ['worker-1']);
  });

  it('serves board reads immediately and single-flights a slow Hermes refresh', async () => {
    let releaseList;
    let ensureCalls = 0;
    let listCalls = 0;
    const listing = new Promise(resolve => { releaseList = resolve; });
    const svc = service({ runtime: runtime({
      ensureBoard: async () => { ensureCalls += 1; },
      listTasks: async () => { listCalls += 1; return listing; },
    }) });

    assert.deepEqual(svc.getBoard('project-director-1'), []);
    assert.deepEqual(svc.getBoard('project-director-1'), []);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(ensureCalls, 1);
    assert.equal(listCalls, 1);
    assert.equal(svc.getBoardStatus('project-director-1').refreshing, true);

    releaseList([{ id: 'worker-1', status: 'running' }]);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(svc.getBoard('project-director-1'), [{ id: 'worker-1', status: 'running' }]);
    assert.equal(listCalls, 1);
    assert.equal(svc.getBoardStatus('project-director-1').refreshing, false);
  });

  it('ticks project boards independently when one board is slow', async () => {
    let releaseFirst;
    const firstBoard = new Promise(resolve => { releaseFirst = resolve; });
    const listed = [];
    const svc = service({
      getProjects: () => [
        { id: 'alpha', name: 'Alpha', path: 'C:\\projects\\alpha' },
        { id: 'beta', name: 'Beta', path: 'C:\\projects\\beta' },
      ],
      runtime: runtime({
        listTasks: async ({ board }) => {
          listed.push(board);
          if (board === 'alpha') await firstBoard;
          return [];
        },
      }),
    });
    const ticking = svc.tick();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(listed.includes('beta'));
    releaseFirst();
    await ticking;
  });

  it('runs a Director chat asynchronously and returns durable output', async () => {
    const svc = service({ runtime: runtime({ chat: async () => ({ stdout: conversationOutput('director result'), sessionId: 'session-123' }) }) });
    const run = svc.submitMessage('project-director-1', 'status?', { mode: 'conversation' });
    assert.equal(run.status, 'queued');
    await new Promise(resolve => setTimeout(resolve, 30));
    const completed = svc.getRun(run.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output, 'director result');
    assert.equal(svc.getDirector('project-director-1').sessionId, null);
    assert.equal(svc.getDirector('project-director-1').lastSessionId, 'session-123');
  });

  it('uses fresh sessions with bounded prior-turn handoff context', async () => {
    const seen = [];
    const svc = service({ runtime: runtime({
      chat: async ({ session, prompt }) => {
        seen.push({ session, prompt });
        return { stdout: conversationOutput('ok'), sessionId: 'audit-session' };
      },
    }) });
    const first = svc.submitMessage('project-director-1', 'first', { mode: 'conversation' });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(svc.getRun(first.id).status, 'completed');
    const second = svc.submitMessage('project-director-1', 'second', { mode: 'conversation' });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(svc.getRun(second.id).status, 'completed');
    assert.equal(seen[0].session, null);
    assert.match(seen[0].prompt, /Open sessions: 1 total \(1 Director, 0 worker\)/);
    assert.match(seen[0].prompt, /CURRENT OWNER MESSAGE\]\n\nfirst/);
    assert.equal(seen[1].session, null);
    assert.match(seen[1].prompt, /PRAETORIUM FRESH-SESSION HANDOFF/);
    assert.match(seen[1].prompt, /OWNER:\nfirst/);
    assert.match(seen[1].prompt, /DIRECTOR:\nok/);
    assert.match(seen[1].prompt, /CURRENT OWNER MESSAGE\]\n\nsecond/);
  });

  it('materializes a validated delegation plan as durable worker tasks', async () => {
    const created = [];
    let chatCalls = 0;
    const svc = service({ runtime: runtime({
      chat: async () => ({ stdout: ++chatCalls === 1 ? analysisOutput() : delegationOutput(), sessionId: 'plan-session' }),
      createTask: async options => { created.push(options); return { json: { id: 't_worker_1' } }; },
    }) });
    const run = svc.submitMessage('project-director-1', '고쳐줘');
    await new Promise(resolve => setTimeout(resolve, 50));
    const completed = svc.getRun(run.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.phase, 'delegated');
    assert.equal(completed.workflowId, 'quick-fix');
    assert.equal(completed.analysis.recommendedWorkflow, 'quick-fix');
    assert.deepEqual(completed.taskIds, ['t_worker_1']);
    assert.equal(created[0].assignee, 'codex-implementer');
    assert.match(created[0].body, /PRAETORIUM OBJECTIVE/);
    assert.match(created[0].body, /\[PUBLIC TRACE\]/);
    assert.match(created[0].body, /PLAN:.*OBSERVED:.*DECISION:.*VERIFY:/s);
    assert.ok(completed.progressEvents.some(event => event.phase === 'materializing'));
  });

  it('terminates a running Worker before parking it for Owner input', async () => {
    const calls = [];
    const svc = service({ runtime: runtime({
      taskDetails: async () => ({ task: { id: 't_live', status: 'running' } }),
      reclaimTask: async () => { calls.push('reclaim'); },
      blockTask: async () => { calls.push('block'); },
      listTasks: async () => [],
    }) });
    const result = await svc.controlTask('project-director-1', 't_live', 'pause', 'Owner changed direction');
    assert.deepEqual(calls, ['reclaim', 'block']);
    assert.equal(result.accepted, true);
    assert.equal(result.previousStatus, 'running');
  });

  it('retries one fresh planning session after invalid Director control', async () => {
    let calls = 0;
    const svc = service({ runtime: runtime({
      chat: async () => ({ stdout: ++calls === 1 ? analysisOutput() : calls === 2 ? 'direct result without control' : delegationOutput() }),
    }) });
    const run = svc.submitMessage('project-director-1', '구현해줘');
    await new Promise(resolve => setTimeout(resolve, 60));
    const completed = svc.getRun(run.id);
    assert.equal(calls, 3);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.planAttempt, 2);
    assert.ok(completed.progressEvents.some(event => event.phase === 'retrying'));
  });
});
