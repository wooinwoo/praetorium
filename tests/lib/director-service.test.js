import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectorService, _test } from '../../lib/director-service.js';
import { adaptiveWorkerLimit } from '../../lib/hermes-runtime.js';

function conversationOutput(text = 'done') {
  return `${text}\n<PRAETORIUM_CONTROL>${JSON.stringify({
    schema: 'director-action.v1', mode: 'conversation', workflow_id: null, state: 'complete',
    requirements: [], decisions: [], actions: [],
    owner_decision: { required: false, question: null, options: [], evidence: [] },
  })}</PRAETORIUM_CONTROL>`;
}

function delegationOutput({ workflowId = 'quick-fix' } = {}) {
  return `위임합니다.\n<PRAETORIUM_CONTROL>${JSON.stringify({
    schema: 'director-action.v1', mode: 'delegate', workflow_id: workflowId, state: 'executing',
    requirements: ['tests pass'], decisions: ['small isolated change'],
    actions: [{
      id: 'implement', title: 'Implement fix', target: 'codex-implementer', task: 'Implement the fix.',
      effect: 'workspace_write',
      skills: [], dependencies: [], write_scope: ['src/'], acceptance: ['tests pass'], wake_on: ['completion'],
    }], owner_decision: { required: false, question: null, options: [], evidence: [] },
  })}</PRAETORIUM_CONTROL>`;
}

