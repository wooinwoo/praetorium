import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConversation, buildTrace, goalControlOptions, goalTasks, interventionReceiptText, ownerDecisionPayload, statusText, statusTone, textValue } from '../../src/domain/operator-model.js';
import { connectionNotification, deriveGoalNotifications, deriveWorkerNotifications, mergeNotifications } from '../../src/domain/notification-model.js';
import { runNeedsFullOutput, withFullRunOutputs } from '../../src/hooks/usePraetorium.js';

test('operator model merges durable task records with fresher board state', () => {
  const tasks = goalTasks([
    { id: 't1', status: 'running', title: 'live title', updated_at: '2026-08-26T02:00:00Z' },
  ], {
    taskIds: ['t1', 't2'],
    taskRecords: [
      { taskId: 't1', status: 'queued', profile: 'implementer', summary: 'durable summary' },
      { taskId: 't2', status: 'todo', title: 'record only', createdAt: '2026-08-26T03:00:00Z' },
    ],
  });
  assert.deepEqual(tasks.map(task => task.id), ['t1', 't2']);
  assert.equal(tasks[0].status, 'running');
  assert.equal(tasks[0].summary, 'durable summary');
  assert.equal(tasks[0].profile, 'implementer');
});

test('operator model creates chronological selectable trace with honest final state', () => {
  const trace = buildTrace({
    id: 'g1', objective: 'ship', status: 'completed', workflowId: 'quick-fix',
    createdAt: '2026-08-26T01:00:00Z', completedAt: '2026-08-26T04:00:00Z',
    events: [{ id: 'e1', kind: 'task', phase: 'executing', at: '2026-08-26T02:00:00Z', message: 'assigned', details: { taskId: 't1' } }],
    finalReport: { summary: 'verified result' },
  }, [], [{ id: 't1', status: 'done', title: 'work', completed_at: '2026-08-26T03:00:00Z' }]);
  assert.deepEqual(trace.map(item => item.id), ['goal:g1', 'event:e1', 'task:t1', 'final:g1']);
  assert.equal(trace[1].taskId, 't1');
  assert.deepEqual(trace.map(item => item.depth), [0, 2, 2, 1]);
  assert.equal(trace.at(-1).detail, 'verified result');
});

test('operator model exposes Wave boundaries and dependency depth', () => {
  const trace = buildTrace({
    id: 'g-wave', objective: 'ship', status: 'executing', createdAt: '2026-08-26T01:00:00Z',
    taskIds: ['root', 'review'],
    waves: [{ id: 'w1', index: 1, kind: 'implementation', status: 'running', startedAt: '2026-08-26T01:30:00Z', taskIds: ['root', 'review'] }],
  }, [], [
    { id: 'root', waveId: 'w1', status: 'done', title: 'implement', createdAt: '2026-08-26T02:00:00Z' },
    { id: 'review', waveId: 'w1', parentTaskIds: ['root'], status: 'running', title: 'review', createdAt: '2026-08-26T03:00:00Z' },
  ]);
  assert.deepEqual(trace.map(item => item.id), ['goal:g-wave', 'wave:w1', 'task:root', 'task:review']);
  assert.equal(trace.find(item => item.id === 'wave:w1').depth, 1);
  assert.equal(trace.find(item => item.id === 'task:root').depth, 2);
  assert.equal(trace.find(item => item.id === 'task:review').depth, 3);
  assert.match(trace.find(item => item.id === 'task:review').detail, /선행 작업 · root/);
});

test('operator model keeps Owner prompt, Director answer, decision, and final conclusion durable', () => {
  const conversation = buildConversation({
    id: 'g1', updatedAt: '2026-08-26T05:00:00Z', finalReport: 'done',
    runs: [{ id: 'r1', prompt: 'fix it', output: 'working', status: 'running', createdAt: '2026-08-26T01:00:00Z', startedAt: '2026-08-26T02:00:00Z' }],
    ownerAnswers: [{ id: 'a1', answer: 'continue', at: '2026-08-26T03:00:00Z' }],
  }, {}, {});
  assert.deepEqual(conversation.map(item => [item.role, item.kind]), [
    ['owner', '요청'], ['director', '판단 중'], ['owner', '오너 결정'], ['director', '최종 결론'],
  ]);
});

test('operator model separates project chat from the selected Goal record', () => {
  const goal = {
    id: 'g1', runs: [{ id: 'goal-run', goalId: 'g1', prompt: 'build', output: 'delegated', status: 'completed' }],
  };
  const summary = {
    recentRuns: [{ id: 'chat-run', projectId: 'p1', prompt: 'status?', output: 'healthy', status: 'completed' }],
  };
  const director = { kind: 'project', projectId: 'p1' };
  assert.deepEqual(buildConversation(goal, summary, director, 'goal').map(item => item.text), ['build', 'delegated']);
  assert.deepEqual(buildConversation(goal, summary, director, 'project').map(item => item.text), ['status?', 'healthy']);
});

