import { timestampMs } from '../lib/time.js';

const terminalStates = new Set(['done', 'completed', 'succeeded', 'success', 'blocked', 'archived', 'failed', 'cancelled']);
const activeGoalStates = new Set(['clarifying', 'planning', 'executing', 'evaluating', 'remediating', 'verifying', 'awaiting_owner']);
const resumableTaskStates = new Set(['blocked', 'paused', 'scheduled']);
const DIRECTOR_INFERENCE_STALE_MS = 600000;
const SCHEDULER_GRACE_MS = 30000;

export const statusText = status => status === 'triage' ? '수동 확인' : ({
  idle: '대기', running: '실행 중', queued: '대기열', ready: '실행 대기', todo: '선행 대기',
  waiting_for_director: '디렉터 대기',
  review: '리뷰 중', blocked: '판단 필요', paused: '오너 일시정지', scheduled: '일시정지', done: '완료', completed: '완료',
  archived: '완료', succeeded: '완료', success: '완료', failed: '실패', error: '오류', clarifying: '명세 확인', planning: '계획',
  executing: '실행 중', evaluating: '평가', remediating: '재작업', verifying: '검증',
  awaiting_owner: '오너 판단', cancelled: '취소', materializing: '작업 생성',
})[status] || status || '대기';

export const statusTone = status => {
  if (['running', 'executing', 'materializing', 'planning', 'clarifying', 'evaluating', 'remediating', 'verifying'].includes(status)) return 'running';
  if (['done', 'completed', 'succeeded', 'success', 'archived'].includes(status)) return 'done';
  if (['failed', 'error', 'cancelled'].includes(status)) return 'failed';
  if (['blocked', 'triage', 'paused', 'awaiting_owner'].includes(status)) return 'attention';
  return 'idle';
};

const workflowStageMeta = Object.freeze({
  queue: { label: '대기열', next: 'analysis' },
  analysis: { label: '요구·인수조건', next: 'candidate' },
  candidate: { label: '구현·산출물', next: 'review' },
  review: { label: '독립 리뷰', next: 'gate' },
  remediation: { label: '지적 수정', next: 'review' },
  gate: { label: '품질 게이트', next: 'complete' },
  owner: { label: 'Owner 결정', next: 'candidate' },
  complete: { label: '완료', next: null },
  stopped: { label: '중단', next: null },
});

function operationalStage(goal) {
  const status = String(goal?.status || '');
  if (!goal) return 'analysis';
  if (status === 'queued') return 'queue';
  if (status === 'awaiting_owner') return 'owner';
  if (status === 'completed') return 'complete';
  if (['blocked', 'failed', 'cancelled'].includes(status)) return 'stopped';
  if (['clarifying', 'planning'].includes(status) || !goal.workflowId) return 'analysis';
  if (status === 'remediating') return 'remediation';
  return workflowStageMeta[goal.requiredTransition?.stage]
    ? goal.requiredTransition.stage
    : status === 'verifying' ? 'review' : 'candidate';
}

function activeWaveTasks(goal, tasks) {
  const currentIds = new Set(goal?.currentWaveTaskIds || []);
  return currentIds.size
    ? (tasks || []).filter(task => currentIds.has(task.id))
    : (tasks || []).filter(task => !taskIsTerminal(task) || taskPausedByOwner(task));
}

/**
 * One compact, host-truthful answer to the three questions an Owner needs:
 * what is happening, what is next, and whether human action is required.
 */