function ownerDecisionOutput() {
  return `Owner 판단이 필요합니다.\n<PRAETORIUM_CONTROL>${JSON.stringify({
    schema: 'director-action.v1', mode: 'delegate', workflow_id: 'quick-fix', state: 'awaiting_owner',
    requirements: ['compatibility decision'], decisions: ['compatibility changes the implementation boundary'], actions: [],
    owner_decision: {
      required: true, question: '기존 호환성을 유지할까요?', options: ['keep', 'change'],
      evidence: ['existing clients use the current response shape'],
    },
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

function combinedDelegationOutput(options = {}) {
  return `${analysisOutput()}\n${delegationOutput(options)}`;
}

function seedActiveGoal(svc, overrides = {}) {
  const { taskId = 't_goal_worker', directorId = 'project-director-1', ...goalOverrides } = overrides;
  const director = svc.getDirector(directorId);
  const createdAt = '2026-08-24T00:00:00.000Z';
  const goal = {
    id: `goal-${taskId}`,
    directorId,
    projectId: director.projectId,
    objective: 'Complete the durable objective',
    status: 'executing',
    phase: 'executing',
    workflowId: 'quick-fix',
    analysis: { recommendedWorkflow: 'quick-fix' },
    successCriteria: ['tests pass'],
    constraints: [],
    requirements: ['tests pass'],
    taskIds: [taskId],
    currentWaveTaskIds: [taskId],
    taskRecords: [{
      taskId, actionId: 'implement', title: 'Implement fix', profile: 'codex-implementer',
      waveIndex: 1, status: 'running', completedAt: null, wakeOn: [],
    }],
    waves: [{
      id: 'wave-1', index: 1, kind: 'implementation', status: 'running',
      taskIds: [taskId], startedAt: createdAt, completedAt: null,
    }],
    ownerDecision: null,
    ownerAnswers: [],
    ownerApprovals: [],
    publicDecisions: [],
    evidence: [],
    events: [],
    cycleCount: 1,
    maxCycles: 12,
    remediationCount: 0,
    maxRemediationLoops: 3,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    ...goalOverrides,
  };
  svc.state.goals.push(goal);
  director.activeGoalId = goal.id;
  return goal;
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

  it('keeps a WSL project in its Linux path and selected distribution', () => {
    const svc = service({ getProjects: () => [{
      id: 'linux-app', name: 'Linux App', path: '/home/owner/projects/linux-app', runtime: 'wsl', distro: 'Ubuntu',
    }] });
    const director = svc.listDirectors()[0];
    assert.equal(director.cwd, '/home/owner/projects/linux-app');
    assert.equal(director.runtime, 'wsl');
    assert.equal(director.distro, 'Ubuntu');
  });

  it('limits the owner console to three project Directors', () => {
    const svc = service({ getProjects: () => Array.from({ length: 6 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      path: `C:\\projects\\project-${index + 1}`,
    })) });
    assert.equal(svc.listDirectors().filter(d => d.kind === 'project').length, 3);
  });

  it('does not cross-wire project history when a middle assignment is removed and replaced', async () => {
    let projects = [
      { id: 'alpha', name: 'Alpha', path: 'C:\\projects\\alpha', slot: 1 },
      { id: 'beta', name: 'Beta', path: 'C:\\projects\\beta', slot: 2 },
      { id: 'gamma', name: 'Gamma', path: 'C:\\projects\\gamma', slot: 3 },
    ];
    const svc = service({ getProjects: () => projects });
    const betaRun = svc.submitMessage('project-director-2', 'beta history', { mode: 'conversation' });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(svc.getRun(betaRun.id).projectId, 'beta');

    projects = projects.filter(project => project.id !== 'beta');
    svc.syncProjects();
    assert.equal(svc.getDirector('project-director-2').projectId, null);
    assert.equal(svc.getDirector('project-director-3').projectId, 'gamma');

    projects.push({ id: 'delta', name: 'Delta', path: 'C:\\projects\\delta', slot: 2 });
    svc.syncProjects();
    assert.equal(svc.getDirector('project-director-2').projectId, 'delta');
    assert.deepEqual(svc.listRuns({ projectId: 'delta' }), []);
    assert.equal(svc.listRuns({ projectId: 'beta' })[0].prompt, 'beta history');
  });

  it('keeps long unique project identities on separate Hermes boards', () => {
    const base = 'project-name-that-fills-the-whole-identifier-limit-x';
    const first = _test.defaultState([{ id: `${base}-11111111`, name: 'First', path: 'C:\\projects\\first' }]).directors[0];
    const second = _test.defaultState([{ id: `${base}-22222222`, name: 'Second', path: 'C:\\projects\\second' }]).directors[0];
    assert.notEqual(first.board, second.board);
    assert.ok(first.board.length <= 48);
    assert.ok(second.board.length <= 48);
  });

  it('persists registry state atomically', () => {
    const svc = service();
    const parsed = JSON.parse(readFileSync(svc.stateFile, 'utf8'));
    assert.equal(parsed.schema, 2);
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
    delete state.integrity;
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
        { id: 'review-1', status: 'ready', assignee: 'convention-reviewer' },
        { id: 'review-2', status: 'ready', assignee: 'test-gap-reviewer' },
        { id: 'review-3', status: 'ready', assignee: 'adversarial-reviewer' },
        { id: 'review-running', status: 'running', assignee: 'security-reviewer' },
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

  it('backs off idle dispatch while preserving the periodic orphan reconciliation pass', async () => {
    let dispatches = 0;
    const svc = service({ runtime: runtime({
      listTasks: async () => [],
      dispatch: async () => { dispatches += 1; return { json: { spawned: 0 } }; },
    }) });
    await svc.tickDirector('project-director-1');
    const second = await svc.tickDirector('project-director-1');
    assert.equal(dispatches, 1);
    assert.equal(second.dispatchSkipped, true);
    const director = svc.getDirector('project-director-1');
    svc._boardEntry(director).lastDispatchAt = new Date(Date.now() - 61000).toISOString();
    const third = await svc.tickDirector('project-director-1');
    assert.equal(dispatches, 2);
    assert.equal(third.reconciliationDue, true);
    assert.equal(svc.getBoardStatus(director.id).dispatchCount, 2);
  });

  it('invalidates an in-flight scheduler generation before a restarted scheduler can create a second loop', async () => {
    const svc = service({ getProjects: () => [] });
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = new Set();
    globalThis.setTimeout = (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.add(timer);
      return timer;
    };
    globalThis.clearTimeout = timer => timers.delete(timer);

    let releaseFirstTick;
    let tickCalls = 0;
    svc.tick = async () => {
      tickCalls += 1;
      if (tickCalls === 1) return new Promise(resolve => { releaseFirstTick = resolve; });
      return [];
    };
    const fire = timer => {
      timers.delete(timer);
      return timer.callback();
    };

    try {
      svc.startScheduler(5000);
      const firstTimer = [...timers][0];
      const firstTurn = fire(firstTimer);

      svc.stopScheduler();
      svc.startScheduler(5000);
      const restartedTimer = [...timers][0];
      await fire(restartedTimer);

      releaseFirstTick([]);
      await firstTurn;
      assert.equal(timers.size, 1, 'only the restarted generation may own a follow-up timer');

      svc.stopScheduler();
      assert.equal(timers.size, 0, 'stopping the current generation clears its only timer');
    } finally {
      svc.stopScheduler();
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it('preserves supervision and board failures in scheduler health instead of treating them as idle success', async () => {
    const boardSvc = service();
    boardSvc._maybeSuperviseGoal = async () => { throw new Error('supervision failed'); };
    await assert.rejects(() => boardSvc.tickDirector('project-director-1'), /supervision failed/);
    assert.equal(boardSvc.getBoardStatus('project-director-1').lastTickError, 'supervision failed');

    const schedulerSvc = service({ getProjects: () => [] });
    schedulerSvc.tick = async () => [{ directorId: 'skill-director', error: 'board offline' }];
    try {
      schedulerSvc.startScheduler(5000);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.match(schedulerSvc.summary().scheduler.lastError, /skill-director: board offline/);
      assert.equal(schedulerSvc.summary().scheduler.idleTicks, 0, 'failures should retry at the base interval');
    } finally {
      schedulerSvc.stopScheduler();
    }
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

  it('fails closed when project removal discovers non-terminal work outside the cache', async () => {
    const svc = service({ runtime: runtime({ listTasks: async () => [{ id: 't_blocked', status: 'blocked' }] }) });
    await assert.rejects(svc.detachProject('alpha', () => true), /미완료 작업 1개/);
  });

  it('refuses shutdown when a fresh board read finds a running Worker', async () => {
    const svc = service({ runtime: runtime({
      listTasks: async ({ profile }) => profile === 'skill-director' ? [] : [{ id: 't_running', status: 'running' }],
    }) });
    const readiness = await svc.beginShutdown();
    assert.equal(readiness.safe, false);
    assert.match(readiness.reason, /Worker 실행 1개/);
  });

  it('blocks a new Director while project detachment waits on a fresh board read', async () => {
    let releaseList;
    const listing = new Promise(resolve => { releaseList = resolve; });
    const svc = service({ runtime: runtime({ listTasks: async () => listing }) });
    const detaching = svc.detachProject('alpha', () => true);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.throws(() => svc.submitMessage('project-director-1', 'start during detach'), /배정 제거 확인 중/);
    releaseList([]);
    assert.equal(await detaching, true);
  });

  it('blocks new work and in-flight dispatch while shutdown checks fresh boards', async () => {
    let releaseList;
    let dispatches = 0;
    const listing = new Promise(resolve => { releaseList = resolve; });
    const svc = service({ runtime: runtime({
      listTasks: async () => listing,
      dispatch: async () => { dispatches += 1; return { json: { spawned: 1 } }; },
    }) });
    const ticking = svc.tickDirector('project-director-1');
    const checking = svc.beginShutdown();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.throws(() => svc.submitMessage('project-director-1', 'start during shutdown'), /종료 확인 중/);
    releaseList([{ id: 't_ready', status: 'ready' }]);
    assert.deepEqual(await ticking, { skipped: true });
    assert.equal((await checking).safe, true);
    assert.equal(dispatches, 0);
  });

  it('waits for an in-flight dispatch to drain and then refuses shutdown when it spawned a Worker', async () => {
    let status = 'ready';
    let dispatchEntered;
    const entered = new Promise(resolve => { dispatchEntered = resolve; });
    let releaseDispatch;
    const dispatchHeld = new Promise(resolve => { releaseDispatch = resolve; });
    let supervisionEntered;
    const supervising = new Promise(resolve => { supervisionEntered = resolve; });
    let releaseSupervision;
    const supervisionHeld = new Promise(resolve => { releaseSupervision = resolve; });
    const svc = service({ runtime: runtime({
      listTasks: async ({ profile }) => profile === 'skill-director' ? [] : [{
        id: 't_writer', status, assignee: 'codex-implementer',
      }],
      dispatch: async () => {
        dispatchEntered();
        await dispatchHeld;
        status = 'running';
        return { json: { spawned: 1 } };
      },
    }) });
    svc._maybeSuperviseGoal = async () => {
      supervisionEntered();
      await supervisionHeld;
      return { monitored: true };
    };

    const ticking = svc.tickDirector('project-director-1');
    await entered;
    let shutdownSettled = false;
    const checking = svc.beginShutdown().finally(() => { shutdownSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(shutdownSettled, false, 'shutdown must wait for the board lock held by dispatch and supervision');

    releaseDispatch();
    await supervising;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(shutdownSettled, false, 'shutdown must also wait for post-dispatch supervision');
    releaseSupervision();
    await ticking;
    const readiness = await checking;
    assert.equal(readiness.safe, false);
    assert.match(readiness.reason, /Worker 실행 1개/);
  });

  it('reloops a newly supervised wave only after releasing the widened board lock', async () => {
    const svc = service();
    let supervisionCalls = 0;
    let secondTurnSawUnlockedBoard = false;
    const director = svc.getDirector('project-director-1');
    const boardKey = svc._boardKey(director);
    svc._maybeSuperviseGoal = async () => {
      supervisionCalls += 1;
      if (supervisionCalls === 2) secondTurnSawUnlockedBoard = svc.boardLocks.has(boardKey) === false;
      return { taskIds: supervisionCalls === 1 ? ['t_new_wave'] : [] };
    };

    await svc.tickDirector(director.id);
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(supervisionCalls, 2, 'newly materialized work should not wait for the scheduler interval');
    // The second turn has reacquired the lock by the time supervision runs;
    // observing it unlocked here would indicate supervision escaped serialization.
    assert.equal(secondTurnSawUnlockedBoard, false);
    assert.equal(svc.boardLocks.has(boardKey), false);
  });

  it('serializes legacy or unknown writers across the whole board while preserving review parallelism', async () => {
    const writerTasks = [
      { id: 'legacy-write-1', status: 'ready', assignee: 'codex-implementer' },
      { id: 'legacy-write-2', status: 'ready', assignee: 'remediator' },
    ];
    let observedMax = null;
    const svc = service({ runtime: runtime({
      listTasks: async () => writerTasks,
      dispatch: async ({ max }) => { observedMax = max; return { json: { spawned: max } }; },
    }) });
    const result = await svc.tickDirector('project-director-1');
    assert.equal(observedMax, 1);
    assert.equal(result.writerSafety.reason, 'writer-ready');
    assert.deepEqual(result.writerSafety.readyWriterTaskIds, ['legacy-write-1', 'legacy-write-2']);

    writerTasks.splice(0, writerTasks.length,
      { id: 'legacy-write-running', status: 'running', assignee: 'codex-implementer' },
      { id: 'review-ready', status: 'ready', assignee: 'security-reviewer' });
    const blocked = await svc.tickDirector('project-director-1');
    assert.equal(blocked.allocated, 0);
    assert.equal(blocked.writerSafety.reason, 'potential-writer-running');
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
    const summary = svc.summary();
    assert.equal(completed.status, 'completed', 'the individual Director planning turn is complete');
    assert.equal(summary.activeGoals.length, 1, 'the durable Goal remains active after that turn');
    assert.equal(summary.activeGoals[0].id, completed.goalId);
    assert.equal(summary.activeGoals[0].status, 'executing');
    assert.equal(summary.activeGoals[0].completedAt, null);
    assert.equal(svc.getDirector('project-director-1').activeGoalId, completed.goalId);
  });

  it('routes the legacy objective API through the durable Goal queue instead of raw Hermes task creation', async () => {
    let rawObjectives = 0;
    const svc = service({ runtime: runtime({
      chat: async () => ({ stdout: combinedDelegationOutput() }),
      createObjective: async () => { rawObjectives += 1; return { json: { id: 'raw-objective' } }; },
    }) });

    const run = await svc.createObjective('project-director-1', {
      title: 'Durable objective', body: 'Keep the exact acceptance evidence.',
    });
    assert.equal(rawObjectives, 0);
    assert.ok(run.goalId);
    assert.equal(svc.getGoal(run.goalId).objective, 'Durable objective\n\nKeep the exact acceptance evidence.');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(svc.getRun(run.id).status, 'completed');
    assert.equal(svc.getGoal(run.goalId).waves.length, 1);
  });

  it('uses one Director inference when the combined analysis and plan envelope is valid', async () => {
    let chatCalls = 0;
    const svc = service({ runtime: runtime({
      chat: async () => { chatCalls += 1; return { stdout: combinedDelegationOutput() }; },
    }) });
    const submitted = svc.submitMessage('project-director-1', '빠르게 구현해줘', { mode: 'delegate' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const run = svc.getRun(submitted.id);
    assert.equal(run.status, 'completed');
    assert.equal(run.fastPath, true);
    assert.equal(run.combinedAttempt, 1);
    assert.equal(run.planAttempt, 0);
    assert.equal(chatCalls, 1);
    assert.doesNotMatch(run.output, /PRAETORIUM_ANALYSIS/);
  });

  it('propagates a combined workflow mismatch and retries a mismatched fallback plan', async () => {
    const prompts = [];
    const outputs = [
      combinedDelegationOutput({ workflowId: 'standard-feature' }),
      delegationOutput({ workflowId: 'standard-feature' }),
      delegationOutput(),
    ];
    let chatCalls = 0;
    const svc = service({ runtime: runtime({
      chat: async ({ prompt }) => {
        prompts.push(prompt);
        return { stdout: outputs[chatCalls++] };
      },
    }) });
    const submitted = svc.submitMessage('project-director-1', 'Implement the bounded fix', { mode: 'delegate' });
    await new Promise(resolve => setTimeout(resolve, 80));
    const run = svc.getRun(submitted.id);

    assert.equal(chatCalls, 3);
    assert.equal(run.status, 'completed');
    assert.equal(run.planAttempt, 2);
    assert.match(prompts[1], /Combined fast path workflow mismatch/);
    assert.match(prompts[2], /does not match validated analysis/);
  });

  it('queues delegated Goals per project and promotes the next Goal after terminal completion', async () => {
    let chatCalls = 0;
    const svc = service({ runtime: runtime({
      chat: async () => { chatCalls += 1; return { stdout: combinedDelegationOutput() }; },
    }) });
    const first = svc.submitMessage('project-director-1', '첫 기능 구현해줘', { mode: 'delegate' });
    const second = svc.submitMessage('project-director-1', '둘째 기능 구현해줘', { mode: 'delegate' });
    assert.equal(svc.getRun(second.id).status, 'queued');
    assert.equal(svc.getGoal(svc.getRun(second.id).goalId).status, 'queued');
    assert.equal(svc.summary().queuedGoals[0].queuePosition, 1);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(chatCalls, 1, 'the queued Goal must not open a competing Director turn');
    const firstGoal = svc.getGoal(svc.getRun(first.id).goalId);
    svc._finishGoal(firstGoal, 'completed', 'first complete', { gateAudit: { satisfied: true } });
    svc._save();
    await new Promise(resolve => setTimeout(resolve, 60));
    const secondGoal = svc.getGoal(svc.getRun(second.id).goalId);
    assert.equal(chatCalls, 2);
    assert.equal(secondGoal.status, 'executing');
    assert.equal(svc.getRun(second.id).status, 'completed');
    assert.equal(svc.getDirector('project-director-1').activeGoalId, secondGoal.id);
  });

  it('promotes a delegated Goal immediately after a non-Goal Director conversation ends', async () => {
    let chatCalls = 0;
    const svc = service({ runtime: runtime({
      chat: async () => {
        chatCalls += 1;
        if (chatCalls === 1) {
          await new Promise(resolve => setTimeout(resolve, 20));
          return { stdout: conversationOutput('conversation complete') };
        }
        return { stdout: combinedDelegationOutput() };
      },
    }) });

    svc.submitMessage('project-director-1', 'Explain the current state', { mode: 'conversation' });
    const queued = svc.submitMessage('project-director-1', 'Implement the next fix', { mode: 'delegate' });
    const queuedGoalId = svc.getRun(queued.id).goalId;
    assert.equal(svc.getGoal(queuedGoalId).status, 'queued');

    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(chatCalls, 2);
    assert.equal(svc.getRun(queued.id).status, 'completed');
    assert.equal(svc.getGoal(queuedGoalId).status, 'executing');
    assert.equal(svc.getDirector('project-director-1').activeGoalId, queuedGoalId);
  });

  it('preserves queued Goal turns across restart instead of marking them interrupted', () => {
    const first = service();
    seedActiveGoal(first, { taskId: 't_active_before_restart' });
    const queued = first.submitMessage('project-director-1', '다음 기능도 구현해줘', { mode: 'delegate' });
    const restarted = new DirectorService({
      runtime: runtime(), stateFile: first.stateFile, projectsRoot: 'C:\\projects',
      getProjects: () => [{ id: 'alpha', name: 'Alpha', path: 'C:\\projects\\alpha' }],
    });
    assert.equal(restarted.getRun(queued.id).status, 'queued');
    assert.equal(restarted.getGoal(restarted.getRun(queued.id).goalId).status, 'queued');
    assert.equal(restarted.summary().queuedGoals.length, 1);
  });

  it('records selectedOption once and rejects a duplicate Owner decision', async () => {
    let chatCalls = 0;
    const svc = service({ runtime: runtime({
      chat: async () => ({ stdout: ++chatCalls === 1 ? analysisOutput() : ownerDecisionOutput() }),
    }) });
    const run = svc.submitMessage('project-director-1', '호환성을 정하고 구현해줘', { mode: 'delegate' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const completedTurn = svc.getRun(run.id);
    const goal = svc.getGoal(completedTurn.goalId);
    assert.equal(completedTurn.status, 'completed');
    assert.equal(goal.status, 'awaiting_owner');

    const acceptedPromise = svc.answerGoalDecision('project-director-1', goal.id, {
      answer: '기존 호환성을 유지해.', selectedOption: 'keep',
    });
    const duplicateRejection = assert.rejects(
      svc.answerGoalDecision('project-director-1', goal.id, { answer: '중복', selectedOption: 'change' }),
      /not awaiting an Owner decision/i,
    );
    const accepted = await acceptedPromise;
    await duplicateRejection;
    assert.equal(accepted.ownerAnswers.length, 1);
    assert.equal(accepted.ownerAnswers[0].answer, '기존 호환성을 유지해.');
    assert.equal(accepted.ownerAnswers[0].selectedOption, 'keep');
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

  it('rejects pausing a terminal task without changing its durable Goal state', async () => {
    const externalCalls = [];
    const svc = service({ runtime: runtime({
      taskDetails: async () => ({ task: { id: 't_terminal', status: 'done' } }),
      reclaimTask: async () => { externalCalls.push('reclaim'); },
      blockTask: async () => { externalCalls.push('block'); },
    }) });
    const goal = seedActiveGoal(svc, { taskId: 't_terminal' });
    Object.assign(goal.taskRecords[0], {
      status: 'done', completedAt: '2026-08-24T00:02:00.000Z', pausedByOwner: false, pausePending: false,
    });
    Object.assign(goal.waves[0], { status: 'completed', completedAt: '2026-08-24T00:02:00.000Z' });
    const before = JSON.parse(JSON.stringify({ phase: goal.phase, record: goal.taskRecords[0], wave: goal.waves[0] }));

    await assert.rejects(
      svc.controlTask('project-director-1', 't_terminal', 'pause', 'pause too late'),
      /Cannot pause terminal task \(done\)/,
    );

    assert.deepEqual({ phase: goal.phase, record: goal.taskRecords[0], wave: goal.waves[0] }, before);
    assert.deepEqual(externalCalls, []);
  });

  it('recovers a persisted pause intent and blocks the Worker before dispatch', async () => {
    let boardStatus = 'running';
    const calls = [];
    const recoveringRuntime = runtime({
      listTasks: async () => {
        calls.push(`list:${boardStatus}`);
        return [{ id: 't_pause_pending', status: boardStatus }];
      },
      taskDetails: async () => ({ task: { id: 't_pause_pending', status: boardStatus } }),
      reclaimTask: async () => { calls.push('reclaim'); },
      blockTask: async () => { calls.push('block'); boardStatus = 'blocked'; },
      dispatch: async ({ max }) => {
        calls.push(`dispatch:${max}`);
        return { json: { spawned: max } };
      },
    });
    const first = service({ runtime: recoveringRuntime });
    const goal = seedActiveGoal(first, { taskId: 't_pause_pending', phase: 'pause_requested' });
    Object.assign(goal.taskRecords[0], {
      status: 'paused', pausedByOwner: true, pausePending: true,
      pausedAt: '2026-08-24T00:01:00.000Z', completedAt: null,
    });
    goal.waves[0].status = 'queued';
    first._save();

    const restarted = new DirectorService({
      runtime: recoveringRuntime,
      stateFile: first.stateFile,
      projectsRoot: 'C:\\projects',
      getProjects: () => [{ id: 'alpha', name: 'Alpha', path: 'C:\\projects\\alpha' }],
    });
    const result = await restarted.tickDirector('project-director-1');
    const recovered = restarted.getGoal(goal.id);
    const record = recovered.taskRecords[0];

    assert.ok(calls.indexOf('block') >= 0);
    assert.ok(calls.indexOf('block') < calls.indexOf('dispatch:0'), `unexpected recovery order: ${calls.join(', ')}`);
    assert.equal(result.allocated, 0);
    assert.equal(record.pausePending, false);
    assert.equal(record.pausedByOwner, true);
    assert.equal(record.status, 'paused');
    assert.equal(record.completedAt, null);
    assert.equal(recovered.phase, 'paused_by_owner');
  });

  it('fails a current Worker only after three consecutive missing observations and resets the counter when seen', async () => {
    let visible = false;
    const svc = service({ runtime: runtime({
      listTasks: async () => visible ? [{ id: 't_loss', status: 'running' }] : [],
      taskDetails: async () => {
        if (!visible) throw new Error('task missing');
        return { task: { id: 't_loss', status: 'running' } };
      },
      dispatch: async ({ max }) => ({ json: { spawned: max } }),
    }) });
    const goal = seedActiveGoal(svc, { taskId: 't_loss' });

    await svc.tickDirector('project-director-1');
    assert.equal(goal.taskRecords[0].missingObservations, 1);

    visible = true;
    await svc.tickDirector('project-director-1');
    assert.equal(goal.taskRecords[0].missingObservations, 0);
    assert.equal(goal.taskRecords[0].missingSince, null);

    visible = false;
    await svc.tickDirector('project-director-1');
    await svc.tickDirector('project-director-1');
    assert.equal(goal.taskRecords[0].missingObservations, 2);
    assert.equal(goal.taskRecords[0].status, 'running');

    svc.getDirector('project-director-1').status = 'running';
    const thirdMiss = await svc.tickDirector('project-director-1');
    assert.equal(goal.taskRecords[0].missingObservations, 3);
    assert.equal(goal.taskRecords[0].status, 'failed');
    assert.equal(goal.taskRecords[0].failureKind, 'lost_task');
    assert.ok(goal.taskRecords[0].completedAt);
    assert.equal(thirdMiss.supervision.ready, true);
    assert.equal(thirdMiss.supervision.deferred, true);
  });

  it('keeps an active Goal in summary even when it is older than the latest 50 Goals', () => {
    const svc = service();
    const active = seedActiveGoal(svc, { taskId: 't_old_active' });
    for (let index = 0; index < 55; index += 1) {
      svc.state.goals.push({
        ...active,
        id: `goal-completed-${index}`,
        status: 'completed',
        phase: 'completed',
        taskIds: [],
        currentWaveTaskIds: [],
        taskRecords: [],
        waves: [],
        completedAt: `2026-08-24T01:${String(index).padStart(2, '0')}:00.000Z`,
      });
    }

    assert.equal(svc.listGoals({ limit: 50 }).some(goal => goal.id === active.id), false);
    const summary = svc.summary();
    assert.deepEqual(summary.activeGoals.map(goal => goal.id), [active.id]);
    assert.equal(summary.goals.filter(goal => goal.id === active.id).length, 1);
    assert.equal(summary.goals[0].id, active.id);
  });

  it('compacts only terminal history and reports durable retention metrics', () => {
    const svc = service();
    const active = seedActiveGoal(svc, { taskId: 't_retention_active' });
    for (let index = 0; index < 510; index += 1) {
      svc.state.goals.push({
        id: `goal-retained-${index}`, directorId: 'project-director-1', projectId: 'alpha',
        objective: `terminal ${index}`, status: 'completed', phase: 'completed',
        taskIds: [], currentWaveTaskIds: [], taskRecords: [], waves: [], events: [],
        createdAt: new Date(1700000000000 + index * 1000).toISOString(),
        updatedAt: new Date(1700000000000 + index * 1000).toISOString(),
        completedAt: new Date(1700000000000 + index * 1000).toISOString(),
      });
    }
    for (let index = 0; index < 2100; index += 1) {
      svc.state.runs.push({
        id: `historical-run-${index}`, directorId: 'project-director-1', projectId: 'alpha',
        status: 'completed', createdAt: new Date(1700000000000 + index * 1000).toISOString(),
      });
    }
    svc._save();
    assert.equal(svc.state.goals.filter(goal => goal.status === 'completed').length, 500);
    assert.ok(svc.state.goals.includes(active));
    assert.equal(svc.state.runs.length, 2000);
    assert.equal(svc.summary().retention.prunedGoals, 10);
    assert.equal(svc.summary().retention.prunedRuns, 100);
    assert.ok(svc.summary().persistence.lastBytes > 0);
  });

  it('retains terminal Goals by completion recency instead of creation order', () => {
    const svc = service();
    const recentlyCompleted = {
      id: 'goal-long-running-recent-completion', directorId: 'project-director-1', projectId: 'alpha',
      objective: 'long-running Goal', status: 'completed', phase: 'completed',
      taskIds: [], currentWaveTaskIds: [], taskRecords: [], waves: [], events: [],
      createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
      completedAt: '2030-01-01T00:00:00.000Z',
    };
    svc.state.goals.push(recentlyCompleted);
    for (let index = 0; index < 500; index += 1) {
      svc.state.goals.push({
        id: `goal-older-completion-${index}`, directorId: 'project-director-1', projectId: 'alpha',
        objective: `older completion ${index}`, status: 'completed', phase: 'completed',
        taskIds: [], currentWaveTaskIds: [], taskRecords: [], waves: [], events: [],
        createdAt: new Date(1750000000000 + index * 1000).toISOString(),
        updatedAt: new Date(1750000000000 + index * 1000).toISOString(),
        completedAt: new Date(1750000000000 + index * 1000).toISOString(),
      });
    }

    svc._save();
    assert.equal(svc.state.goals.length, 500);
    assert.equal(svc.getGoal(recentlyCompleted.id), recentlyCompleted);
    assert.equal(svc.getGoal('goal-older-completion-0'), null);
  });

  it('atomically migrates active Goal and run ownership when its project changes Director slots', () => {
    let projects = [
      { id: 'alpha', name: 'Alpha', path: 'C:\\projects\\alpha', slot: 1 },
      { id: 'beta', name: 'Beta', path: 'C:\\projects\\beta', slot: 2 },
      { id: 'gamma', name: 'Gamma', path: 'C:\\projects\\gamma', slot: 3 },
    ];
    const svc = service({ getProjects: () => projects });
    const goal = seedActiveGoal(svc, { taskId: 't_beta', directorId: 'project-director-2' });
    svc.state.runs.push({
      id: 'run-beta-goal', goalId: goal.id, directorId: 'project-director-2', projectId: 'beta',
      status: 'completed', prompt: 'beta objective', output: 'delegated', createdAt: goal.createdAt,
      startedAt: goal.createdAt, completedAt: goal.createdAt,
    });
    svc._save();

    projects = [
      { id: 'beta', name: 'Beta', path: 'C:\\projects\\beta', slot: 1 },
      { id: 'alpha', name: 'Alpha', path: 'C:\\projects\\alpha', slot: 2 },
      { id: 'gamma', name: 'Gamma', path: 'C:\\projects\\gamma', slot: 3 },
    ];
    svc.syncProjects();

    assert.equal(svc.getDirector('project-director-1').projectId, 'beta');
    assert.equal(svc.getDirector('project-director-1').activeGoalId, goal.id);
    assert.notEqual(svc.getDirector('project-director-2').activeGoalId, goal.id);
    assert.equal(svc.getGoal(goal.id).directorId, 'project-director-1');
    assert.equal(svc.getRun('run-beta-goal').directorId, 'project-director-1');
    assert.equal(svc.listGoals({ directorId: 'project-director-2' }).some(item => item.id === goal.id), false);

    const persisted = JSON.parse(readFileSync(svc.stateFile, 'utf8'));
    assert.equal(persisted.goals.find(item => item.id === goal.id).directorId, 'project-director-1');
    assert.equal(persisted.runs.find(item => item.id === 'run-beta-goal').directorId, 'project-director-1');
  });

  it('shares one adaptive allocation cap across three simultaneous project board ticks', async () => {
    const allocations = [];
    const readyTasks = Array.from({ length: 12 }, (_, index) => ({
      id: `t_ready_${index}`, status: 'ready', assignee: 'convention-reviewer',
    }));
    const svc = service({
      getProjects: () => [
        { id: 'alpha', name: 'Alpha', path: 'C:\\projects\\alpha', slot: 1 },
        { id: 'beta', name: 'Beta', path: 'C:\\projects\\beta', slot: 2 },
        { id: 'gamma', name: 'Gamma', path: 'C:\\projects\\gamma', slot: 3 },
      ],
      runtime: runtime({
        listTasks: async () => readyTasks,
        dispatch: async ({ board, max }) => {
          allocations.push({ board, max });
          await new Promise(resolve => setTimeout(resolve, 20));
          return { json: { spawned: max } };
        },
      }),
    });

    const results = await Promise.all([
      svc.tickDirector('project-director-1'),
      svc.tickDirector('project-director-2'),
      svc.tickDirector('project-director-3'),
    ]);
    const globalCap = adaptiveWorkerLimit({ ready: 36, running: 0 });
    const allocated = allocations.reduce((sum, entry) => sum + entry.max, 0);

    assert.equal(allocations.length, 3);
    assert.equal(allocated, globalCap);
    assert.equal(results.reduce((sum, result) => sum + result.allocated, 0), globalCap);
    assert.ok(allocations.every(entry => entry.max >= 0));
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

  it('recomputes the exact persisted authority digest before resuming an approved plan', () => {
    const action = {
      id: 'publish', title: 'Publish release', target: 'codex-implementer',
      task: 'Publish only the staged release.', effect: 'external_mutation',
      skills: [], dependencies: [], writeScope: ['release/'],
      acceptance: ['release receipt'], wakeOn: ['completion'],
    };
    const planDigest = _test.actionPlanDigest([action]);
    const pending = {
      kind: 'actions', planDigest,
      plan: { mode: 'delegate', state: 'executing', workflowId: 'quick-fix', actions: [action] },
    };
    assert.equal(_test.persistedAuthorityPlanDigest(pending), planDigest);

    pending.plan.actions[0].task = 'Publish a different target.';
    assert.notEqual(_test.persistedAuthorityPlanDigest(pending), planDigest);
    pending.plan.state = 'blocked';
    assert.equal(_test.persistedAuthorityPlanDigest(pending), null);
  });

  it('requires an authority action to be isolated behind a current host-receipted gate', () => {
    const svc = service();
    const goal = seedActiveGoal(svc, { taskId: 't_authority_writer' });
    goal.currentCandidate = { revision: 'candidate-v1', digest: 'sha256:candidate-v1' };
    const external = {
      id: 'publish', title: 'Publish release', target: 'codex-implementer',
      task: 'Publish the exact approved candidate.', effect: 'external_mutation',
      skills: [], dependencies: [], writeScope: ['release/'],
      acceptance: ['host-observed publish receipt'], wakeOn: ['completion'],
    };
    const localWrite = {
      id: 'prepare', title: 'Prepare artifact', target: 'codex-implementer',
      task: 'Modify the local artifact payload.', effect: 'workspace_write',
      skills: [], dependencies: [], writeScope: ['artifact/'], acceptance: ['tests pass'], wakeOn: ['completion'],
    };
    const mislabeledExternal = {
      ...external, id: 'mislabeled-publish', effect: 'workspace_write',
    };

    assert.throws(
      () => svc._assertAuthorityActionPrerequisites(goal, [mislabeledExternal], null),
      /must declare effect as external_mutation/,
    );
    assert.throws(
      () => svc._assertAuthorityActionPrerequisites(goal, [localWrite, external], null),
      /must be the only action in its wave/,
    );
    assert.throws(
      () => svc._assertAuthorityActionPrerequisites(goal, [external], null),
      /fresh host-receipted review and quality-gate wave/,
    );

    const gateAudit = {
      workflowId: 'quick-fix',
      missingProfiles: [],
      creditedTaskIds: {
        'codex-implementer': 't_authority_writer',
        'convention-reviewer': 't_convention',
        'test-gap-reviewer': 't_test_gap',
        'adversarial-reviewer': 't_adversarial',
        'quality-gate-reviewer': 't_gate',
      },
      approvedGateTaskId: 't_gate',
      gateConsistency: { satisfied: true, reasons: [] },
      hostReceipts: { required: true, satisfied: true },
      hostCandidate: { revision: 'candidate-v1', digest: 'sha256:candidate-v1' },
    };
    assert.doesNotThrow(() => svc._assertAuthorityActionPrerequisites(goal, [external], gateAudit));

    goal.currentCandidate = { revision: 'candidate-v2', digest: 'sha256:candidate-v2' };
    assert.throws(
      () => svc._assertAuthorityActionPrerequisites(goal, [external], gateAudit),
      /fresh host-receipted review and quality-gate wave/,
    );
  });

  it('permits the first skill activation only as an explicit rollback-safe canary', () => {
    const svc = service();
    const goal = seedActiveGoal(svc, {
      taskId: 't_skill_build', directorId: 'skill-director', projectId: null,
      workflowId: 'skill-development', analysis: { recommendedWorkflow: 'skill-development' },
    });
    goal.currentCandidate = { revision: 'skill-v1', digest: 'sha256:skill-v1' };
    const gateAudit = {
      workflowId: 'skill-development', missingProfiles: [],
      creditedTaskIds: {
        'codex-implementer': 't_skill_build',
        'adversarial-reviewer': 't_skill_adversarial',
        'quality-gate-reviewer': 't_skill_gate',
      },
      approvedGateTaskId: 't_skill_gate',
      gateConsistency: { satisfied: true, reasons: [] },
      hostReceipts: { required: true, satisfied: true },
      hostCandidate: { revision: 'skill-v1', digest: 'sha256:skill-v1' },
    };
    const activate = {
      id: 'activate', title: 'Activate skill', target: 'codex-implementer',
      task: 'Activate the approved skill.', effect: 'skill_activation',
      skills: [], dependencies: [], writeScope: ['skill-registry/'],
      acceptance: ['activation receipt'], wakeOn: ['completion'],
    };

    assert.throws(
      () => svc._assertAuthorityActionPrerequisites(goal, [activate], gateAudit),
      /limited canary with rollback acceptance/,
    );
    const canary = {
      ...activate,
      title: 'Limited canary activation',
      task: 'Activate only the bounded canary cohort and stop on failure.',
      acceptance: ['Host receipt identifies the canary cohort', 'Rollback restores the previous registry entry'],
    };
    assert.doesNotThrow(() => svc._assertAuthorityActionPrerequisites(goal, [canary], gateAudit));
  });

  it('does not resume a blocked Worker after its durable Goal is terminal', async () => {
    let unblocked = false;
    const svc = service({ runtime: runtime({
      taskDetails: async () => ({ task: { id: 't_terminal_goal', status: 'blocked' } }),
      unblockTask: async () => { unblocked = true; },
    }) });
    const goal = seedActiveGoal(svc, { taskId: 't_terminal_goal' });
    goal.status = 'completed';
    goal.phase = 'completed';
    goal.completedAt = '2026-08-24T01:00:00.000Z';

    await assert.rejects(
      svc.controlTask('project-director-1', 't_terminal_goal', 'resume'),
      /terminal Goal/,
    );
    assert.equal(unblocked, false);
    assert.equal(goal.taskRecords[0].status, 'running');
  });
});