test('operator notifications emit only state transitions and group worker completions', () => {
  const previous = {
    directors: [{ id: 'd1', name: 'AgencyPro' }],
    notificationGoals: [{ id: 'g1', directorId: 'd1', objective: 'Ship', status: 'executing', ownerDecision: null }],
  };
  const current = {
    directors: previous.directors,
    notificationGoals: [{ ...previous.notificationGoals[0], status: 'completed', completedAt: '2026-08-26T01:00:00Z' }],
  };
  assert.deepEqual(deriveGoalNotifications(null, current), []);
  const goals = deriveGoalNotifications(previous, current, '2026-08-26T01:01:00Z');
  assert.equal(goals.length, 1);
  assert.equal(goals[0].kind, 'goal_completed');

  const workers = deriveWorkerNotifications(
    [
      { id: 't1', directorId: 'd1', goalId: 'g1', status: 'running' },
      { id: 't2', directorId: 'd1', goalId: 'g1', status: 'review' },
    ],
    [
      { id: 't1', directorId: 'd1', goalId: 'g1', goalObjective: 'Ship', status: 'done', title: 'Build' },
      { id: 't2', directorId: 'd1', goalId: 'g1', goalObjective: 'Ship', status: 'success', title: 'Review' },
    ],
    '2026-08-26T01:02:00Z',
  );
  assert.equal(workers.length, 1);
  assert.equal(workers[0].title, 'Worker 2개 완료');
  assert.equal(workers[0].createdAt, '2026-08-26T01:02:00Z');
  assert.equal(workers[0].goalId, 'g1');
  const fastGoal = deriveGoalNotifications(
    { directors: previous.directors, notificationGoals: [] },
    { directors: previous.directors, notificationGoals: [{ ...current.notificationGoals[0], completedAt: '2026-08-26T01:03:00Z', updatedAt: '2026-08-26T01:03:00Z' }] },
    '2026-08-26T01:03:01Z',
    '2026-08-26T01:02:59Z',
  );
  assert.equal(fastGoal[0].kind, 'goal_completed');
  const fastWorker = deriveWorkerNotifications(
    [],
    [{ id: 't3', directorId: 'd1', goalId: 'g1', goalObjective: 'Ship', status: 'done', title: 'Fast', updatedAt: '2026-08-26T01:03:00Z' }],
    '2026-08-26T01:03:01Z',
    '2026-08-26T01:02:59Z',
  );
  assert.equal(fastWorker[0].taskId, 't3');
  assert.equal(deriveWorkerNotifications(
    [],
    [{ id: 't-old', directorId: 'd1', status: 'done', updatedAt: '2026-08-26T01:00:00Z' }],
    '2026-08-26T01:03:01Z',
    '2026-08-26T01:03:02Z',
  ).length, 0);
  const connected = connectionNotification('offline', '2026-08-26T01:03:00Z');
  assert.equal(mergeNotifications(goals, [goals[0], connected]).length, 2);
});

test('Owner console replaces compact previews with complete Director answers', () => {
  const summary = {
    recentRuns: [
      { id: 'run-clipped', output: 'GitHub 기준 활동 계정 3개…' },
      { id: 'run-complete', output: '짧은 답변' },
    ],
  };
  const hydrated = withFullRunOutputs(summary, new Map([
    ['run-clipped', 'GitHub 기준 활동 계정 3개, 미병합 작업 단위 8개입니다.\n\n- 전체 결과'],
  ]));

  assert.equal(hydrated.recentRuns[0].output, 'GitHub 기준 활동 계정 3개, 미병합 작업 단위 8개입니다.\n\n- 전체 결과');
  assert.equal(hydrated.recentRuns[0].outputTruncated, false);
  assert.equal(hydrated.recentRuns[1], summary.recentRuns[1]);
  assert.equal(runNeedsFullOutput({ id: 'run-clipped', outputTruncated: true }, new Map()), true);
  assert.equal(runNeedsFullOutput({ id: 'legacy-clipped', output: '구형 서버 미리보기…' }, new Map()), true);
  assert.equal(runNeedsFullOutput({ id: 'run-complete', output: '조금 더 확인해 볼게요…', outputTruncated: false }, new Map()), false);
});

test('typed Owner decisions cannot inherit a preselected authority option', () => {
  assert.deepEqual(ownerDecisionPayload('승인', '거절합니다'), { answer: '거절합니다' });
  assert.deepEqual(ownerDecisionPayload('승인', ''), { answer: '승인', selectedOption: '승인' });
  assert.equal(ownerDecisionPayload('', '  '), null);
});

test('React Goal controls and intervention receipts preserve operational truth', () => {
  assert.deepEqual(goalControlOptions({ status: 'queued' }).map(item => [item.action, item.position]), [
    ['reorder', 'front'], ['reorder', 'back'], ['defer', undefined], ['cancel', undefined],
  ]);
  assert.deepEqual(goalControlOptions({ status: 'blocked' }).map(item => item.action), ['retry', 'cancel']);
  assert.deepEqual(goalControlOptions({ status: 'failed', phase: 'cancelled' }), []);
  assert.match(interventionReceiptText({ status: 'delivery_failed' }), /자동 재시도.*다시 보내지 마세요/);
  assert.equal(interventionReceiptText({ workerObserved: true }), 'Worker 확인됨');
});

test('operator model formats evidence without dumping raw object braces', () => {
  assert.equal(textValue({ taskId: 't1', attempts: 2 }), 'taskId · t1 · attempts · 2');
  assert.equal(statusText('awaiting_owner'), '오너 판단');
  assert.equal(statusText('succeeded'), '완료');
  assert.equal(statusTone('blocked'), 'attention');
  assert.equal(statusTone('success'), 'done');
  assert.equal(statusTone('failed'), 'failed');
});