export function goalOperationalFocus({ goal, tasks = [], supervision = null } = {}) {
  const stage = operationalStage(goal);
  const waveTasks = activeWaveTasks(goal, tasks);
  const statuses = waveTasks.map(task => taskDisplayStatus(task));
  const running = statuses.filter(status => ['running', 'executing', 'planning', 'materializing', 'review'].includes(status)).length;
  const waiting = statuses.filter(status => ['ready', 'queued', 'scheduled', 'todo'].includes(status)).length;
  const finished = waveTasks.filter(task => taskIsTerminal(task)).length;
  const paused = waveTasks.filter(task => taskPausedByOwner(task) || taskDisplayStatus(task) === 'paused');
  const transition = goal?.requiredTransition || {};
  const total = waveTasks.length;
  const firstActive = waveTasks.find(task => !taskIsTerminal(task)) || waveTasks.at(-1) || null;

  let currentValue = goal ? statusText(goal.status) : '새 요청 대기';
  let currentDetail = goal?.objective || 'Director에게 작업을 요청하면 여기에 진행 단계가 표시됩니다.';
  if (stage === 'queue') currentValue = goal?.queuePosition ? `대기 ${goal.queuePosition}번` : '실행 순서 대기';
  if (stage === 'analysis') currentValue = goal ? '디렉터가 작업 경계 판단 중' : '활성 Goal 없음';
  if (['candidate', 'review', 'remediation', 'gate'].includes(stage)) {
    currentValue = running
      ? `Worker ${running}/${Math.max(total, running)} 실행 중`
      : waiting ? `Worker ${waiting}개 실행 대기`
        : total && finished === total ? `${finished}개 결과 평가 중`
          : '디렉터가 Worker 배정 준비 중';
    currentDetail = firstActive?.title || goal?.objective || currentDetail;
  }
  if (stage === 'owner') {
    currentValue = '결정 전 자동 진행 정지';
    currentDetail = goal?.ownerDecision?.question || 'Owner 결정을 기다리고 있습니다.';
  }
  if (stage === 'complete') {
    currentValue = '인수조건·게이트 통과';
    currentDetail = textValue(goal?.finalReport) || goal?.objective || '최종 결과가 기록되었습니다.';
  }
  if (stage === 'stopped') {
    currentValue = statusText(goal?.status);
    currentDetail = textValue(goal?.error) || goal?.objective || '상세 기록을 확인하세요.';
  }

  let nextStage = workflowStageMeta[stage]?.next || null;
  let nextValue = nextStage ? workflowStageMeta[nextStage].label : '없음';
  let nextDetail = nextStage ? '현재 단계가 끝나면 자동으로 진행합니다.' : '워크플로가 종료되었습니다.';
  if (stage === 'candidate') {
    const count = transition.missingReviewProfiles?.length;
    nextValue = `독립 리뷰${count ? ` ${count}개` : ''}`;
    nextDetail = '구현 후보를 고정한 뒤 별도 Worker가 검토합니다.';
  } else if (stage === 'review') {
    nextValue = '수정 또는 품질 게이트';
    nextDetail = '지적이 있으면 수정·재검토, 없으면 게이트로 갑니다.';
  } else if (stage === 'remediation') {
    nextValue = '수정 후보 독립 재검토';
    nextDetail = '수정 Worker와 다른 Worker가 다시 검증합니다.';
  } else if (stage === 'gate') {
    nextValue = '최종 보고';
    nextDetail = '게이트 통과 증거가 있어야 완료할 수 있습니다.';
  } else if (stage === 'owner') {
    nextValue = '결정 범위만 실행';
    nextDetail = 'Owner 답변을 기록한 뒤 Director가 감독을 재개합니다.';
  } else if (stage === 'queue') {
    nextValue = '요구·인수조건 분석';
  } else if (stage === 'stopped') {
    nextValue = 'Owner 재시도 판단';
    nextDetail = '자동 재개하지 않습니다.';
  }

  let owner = { required: false, action: null, value: '없음', detail: '디렉터가 계속 감독합니다.', tone: 'done' };
  if (stage === 'owner') owner = { required: true, action: 'decision', value: '결정 필요', detail: currentDetail, tone: 'attention' };
  else if (paused.length) owner = { required: true, action: 'worker', value: 'Worker 일시정지', detail: '재개하거나 방향을 지시하세요.', tone: 'attention' };
  else if (supervision?.stalled) owner = { required: true, action: 'refresh', value: '상태 확인 권장', detail: supervision.detail || supervision.label, tone: 'attention' };
  else if (stage === 'stopped') owner = { required: true, action: 'details', value: '재시도 판단', detail: currentDetail, tone: 'attention' };

  const mainRoute = ['analysis', 'candidate', 'review', 'gate', 'complete'];
  const ownerInsertion = Math.max(1, mainRoute.indexOf(transition.stage));
  const route = stage === 'owner'
    ? [...mainRoute.slice(0, ownerInsertion), 'owner', ...mainRoute.slice(ownerInsertion)]
    : stage === 'remediation'
    ? ['analysis', 'candidate', 'remediation', 'review', 'gate', 'complete']
    : mainRoute;
  return {
    stage,
    tone: owner.required ? 'attention' : stage === 'complete' ? 'done' : goal ? 'running' : 'idle',
    current: { label: workflowStageMeta[stage]?.label || statusText(goal?.status), value: currentValue, detail: currentDetail },
    next: { stage: nextStage, value: nextValue, detail: nextDetail },
    owner,
    route: route.map(id => ({ id, label: workflowStageMeta[id].label, state: id === stage ? 'current' : route.indexOf(id) < route.indexOf(stage) ? 'done' : 'pending' })),
  };
}

