import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildConversation, buildTrace, deriveSupervisionHealth, goalConclusionPresentation, goalControlOptions, goalSupervisionHealth,
  goalTasks, interventionReceiptText, orderQueuedGoals, ownerDecisionPayload, statusText, statusTone,
  taskDisplayStatus, taskIsTerminal, taskPausedByOwner, textValue,
} from '../../src/domain/operator-model.js';
import {
  connectionNotification, deriveGoalNotifications, derivePersistentGoalNotifications, deriveWorkerNotifications,
  mergeNotifications, reconcilePersistentGoalNotifications,
} from '../../src/domain/notification-model.js';
import { directorActivityMessage } from '../../src/hooks/useDirectorActivity.js';
import { runNeedsFullOutput, taskEvidenceIsSettled, withFullRunOutputs } from '../../src/hooks/usePraetorium.js';
import { timestampMs } from '../../src/lib/time.js';
import { validateImageSelection } from '../../src/lib/image-attachments.js';

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

test('operator model shows a persisted queued message as accepted', () => {
  const messages = buildConversation(null, {
    recentRuns: [{ id: 'queued-chat', projectId: 'p1', prompt: 'keep this', status: 'queued', phase: 'waiting_for_director', createdAt: '2026-08-27T01:00:00Z' }],
  }, { kind: 'project', projectId: 'p1' }, 'project');
  assert.deepEqual(messages.map(item => [item.kind, item.text]), [
    ['요청', 'keep this'], ['접수됨', '판단 진행 중 · 디렉터 대기'],
  ]);
});

