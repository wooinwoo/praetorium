const successfulTasks = new Set(['done', 'completed', 'succeeded', 'success', 'archived']);

function directorName(summary, directorId) {
  return summary?.directors?.find(item => item.id === directorId)?.name || 'Praetorium';
}

function notification({ id, kind, title, body, tone = 'neutral', directorId = null, goalId = null, taskId = null, createdAt }) {
  return { id, kind, title, body, tone, directorId, goalId, taskId, createdAt, read: false };
}

function happenedAfter(value, observedAfter) {
  const eventAt = Date.parse(value || '');
  const baseline = Date.parse(observedAfter || '');
  return Number.isFinite(eventAt) && Number.isFinite(baseline) && eventAt >= baseline;
}

export function deriveGoalNotifications(previous, current, createdAt = new Date().toISOString(), observedAfter = null) {
  if (!previous || !current) return [];
  const before = new Map((previous.notificationGoals || previous.goals || []).map(goal => [goal.id, goal]));
  const events = [];
  for (const goal of current.notificationGoals || current.goals || []) {
    const prior = before.get(goal.id);
    if (!prior && !observedAfter) continue;
    const project = directorName(current, goal.directorId);
    const askedAt = goal.ownerDecision?.required ? goal.ownerDecision.askedAt || goal.updatedAt : null;
    const priorAskedAt = prior?.ownerDecision?.required ? prior.ownerDecision.askedAt || prior.updatedAt : null;
    if (askedAt && (prior ? askedAt !== priorAskedAt : happenedAfter(askedAt, observedAfter))) {
      events.push(notification({
        id: `goal:${goal.id}:decision:${askedAt}`,
        kind: 'owner_decision', title: '오너 결정 필요', body: `${project} · ${goal.objective}`,
        tone: 'attention', directorId: goal.directorId, goalId: goal.id, createdAt,
      }));
    }
    if (prior && goal.status === prior.status) continue;
    const statusAt = goal.completedAt || goal.updatedAt;
    if (goal.status === 'completed' && (prior || happenedAfter(statusAt, observedAfter))) {
      events.push(notification({
        id: `goal:${goal.id}:completed:${goal.completedAt || goal.updatedAt}`,
        kind: 'goal_completed', title: 'Goal 완료', body: `${project} · ${goal.objective}`,
        tone: 'done', directorId: goal.directorId, goalId: goal.id, createdAt,
      }));
    } else if (['blocked', 'failed'].includes(goal.status) && (prior || happenedAfter(goal.updatedAt, observedAfter))) {
      events.push(notification({
        id: `goal:${goal.id}:${goal.status}:${goal.updatedAt}`,
        kind: 'goal_problem', title: goal.status === 'failed' ? 'Goal 실패' : 'Goal 확인 필요',
        body: `${project} · ${goal.error || goal.objective}`,
        tone: 'failed', directorId: goal.directorId, goalId: goal.id, createdAt,
      }));
    }
  }
  return events;
}

export function deriveWorkerNotifications(previousTasks, currentTasks, createdAt = new Date().toISOString(), observedAfter = null) {
  if (!previousTasks) return [];
  const key = task => `${task.directorId || ''}:${task.id}`;
  const before = new Map(previousTasks.map(task => [key(task), task]));
  const groups = new Map();
  for (const task of currentTasks || []) {
    const prior = before.get(key(task));
    if (!successfulTasks.has(task.status) || (prior && successfulTasks.has(prior.status))) continue;
    if (!prior && !happenedAfter(task.updatedAt, observedAfter)) continue;
    const groupKey = `${task.directorId || ''}:${task.goalId || task.id}`;
    const items = groups.get(groupKey) || [];
    items.push(task);
    groups.set(groupKey, items);
  }
  return [...groups.values()].map(completed => {
    const first = completed[0];
    const identity = completed.map(task => `${task.id}:${task.updatedAt || task.status}`).sort().join('|');
    const titles = completed.slice(0, 2).map(task => task.title || task.id).join(', ');
    return notification({
      id: `workers:${first.goalId || first.directorId}:${identity}`,
      kind: 'workers_completed', title: `Worker ${completed.length}개 완료`,
      body: `${first.goalObjective || 'Worker 작업'} · ${titles}${completed.length > 2 ? ` 외 ${completed.length - 2}개` : ''}`,
      tone: 'done', directorId: first.directorId, goalId: first.goalId,
      taskId: completed.length === 1 ? first.id : null, createdAt,
    });
  });
}

export function connectionNotification(message, createdAt = new Date().toISOString(), kind = 'connection_lost') {
  return notification({
    id: `${kind}:${createdAt}`,
    kind, title: kind === 'runtime_error' ? 'Runtime 확인 필요' : '로컬 연결 끊김', body: String(message || 'Praetorium 서버 상태를 확인하세요.'),
    tone: 'failed', createdAt,
  });
}

export function mergeNotifications(current, incoming, limit = 100) {
  const byId = new Map((current || []).map(item => [item.id, item]));
  for (const item of incoming || []) if (item?.id && !byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()]
    .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0))
    .slice(0, limit);
}