function timeMs(value) {
  const parsed = timestampMs(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function taskPausedByOwner(task, record = null) {
  const status = String(task?.status || record?.status || '').toLowerCase();
  return resumableTaskStates.has(status)
    && Boolean(task?.pausedByOwner || task?.pausePending || task?.resumePending || record?.pausedByOwner || record?.pausePending || record?.resumePending);
}

export function taskDisplayStatus(task, record = null) {
  return taskPausedByOwner(task, record) ? 'paused' : String(task?.status || record?.status || '');
}

export function taskIsTerminal(task, record = null) {
  return terminalStates.has(String(task?.status || record?.status || '').toLowerCase()) && !taskPausedByOwner(task, record);
}

export function orderQueuedGoals(goals = []) {
  const position = goal => {
    const value = Number(goal?.queuePosition);
    return Number.isInteger(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
  };
  return [...goals].sort((left, right) => position(left) - position(right)
    || timeMs(left?.createdAt) - timeMs(right?.createdAt));
}

export function deriveSupervisionHealth({
  active = false,
  inferenceActive = false,
  inferenceStartedAt = null,
  checkpointAt = null,
  schedulerTickAt = null,
  schedulerNextDelayMs = 0,
  schedulerError = null,
  lastSyncedAt = null,
  nowMs = Date.now(),
} = {}) {
  const checkpointMs = timeMs(checkpointAt);
  const inferenceStartedMs = timeMs(inferenceStartedAt);
  const tickMs = timeMs(schedulerTickAt);
  const syncedMs = timeMs(lastSyncedAt);
  const checkpointAgeMs = checkpointMs ? Math.max(0, nowMs - checkpointMs) : 0;
  const tickAgeMs = tickMs ? Math.max(0, nowMs - tickMs) : 0;
  const syncAgeMs = syncedMs ? Math.max(0, nowMs - syncedMs) : 0;
  const schedulerLimitMs = Math.max(90000, Number(schedulerNextDelayMs || 0) + SCHEDULER_GRACE_MS);
  const syncLimitMs = Math.max(30000, Math.min(120000, schedulerLimitMs));
  if (schedulerError) return { stalled: true, tone: 'failed', label: '감독 오류', detail: String(schedulerError) };
  if (active && syncedMs && syncAgeMs > syncLimitMs) {
    return { stalled: true, tone: 'failed', label: '화면 동기화 지연', detail: `마지막 동기화 ${relativeDuration(syncAgeMs)} 전` };
  }
  if (inferenceActive) {
    if (checkpointMs && checkpointAgeMs > DIRECTOR_INFERENCE_STALE_MS) {
      return { stalled: true, tone: 'failed', label: '디렉터 판단 응답 지연', detail: `마지막 공개 체크포인트 ${relativeDuration(checkpointAgeMs)} 전` };
    }
    const elapsed = inferenceStartedMs ? `판단 ${relativeDuration(Math.max(0, nowMs - inferenceStartedMs))}` : '판단 진행';
    return { stalled: false, tone: 'running', label: '판단 진행 중', detail: checkpointMs ? `${elapsed} · 체크포인트 ${relativeDuration(checkpointAgeMs)} 전` : `${elapsed} · 첫 체크포인트 준비 중` };
  }
  if (active && tickMs && tickAgeMs > schedulerLimitMs) {
    return { stalled: true, tone: 'failed', label: '감독 신호 지연', detail: `마지막 스케줄러 신호 ${relativeDuration(tickAgeMs)} 전` };
  }
  if (checkpointMs) return { stalled: false, tone: 'done', label: '감독 정상', detail: `마지막 체크포인트 ${relativeDuration(checkpointAgeMs)} 전` };
  if (tickMs) return { stalled: false, tone: 'done', label: '감독 정상', detail: `마지막 스케줄러 신호 ${relativeDuration(tickAgeMs)} 전` };
  return { stalled: false, tone: 'idle', label: active ? '감독 시작 대기' : '감독 대기', detail: active ? '첫 체크포인트를 기다리는 중' : '활성 Goal이 없습니다.' };
}

export function goalSupervisionHealth({ director, goal, runs = [], scheduler = null, lastSyncedAt = null, nowMs = Date.now() } = {}) {
  if (!goal || !activeGoalStates.has(goal.status)) return null;
  const run = [...runs].sort((left, right) => timeMs(left?.startedAt || left?.createdAt) - timeMs(right?.startedAt || right?.createdAt)).at(-1) || null;
  const checkpointAt = Math.max(
    timeMs(goal.updatedAt || goal.createdAt),
    timeMs(run?.startedAt || run?.createdAt),
    ...(goal.events || []).map(event => timeMs(event.at || event.createdAt)),
    ...(run?.progressEvents || []).map(event => timeMs(event.at || event.createdAt)),
  );
  const board = (scheduler?.boards || []).find(item => item.directorId === director?.id) || null;
  return deriveSupervisionHealth({
    active: true,
    inferenceActive: run?.status === 'running' || director?.status === 'running',
    inferenceStartedAt: run?.startedAt || run?.createdAt,
    checkpointAt: checkpointAt || null,
    schedulerTickAt: board?.lastTickAt || scheduler?.lastTickAt,
    schedulerNextDelayMs: scheduler?.nextDelayMs,
    schedulerError: board?.lastTickError || (director?.kind === 'skill' ? scheduler?.lastError : null),
    lastSyncedAt,
    nowMs,
  });
}

function relativeDuration(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간`;
  return `${Math.floor(hours / 24)}일`;
}

export function textValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('\n');
  return value.summary || value.message || value.decision || Object.entries(value)
    .filter(([, item]) => item != null && ['string', 'number', 'boolean'].includes(typeof item))
    .map(([key, item]) => `${key} · ${item}`)
    .join(' · ');
}

export function goalConclusionPresentation(goal, runs = []) {
  const status = String(goal?.status || '');
  const finalReport = String(textValue(goal?.finalReport) || '').trim();
  const latestRun = [...(runs || [])].reverse().find(item => item?.output || item?.publicDecisions?.length);
  const latestPublicUpdate = String(textValue(latestRun?.output || latestRun?.publicDecisions?.at(-1)) || '').trim();
  if (status === 'completed' && finalReport) return {
    state: 'completed', tone: 'done', label: '완료 · Goal 최종 결과',
    content: finalReport, action: 'Goal 대화에서 전체 보기',
  };
  if (status === 'awaiting_owner') return {
    state: 'awaiting_owner', tone: 'attention', label: '완료 아님 · 오너 결정 대기',
    content: String(goal?.ownerDecision?.question || '오너의 결정을 받아야 다음 단계로 넘어갈 수 있습니다.').trim(),
    action: '결정 화면에서 지금 응답하기',
  };
  if (activeGoalStates.has(status)) return {
    state: 'active', tone: 'running', label: `진행 중 · ${statusText(status)}`,
    content: latestPublicUpdate || '디렉터가 다음 행동을 판단하고 있습니다.',
    action: '현재 Goal 대화 열기',
  };
  if (status === 'completed') return {
    state: 'completed_without_report', tone: 'attention', label: '완료 상태 · 최종 보고서 확인 필요',
    content: '완료 상태이지만 표시할 최종 보고서가 없습니다.', action: 'Goal 대화 열기',
  };
  if (['blocked', 'failed', 'cancelled'].includes(status)) return {
    state: status, tone: status === 'blocked' ? 'attention' : 'failed', label: `종료 상태 · ${statusText(status)}`,
    content: String(textValue(goal?.error) || '').trim() || latestPublicUpdate || '종료 상태의 상세 기록을 확인하세요.', action: 'Goal 대화 열기',
  };
  return {
    state: 'idle', tone: 'idle', label: '디렉터 최근 판단',
    content: latestPublicUpdate || '아직 디렉터 결론이 없습니다.', action: 'Goal 대화 열기',
  };
}

export function ownerDecisionPayload(selectedOption, typedAnswer) {
  const selected = String(selectedOption || '').trim();
  const typed = String(typedAnswer || '').trim();
  if (!typed && !selected) return null;
  return typed ? { answer: typed } : { answer: selected, selectedOption: selected };
}

export function goalControlOptions(goal) {
  if (!goal || goal.phase === 'cancelled' || goal.terminalReason === 'owner_cancelled') return [];
  if (goal.status === 'queued') return [
    { action: 'reorder', position: 'front', label: '맨 앞으로', description: '다음 실행 순서로 앞당깁니다.' },
    { action: 'reorder', position: 'back', label: '맨 뒤로', description: '대기열 마지막으로 보냅니다.' },
    { action: 'defer', label: '보류', description: '후순위로 미룹니다.' },
    { action: 'cancel', label: '목표 취소', description: '자동 실행과 재시도를 종료합니다.', danger: true },
  ];
  if (goal.status === 'awaiting_owner') return [
    { action: 'cancel', label: '목표 취소', description: '현재 판단 계약을 포기하고 종료합니다.', danger: true },
  ];
  if (activeGoalStates.has(goal.status)) return [
    { action: 'cancel', label: '목표 취소', description: '실행 중인 Worker 정지를 확인한 뒤 자동 실행과 재시도를 종료합니다.', danger: true },
  ];
  if (['blocked', 'failed'].includes(goal.status)) return [
    { action: 'retry', label: '안전 재시도', description: 'Worker 정지를 확인한 뒤 다시 시작합니다.' },
    { action: 'cancel', label: '목표 취소', description: 'Worker 정지를 확인한 뒤 종료합니다.', danger: true },
  ];
  return [];
}

export function interventionReceiptText(receipt) {
  if (receipt?.workerObserved || receipt?.status === 'worker_observed') return 'Worker 확인됨';
  if (receipt?.status === 'delivery_failed') return '영속 저장됨 · 전달 실패 · 자동 재시도 예정 · 다시 보내지 마세요';
  if (receipt?.status === 'delivery_pending') return '영속 저장됨 · 전달 대기 · 자동 재시도 예정 · 다시 보내지 마세요';
  return 'Hermes 접수됨 · Worker 확인 대기';
}

export function taskTime(task) {
  return task?.updated_at || task?.updatedAt || task?.completed_at || task?.completedAt || task?.started_at || task?.startedAt || task?.created_at || task?.createdAt || null;
}

export function goalTasks(board, goal) {
  const ids = new Set(goal?.taskIds || []);
  const records = new Map((goal?.taskRecords || []).map(record => [record.taskId, record]));
  const merged = (board || []).filter(task => ids.has(task.id)).map(task => ({ ...records.get(task.id), ...task }));
  for (const [id, record] of records) if (!merged.some(task => task.id === id)) merged.push({ id, ...record });
  return merged.sort((a, b) => timestampMs(taskTime(a) || 0) - timestampMs(taskTime(b) || 0));
}

export function buildTrace(goal, runs, tasks) {
  if (!goal) return [];
  const taskById = new Map((tasks || []).map(task => [task.id, task]));
  const waveById = new Map((goal.waves || []).map(wave => [wave.id, wave]));
  const depthCache = new Map();
  const taskDepth = (taskId, visiting = new Set()) => {
    if (depthCache.has(taskId)) return depthCache.get(taskId);
    if (visiting.has(taskId)) return 2;
    const task = taskById.get(taskId);
    const parents = task?.parentTaskIds || task?.parents || [];
    const nextVisiting = new Set(visiting).add(taskId);
    const depth = 2 + (parents.length ? Math.max(...parents.map(parent => taskDepth(parent, nextVisiting) - 1)) : 0);
    depthCache.set(taskId, depth);
    return depth;
  };
  const taskWave = task => waveById.get(task?.waveId)
    || (goal.waves || []).find(wave => wave.taskIds?.includes(task?.id));
  const entries = [{
    id: `goal:${goal.id}`, type: 'goal', status: goal.status, at: goal.createdAt,
    eyebrow: 'GOAL', title: goal.objective, detail: `Workflow · ${goal.workflowId || '디렉터 판단 중'}`, depth: 0,
  }];
  for (const wave of goal.waves || []) {
    entries.push({
      id: `wave:${wave.id}`, type: 'wave', status: wave.status, at: wave.startedAt,
      eyebrow: `WAVE ${wave.index || '?'}`, title: `${wave.kind || 'execution'} wave`,
      detail: `${wave.taskIds?.length || 0} workers${wave.decisions?.length ? ` · ${wave.decisions.join(' · ')}` : ''}`,
      raw: wave, depth: 1,
    });
  }
  for (const event of goal.events || []) {
    const taskId = event.details?.taskId || null;
    entries.push({
      id: `event:${event.id || `${event.at}-${entries.length}`}`, type: event.kind || 'decision',
      status: event.status || event.phase, at: event.at || event.createdAt,
      eyebrow: (event.kind || event.phase || 'DECISION').replaceAll('_', ' ').toUpperCase(),
      title: event.message || event.title || event.phase, detail: textValue(event.details), raw: event,
      taskId, depth: taskId ? taskDepth(taskId) : 1,
    });
  }
  for (const run of runs || []) {
    for (const event of run.progressEvents || []) {
      const taskId = event.details?.taskId || null;
      entries.push({
        id: `run:${run.id}:${event.at || entries.length}`, type: 'director', status: event.phase || run.status,
        at: event.at, eyebrow: 'DIRECTOR', title: event.message, detail: textValue(event.details), raw: event,
        taskId, depth: taskId ? taskDepth(taskId) : 1,
      });
    }
    if (run.error) entries.push({ id: `run-error:${run.id}`, type: 'failure', status: 'failed', at: run.completedAt, eyebrow: 'DIRECTOR ERROR', title: run.error, detail: run.prompt, raw: run, depth: 1 });
  }
  for (const task of tasks || []) {
    const wave = taskWave(task);
    const parents = task.parentTaskIds || task.parents || [];
    const taskDepthValue = taskDepth(task.id);
    entries.push({
      id: `task:${task.id}`, type: 'task', taskId: task.id, status: taskDisplayStatus(task), at: taskTime(task),
      eyebrow: `${wave?.index ? `WAVE ${wave.index} · ` : ''}${task.assignee || task.profile || 'WORKER'}`,
      title: task.title || task.task || `Worker ${task.id}`,
      detail: [parents.length ? `선행 작업 · ${parents.join(', ')}` : '', textValue(task.summary || task.checkpoint || task.report)].filter(Boolean).join('\n'),
      raw: task, depth: taskDepthValue,
    });
    for (const [index, comment] of (task.comments || []).entries()) {
      const body = String(comment?.body || comment?.message || '').trim();
      const markerMatch = body.match(/^\s*(PLAN|OBSERVED|DECISION|VERIFY)\s*:\s*/i);
      if (!markerMatch) continue;
      const marker = markerMatch[1].toUpperCase();
      entries.push({
        id: `task-comment:${task.id}:${comment?.id || comment?.created_at || comment?.createdAt || index}`,
        type: 'worker_checkpoint', taskId: task.id, status: marker === 'DECISION' ? 'attention' : taskDisplayStatus(task),
        at: comment?.created_at || comment?.createdAt || taskTime(task),
        eyebrow: `${wave?.index ? `WAVE ${wave.index} · ` : ''}${marker}`,
        title: body.replace(/^\s*(?:PLAN|OBSERVED|DECISION|VERIFY)\s*:\s*/i, '') || 'Worker 체크포인트',
        detail: comment?.author || task.assignee || task.profile || 'Worker', raw: comment, depth: taskDepthValue + 1,
      });
    }
  }
  if (goal.ownerDecision?.required) entries.push({
    id: `decision:${goal.id}`, type: 'decision', status: 'awaiting_owner', at: goal.ownerDecision.askedAt,
    eyebrow: 'OWNER DECISION', title: goal.ownerDecision.question, detail: (goal.ownerDecision.evidence || []).join('\n'), raw: goal.ownerDecision, depth: 1,
  });
  if (goal.finalReport) entries.push({
    id: `final:${goal.id}`, type: 'final', status: goal.status, at: goal.completedAt || goal.updatedAt,
    eyebrow: 'FINAL REPORT', title: '디렉터 최종 결론', detail: textValue(goal.finalReport), raw: goal.finalReport, depth: 1,
  });
  const unique = new Map(entries.map(entry => [entry.id, entry]));
  return [...unique.values()].sort((a, b) => timestampMs(a.at || 0) - timestampMs(b.at || 0));
}

function previewAttachments(attachments, directorId) {
  if (!Array.isArray(attachments)) return [];
  return attachments.map(attachment => {
    if (!attachment || attachment.previewUrl || !directorId || !attachment.id) return attachment;
    return {
      ...attachment,
      previewUrl: `/api/directors/${encodeURIComponent(directorId)}/attachments/${encodeURIComponent(attachment.id)}`,
    };
  }).filter(Boolean);
}

export function buildConversation(goal, summary, director, scope = goal ? 'goal' : 'project') {
  const goalRuns = scope === 'goal' ? (goal?.runs || []) : [];
  const directRuns = (summary?.recentRuns || []).filter(run => {
    const matchesDirector = director?.kind === 'project'
      ? run.projectId === director.projectId
      : run.directorId === director?.id;
    return scope === 'goal' ? run.goalId === goal?.id : !run.goalId && matchesDirector;
  });
  const runs = [...new Map([...goalRuns, ...directRuns].map(run => [run.id, run])).values()];
  const messages = [];
  for (const run of runs) {
    if (run.prompt) messages.push({ id: `${run.id}:owner`, role: 'owner', text: run.prompt, attachments: previewAttachments(run.attachments, director?.id), at: run.createdAt, kind: run.requestedMode === 'delegate' ? '실행 요청' : '요청' });
    const answer = run.output || run.error || (!terminalStates.has(run.status) ? `판단 진행 중 · ${statusText(run.phase || run.status)}` : '');
    if (answer) messages.push({ id: `${run.id}:director`, role: 'director', text: answer, at: run.completedAt || run.startedAt || run.createdAt, kind: run.error ? '실패' : run.status === 'running' ? '판단 중' : run.status === 'queued' ? '접수됨' : '답변' });
  }
  for (const answer of scope === 'goal' ? (goal?.ownerAnswers || []) : []) {
    const attachmentIds = new Set(answer.attachmentIds || []);
    messages.push({
      id: `owner-answer:${answer.id || answer.at}`, role: 'owner', text: answer.answer || answer.selectedOption,
      attachments: previewAttachments((goal?.attachments || []).filter(item => attachmentIds.has(item.id)), director?.id),
      at: answer.at, kind: answer.kind === 'guidance' ? 'Goal 수정' : '오너 결정',
    });
  }
  if (scope === 'goal' && goal?.finalReport) messages.push({ id: `goal-final:${goal.id}`, role: 'director', text: textValue(goal.finalReport), at: goal.completedAt || goal.updatedAt, kind: '최종 결론' });
  return messages.sort((a, b) => timestampMs(a.at || 0) - timestampMs(b.at || 0));
}