test('operator model restores persisted attachment thumbnails through the selected Director route', () => {
  const attachment = {
    id: 'attachment_11111111-1111-4111-8111-111111111111', name: 'screen.png', mimeType: 'image/png',
  };
  const [message] = buildConversation({
    id: 'g1',
    runs: [{ id: 'r1', goalId: 'g1', prompt: '이 화면대로', status: 'completed', attachments: [attachment] }],
  }, {}, { id: 'project-director-1', kind: 'project', projectId: 'p1' }, 'goal');
  assert.equal(
    message.attachments[0].previewUrl,
    '/api/directors/project-director-1/attachments/attachment_11111111-1111-4111-8111-111111111111',
  );
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

test('unresolved Owner decisions become one persistent first-load attention until resolved', () => {
  const waiting = {
    directors: [{ id: 'd1', name: 'AgencyPro' }],
    notificationGoals: [{
      id: 'g-wait', directorId: 'd1', objective: 'Ship safely', status: 'awaiting_owner', updatedAt: '2026-08-26T01:00:00Z',
      ownerDecision: { required: true, askedAt: '2026-08-26T00:59:00Z', question: '배포할까요?' },
    }],
  };
  const initial = deriveGoalNotifications(null, waiting, '2026-08-26T01:01:00Z');
  assert.equal(initial.length, 1);
  assert.equal(initial[0].kind, 'owner_decision');
  assert.equal(initial[0].persistent, true);
  assert.equal(initial[0].createdAt, '2026-08-26T00:59:00Z');
  assert.match(initial[0].body, /배포할까요/);
  assert.deepEqual(derivePersistentGoalNotifications(waiting).map(item => item.id), [initial[0].id]);

  const once = reconcilePersistentGoalNotifications([], waiting);
  const twice = reconcilePersistentGoalNotifications(once, waiting);
  assert.equal(twice.length, 1);
  assert.equal(twice[0].id, initial[0].id);
  const acknowledged = reconcilePersistentGoalNotifications([{ ...twice[0], read: true }], waiting);
  assert.equal(acknowledged[0].read, true);

  const resolved = { ...waiting, notificationGoals: [{ ...waiting.notificationGoals[0], status: 'executing', ownerDecision: null }] };
  assert.deepEqual(reconcilePersistentGoalNotifications(acknowledged, resolved), []);

  const legacyWaiting = {
    directors: waiting.directors,
    notificationGoals: [{ id: 'g-legacy', directorId: 'd1', objective: 'Legacy', status: 'awaiting_owner', ownerDecision: { required: true, question: '선택?' } }],
  };
  const legacyFirst = reconcilePersistentGoalNotifications([], legacyWaiting, '2026-08-26T02:00:00Z');
  const legacyAgain = reconcilePersistentGoalNotifications(legacyFirst, legacyWaiting, '2026-08-26T03:00:00Z');
  assert.equal(legacyAgain.length, 1);
  assert.equal(legacyAgain[0].id, 'goal:g-legacy:decision:pending');
  assert.equal(legacyAgain[0].createdAt, '2026-08-26T02:00:00Z');

  const newerOrdinary = Array.from({ length: 100 }, (_, index) => ({
    id: `ordinary-${index}`, kind: 'goal_completed', title: 'done', body: 'done', tone: 'done',
    createdAt: new Date(Date.parse('2026-08-27T00:00:00Z') + index * 1000).toISOString(), read: false,
  }));
  const capped = reconcilePersistentGoalNotifications(newerOrdinary, waiting, '2026-08-27T01:00:00Z', 100);
  assert.equal(capped.length, 100);
  assert.equal(capped[0].id, initial[0].id);
  assert.equal(capped.filter(item => item.persistent).length, 1);
  assert.equal(capped.filter(item => !item.persistent).length, 99);
});

test('latest Goal conclusion distinguishes final results, Owner decisions, and active work', () => {
  const completed = goalConclusionPresentation({ status: 'completed', finalReport: '최종 검증 통과' }, [{ output: '이전 응답' }]);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.label, '완료 · Goal 최종 결과');
  assert.equal(completed.content, '최종 검증 통과');

  const waiting = goalConclusionPresentation({
    status: 'awaiting_owner', ownerDecision: { required: true, question: '실제 배포할까요?' },
  }, [{ output: '끝났습니다.' }]);
  assert.equal(waiting.state, 'awaiting_owner');
  assert.equal(waiting.label, '완료 아님 · 오너 결정 대기');
  assert.equal(waiting.content, '실제 배포할까요?');
  assert.equal(waiting.action, '결정 화면에서 지금 응답하기');

  const active = goalConclusionPresentation({ status: 'executing' }, [{ output: '진행 공개 체크포인트' }]);
  assert.equal(active.state, 'active');
  assert.equal(active.label, '진행 중 · 실행 중');
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
  assert.equal(statusText('triage'), '수동 확인');
  assert.equal(statusTone('triage'), 'attention');
  assert.deepEqual(goalControlOptions({ status: 'queued' }).map(item => [item.action, item.position]), [
    ['reorder', 'front'], ['reorder', 'back'], ['defer', undefined], ['cancel', undefined],
  ]);
  assert.deepEqual(goalControlOptions({ status: 'blocked' }).map(item => item.action), ['retry', 'cancel']);
  assert.deepEqual(goalControlOptions({ status: 'executing' }).map(item => item.action), ['cancel']);
  assert.deepEqual(goalControlOptions({ status: 'failed', phase: 'cancelled' }), []);
  assert.match(interventionReceiptText({ status: 'delivery_failed' }), /자동 재시도.*다시 보내지 마세요/);
  assert.equal(interventionReceiptText({ workerObserved: true }), 'Worker 확인됨');
});

test('selected Worker public checkpoints appear in the Goal trace', () => {
  const trace = buildTrace({
    id: 'g-checkpoints', objective: 'ship', status: 'executing', createdAt: '2026-08-26T01:00:00Z',
    taskIds: ['worker'], waves: [{ id: 'wave', index: 1, status: 'running', taskIds: ['worker'] }],
  }, [], [{
    id: 'worker', waveId: 'wave', status: 'running', title: '검증', started_at: 1787750437,
    comments: [
      { body: 'PLAN: 원문을 확인한다.', author: 'codex-implementer', created_at: 1787750438 },
      { body: 'OBSERVED: 후보 4건을 확인했다.', author: 'codex-implementer', created_at: 1787750439 },
    ],
  }]);
  const checkpoints = trace.filter(item => item.type === 'worker_checkpoint');
  assert.deepEqual(checkpoints.map(item => item.eyebrow), ['WAVE 1 · PLAN', 'WAVE 1 · OBSERVED']);
  assert.deepEqual(checkpoints.map(item => item.title), ['원문을 확인한다.', '후보 4건을 확인했다.']);
  assert.ok(trace.indexOf(checkpoints[0]) > trace.findIndex(item => item.id === 'task:worker'));
});

test('paused blocked Workers remain active, resumable, and visibly paused', () => {
  const paused = { id: 't-paused', status: 'blocked', pausedByOwner: true };
  assert.equal(taskPausedByOwner(paused), true);
  assert.equal(taskDisplayStatus(paused), 'paused');
  assert.equal(taskIsTerminal(paused), false);
  assert.equal(taskIsTerminal({ id: 't-blocked', status: 'blocked' }), true);
  assert.equal(taskEvidenceIsSettled({
    status: 'blocked', pausedByOwner: true, selectedTaskId: 't-paused',
    detailStatus: 'blocked', detailPausedByOwner: true, detailTaskId: 't-paused', traceTaskId: 't-paused',
  }), false);
  assert.equal(taskEvidenceIsSettled({
    status: 'blocked', pausedByOwner: false, selectedTaskId: 't-blocked',
    detailStatus: 'blocked', detailTaskId: 't-blocked', traceTaskId: 't-blocked',
  }), true);
  assert.equal(taskEvidenceIsSettled({
    status: 'running', pausedByOwner: false, selectedTaskId: 't-paused',
    detailStatus: 'running', detailTaskId: 't-paused', traceTaskId: 't-paused',
  }), false);
  assert.equal(taskEvidenceIsSettled({
    status: 'done', pausedByOwner: false, selectedTaskId: 't-final',
    detailStatus: 'running', detailTaskId: 't-final', traceTaskId: 't-final',
  }), false, 'a terminal board card must force one final detail/log fetch');
  assert.equal(buildTrace({ id: 'g1', objective: 'ship', status: 'executing' }, [], [paused])
    .find(item => item.id === 'task:t-paused').status, 'paused');
});

test('queued Goal navigation follows durable queue position', () => {
  const ordered = orderQueuedGoals([
    { id: 'third', queuePosition: 3, createdAt: '2026-08-26T01:00:00Z' },
    { id: 'missing-new', createdAt: '2026-08-26T03:00:00Z' },
    { id: 'first', queuePosition: 1, createdAt: '2026-08-26T02:00:00Z' },
    { id: 'missing-old', createdAt: '2026-08-26T01:00:00Z' },
  ]);
  assert.deepEqual(ordered.map(goal => goal.id), ['first', 'third', 'missing-old', 'missing-new']);
});

test('supervision health distinguishes active inference, stale scheduler, and stale UI sync', () => {
  const nowMs = Date.parse('2026-08-26T02:00:00Z');
  const inference = deriveSupervisionHealth({
    active: true,
    inferenceActive: true,
    inferenceStartedAt: '2026-08-26T01:58:00Z',
    checkpointAt: '2026-08-26T01:59:30Z',
    schedulerTickAt: '2026-08-26T01:59:55Z',
    lastSyncedAt: '2026-08-26T01:59:58Z',
    nowMs,
  });
  assert.equal(inference.stalled, false);
  assert.equal(inference.label, '판단 진행 중');
  const stalled = deriveSupervisionHealth({
    active: true,
    schedulerTickAt: '2026-08-26T01:57:00Z',
    schedulerNextDelayMs: 3000,
    lastSyncedAt: '2026-08-26T01:59:58Z',
    nowMs,
  });
  assert.equal(stalled.stalled, true);
  assert.equal(stalled.label, '감독 신호 지연');
  const staleSync = goalSupervisionHealth({
    director: { id: 'd1', status: 'idle', kind: 'project' },
    goal: { id: 'g1', status: 'executing', updatedAt: '2026-08-26T01:59:50Z', events: [] },
    scheduler: { lastTickAt: '2026-08-26T01:59:55Z', nextDelayMs: 3000, boards: [] },
    lastSyncedAt: '2026-08-26T01:58:00Z',
    nowMs,
  });
  assert.equal(staleSync.stalled, true);
  assert.equal(staleSync.label, '화면 동기화 지연');
});

test('public Director activity labels expose checkpoints without raw model output', () => {
  assert.equal(directorActivityMessage('run', { activity: { phase: 'planning_workers' } }), 'Director 단계 · planning workers');
  assert.equal(directorActivityMessage('goal', { activity: { ownerActionRequired: true } }), 'Owner 결정이 필요합니다.');
  assert.equal(directorActivityMessage('output', { activity: { chunkCharacters: 480 } }), 'Director 응답 수신 · 480자');
  assert.equal(directorActivityMessage('tick', { activity: { running: 2, ready: 1, awaitingOwner: true } }), '감독 동기화 · 실행 2 · 대기 1 · Owner 결정 대기');
  assert.equal(directorActivityMessage('run', { activity: { checkpoint: { message: '보안 검토 시작' } } }), '보안 검토 시작');
});

test('Hermes Unix-second timestamps are normalized before display and trace sorting', () => {
  assert.equal(timestampMs(1787750437), 1787750437000);
  assert.equal(timestampMs('1787750437'), 1787750437000);
  assert.equal(timestampMs('2026-08-26T13:20:37.000Z'), 1787750437000);
});

test('Director image selection applies the same bounded client limits as the local API', () => {
  const image = (name, type = 'image/png', size = 1024) => ({ name, type, size });
  assert.equal(validateImageSelection([image('shot.png')]).ok, true);
  assert.match(validateImageSelection([image('vector.svg', 'image/svg+xml')]).error, /지원하지 않는/);
  assert.match(validateImageSelection([image('huge.png', 'image/png', 5 * 1024 * 1024 + 1)]).error, /5 MB/);
  assert.match(validateImageSelection([image('fifth.png')], [image('1.png'), image('2.png'), image('3.png'), image('4.png')]).error, /최대 4개/);
});

test('operator model formats evidence without dumping raw object braces', () => {
  assert.equal(textValue({ taskId: 't1', attempts: 2 }), 'taskId · t1 · attempts · 2');
  assert.equal(statusText('awaiting_owner'), '오너 판단');
  assert.equal(statusText('waiting_for_director'), '디렉터 대기');
  assert.equal(statusText('succeeded'), '완료');
  assert.equal(statusTone('blocked'), 'attention');
  assert.equal(statusTone('success'), 'done');
  assert.equal(statusTone('failed'), 'failed');
});
