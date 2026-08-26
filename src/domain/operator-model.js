const terminalStates = new Set(['done', 'completed', 'succeeded', 'success', 'blocked', 'archived', 'failed', 'cancelled']);

export const statusText = status => ({
  idle: '대기', running: '실행 중', queued: '대기열', ready: '실행 대기', todo: '선행 대기',
  review: '리뷰 중', blocked: '판단 필요', scheduled: '일시정지', done: '완료', completed: '완료',
  archived: '완료', succeeded: '완료', success: '완료', failed: '실패', error: '오류', clarifying: '명세 확인', planning: '계획',
  executing: '실행 중', evaluating: '평가', remediating: '재작업', verifying: '검증',
  awaiting_owner: '오너 판단', cancelled: '취소', materializing: '작업 생성',
})[status] || status || '대기';

export const statusTone = status => {
  if (['running', 'executing', 'materializing', 'planning', 'clarifying', 'evaluating', 'remediating', 'verifying'].includes(status)) return 'running';
  if (['done', 'completed', 'succeeded', 'success', 'archived'].includes(status)) return 'done';
  if (['failed', 'error', 'cancelled'].includes(status)) return 'failed';
  if (['blocked', 'awaiting_owner'].includes(status)) return 'attention';
  return 'idle';
};

export function textValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('\n');
  return value.summary || value.message || value.decision || Object.entries(value)
    .filter(([, item]) => item != null && ['string', 'number', 'boolean'].includes(typeof item))
    .map(([key, item]) => `${key} · ${item}`)
    .join(' · ');
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
  return merged.sort((a, b) => Date.parse(taskTime(a) || 0) - Date.parse(taskTime(b) || 0));
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
    entries.push({
      id: `task:${task.id}`, type: 'task', taskId: task.id, status: task.status, at: taskTime(task),
      eyebrow: `${wave?.index ? `WAVE ${wave.index} · ` : ''}${task.assignee || task.profile || 'WORKER'}`,
      title: task.title || task.task || `Worker ${task.id}`,
      detail: [parents.length ? `선행 작업 · ${parents.join(', ')}` : '', textValue(task.summary || task.checkpoint || task.report)].filter(Boolean).join('\n'),
      raw: task, depth: taskDepth(task.id),
    });
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
  return [...unique.values()].sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
}

export function buildConversation(goal, summary, director) {
  const goalRuns = goal?.runs || [];
  const directRuns = (summary?.recentRuns || []).filter(run => {
    const matchesDirector = director?.kind === 'project'
      ? run.projectId === director.projectId
      : run.directorId === director?.id;
    if (goal?.id) return run.goalId === goal.id || (!run.goalId && matchesDirector);
    return matchesDirector;
  });
  const runs = [...new Map([...goalRuns, ...directRuns].map(run => [run.id, run])).values()];
  const messages = [];
  for (const run of runs) {
    if (run.prompt) messages.push({ id: `${run.id}:owner`, role: 'owner', text: run.prompt, at: run.createdAt, kind: run.requestedMode === 'delegate' ? '실행 요청' : '요청' });
    const answer = run.output || run.error || (!terminalStates.has(run.status) ? `판단 진행 중 · ${statusText(run.phase || run.status)}` : '');
    if (answer) messages.push({ id: `${run.id}:director`, role: 'director', text: answer, at: run.completedAt || run.startedAt || run.createdAt, kind: run.error ? '실패' : run.status === 'running' ? '판단 중' : '답변' });
  }
  for (const answer of goal?.ownerAnswers || []) {
    messages.push({ id: `owner-answer:${answer.id || answer.at}`, role: 'owner', text: answer.answer || answer.selectedOption, at: answer.at, kind: '오너 결정' });
  }
  if (goal?.finalReport) messages.push({ id: `goal-final:${goal.id}`, role: 'director', text: textValue(goal.finalReport), at: goal.completedAt || goal.updatedAt, kind: '최종 결론' });
  return messages.sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
}
