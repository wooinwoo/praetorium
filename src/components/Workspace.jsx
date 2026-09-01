import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import {
  DIRECTOR_PANEL_ID, PROCESS_PANEL_ID, activateDockPanel, canSplitDockPanel, compactDockLayout, createDockLayout, filterDockLayout, mapDockInsertionIndex,
  moveDockPanel, reconcileDockLayout, updateDockRatio, workerPanelId, workerTaskId,
} from '../lib/dock-layout.js';
import {
  buildConversation, buildTrace, goalConclusionPresentation, goalControlOptions, goalOperationalFocus, goalSupervisionHealth, goalTasks,
  interventionReceiptText, taskDisplayStatus, taskIsTerminal, taskPausedByOwner, textValue,
} from '../domain/operator-model.js';
import { runtimeNeedsAttention } from '../lib/runtime-errors.js';
import { DecisionForm, DirectorComposer, WorkerIntervention } from './forms.jsx';
import { Empty, ErrorNotice, formatClock, Icon, relativeTime, Splitter, Status, statusText } from './common.jsx';

const WorkerConsole = lazy(() => import('./WorkerConsole.jsx'));

const successStates = new Set(['done', 'completed', 'succeeded', 'success', 'archived']);
const activeGoalStates = new Set(['clarifying', 'planning', 'executing', 'evaluating', 'remediating', 'verifying', 'awaiting_owner']);
const guideableGoalStates = new Set(['clarifying', 'planning', 'executing', 'evaluating', 'remediating', 'verifying']);
const decisionActionImpacts = {
  approve: '검증된 계획을 표시된 승인 범위 안에서 실행합니다.',
  reevaluate: '추가 검증을 수행한 뒤 Director가 현재 후보를 다시 평가합니다.',
  extend: '자동 감독 한도를 4개 Wave와 수정 루프 1회만큼 늘리고 계속합니다.',
  retry_evaluation: '현재 증거를 다시 수집하고 Director 평가를 재실행합니다.',
  retry_initial_planning: '현재 정책과 요구사항으로 계획부터 다시 수립합니다.',
  retry_infrastructure: '런타임과 보드 연결을 다시 확인한 뒤 현재 Goal을 재개합니다.',
  retry_materialization: '중단된 현재 Wave 생성을 같은 Goal 안에서 다시 시도합니다.',
  retry_authority: '이미 승인된 정확한 계획과 범위를 다시 검증한 뒤 실행을 재시도합니다.',
  stop: '실행 중인 Worker가 멈췄는지 확인한 뒤 현재 Goal을 차단 상태로 종료합니다.',
};

const workerRoleNames = {
  'codex-implementer': '구현', remediator: '수정',
  'adversarial-reviewer': '반대 검증', 'quality-gate-reviewer': '품질 게이트',
  'convention-reviewer': '규칙 검토', 'test-gap-reviewer': '테스트 검토',
  'security-reviewer': '보안 검토', 'architecture-reviewer': '구조 검토',
  'performance-reviewer': '성능 검토', 'release-reviewer': '배포 검토',
};

function workerTabName(tasks, task) {
  if (!task) return 'Worker';
  const role = task.assignee || task.profile || 'Worker';
  const label = workerRoleNames[role] || role.replaceAll('-', ' ');
  const siblings = tasks.filter(item => (item.assignee || item.profile || 'Worker') === role);
  return siblings.length > 1 ? `${label} ${siblings.indexOf(task) + 1}` : label;
}

function GoalControls({ directorId, goal, refresh }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const controls = goalControlOptions(goal);
  if (!controls.length) return null;
  const control = async option => {
    if (option.action === 'cancel' && !window.confirm(`“${goal.objective}” 목표를 취소할까요? 자동 실행과 재시도가 종료됩니다.`)) return;
    setBusy(`${option.action}:${option.position || ''}`);
    setError('');
    try {
      await api(`/api/directors/${encodeURIComponent(directorId)}/goals/${encodeURIComponent(goal.id)}/control`, {
        method: 'POST', body: { action: option.action, ...(option.position ? { position: option.position } : {}), reason: 'Owner control from Praetorium React console' },
      });
      refresh();
    } catch (nextError) { setError(nextError.message); }
    finally { setBusy(''); }
  };
  return <details className="goal-control-menu">
    <summary className="secondary-button" aria-label="목표 운영 제어">•••</summary>
    <div className="goal-control-popover">
      <header><strong>목표 운영 제어</strong><small>{statusText(goal.status)}</small></header>
      {controls.map(option => <button type="button" className={option.danger ? 'danger' : ''} key={`${option.action}:${option.position || ''}`} disabled={Boolean(busy)} onClick={() => control(option)}><strong>{busy === `${option.action}:${option.position || ''}` ? '처리 중…' : option.label}</strong><small>{option.description}</small></button>)}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  </details>;
}

function GoalHeader({ directorId, goal, tasks, supervision, onDirector, refresh }) {
  const complete = tasks.filter(task => successStates.has(task.status)).length;
  return <header className="goal-header">
    <div className="goal-heading"><div className="goal-kicker"><Status value={goal?.status} /><span>{goal?.workflowId || 'Workflow 미정'}</span>{goal?.queuePosition && <span>Queue #{goal.queuePosition}</span>}</div><h1>{goal?.objective || '새 목표를 기다리는 중'}</h1>{supervision && <div className={`supervision-health tone-${supervision.tone} ${supervision.stalled ? 'stalled' : ''}`} role="status" aria-live="polite"><i /><strong>{supervision.label}</strong><span>{supervision.detail}</span></div>}</div>
    {goal && <div className="goal-progress"><span>{complete} / {tasks.length} 작업 완료</span><div><i style={{ width: `${tasks.length ? complete / tasks.length * 100 : 0}%` }} /></div></div>}
    <div className="goal-header-actions"><button type="button" className="secondary-button compact" onClick={onDirector}><Icon name="message" />디렉터 열기</button><GoalControls directorId={directorId} goal={goal} refresh={refresh} /></div>
  </header>;
}

function LatestConclusion({ goal, runs, onOpen, onDecision }) {
  const presentation = goalConclusionPresentation(goal, runs);
  const preview = String(presentation.content || '').replace(/\[([^\]]+)\]\(https?:\/\/[^)\s]+\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^\s*(?:```[^\n]*|\d+\.\s+|[-*#>]\s*)/gm, '').replace(/\s+/g, ' ').trim();
  return <button type="button" className={`conclusion-preview tone-${presentation.tone}`} onClick={presentation.state === 'awaiting_owner' ? onDecision : onOpen}>
    <span className="director-avatar large">D</span>
    <span><small>{presentation.label}</small><strong>{preview}</strong><em>{presentation.action} <Icon name="chevron" /></em></span>
  </button>;
}

function WorkerNow({ goal, tasks, error, onOpen }) {
  const priorities = { running: 0, executing: 0, planning: 0, materializing: 0, review: 1, paused: 1, triage: 1, ready: 2, queued: 2, todo: 2, scheduled: 2 };
  const current = tasks.map(task => ({ task, status: taskDisplayStatus(task) }))
    .filter(item => (!taskIsTerminal(item.task) || taskPausedByOwner(item.task)) && Object.hasOwn(priorities, item.status)
      && (item.status !== 'paused' || taskPausedByOwner(item.task)))
    .sort((left, right) => priorities[left.status] - priorities[right.status]);
  const running = current.filter(item => priorities[item.status] === 0);
  const attention = current.filter(item => priorities[item.status] === 1);
  const waiting = current.filter(item => priorities[item.status] === 2);
  const headline = error ? 'Worker 상태를 확인할 수 없음'
    : running.length ? `Worker ${running.length}개 실행 중`
    : attention.length ? `Worker ${attention.length}개 확인 필요`
      : waiting.length ? `Worker ${waiting.length}개 실행 대기`
        : activeGoalStates.has(goal?.status) ? `Worker 없음 · Director ${statusText(goal.status)}`
          : '현재 실행 중인 Worker 없음';
  const tone = error || attention.length ? 'attention' : running.length ? 'running' : waiting.length ? 'waiting' : 'idle';
  return <section className={`worker-now tone-${tone}`} aria-labelledby="worker-now-title">
    <header>
      <span className="worker-now-signal"><i /></span>
      <span><h2 id="worker-now-title">{headline}</h2><small>{error ? '마지막으로 확인된 상태만 표시합니다. Worker 목록을 다시 동기화하세요.' : current.length ? `실행 ${running.length} · 대기 ${waiting.length} · 확인 ${attention.length}` : 'Worker가 시작되면 여기에 가장 먼저 표시됩니다.'}</small></span>
    </header>
    {!!current.length && <ul className={`worker-now-list ${error ? 'stale' : ''}`} aria-label="현재 Worker">
      {current.map(({ task, status }) => <li key={task.id}><button type="button" onClick={() => onOpen(task.id)}>
          <span className={`task-tab-dot ${status}`} />
          <span><strong>{workerTabName(tasks, task)}</strong><small>{task.title}</small></span>
          <span className="worker-now-status">{error && <small>마지막 확인</small>}<Status value={status} /></span>
          <Icon name="chevron" />
        </button></li>)}
    </ul>}
  </section>;
}

function DirectorActivityPanel({ activity, goalId = null, compact = false, activityHeight = 112, setActivityHeight = () => {} }) {
  const [open, setOpen] = useState(!compact);
  const scopedEvents = (activity?.events || []).filter(event => !goalId || event.goalId === goalId || ['ready', 'resync'].includes(event.type));
  const events = scopedEvents.slice(compact ? -5 : -18).reverse();
  const summary = compact ? events[0]?.message || '첫 실행 이벤트를 기다리는 중…' : '운영 단계 · 체크포인트';
  return <details className={`director-activity-panel ${compact ? 'compact' : ''}`} open={open} onToggle={event => setOpen(event.currentTarget.open)} style={{ '--activity-height': `${activityHeight}px` }}>
    <summary>
      <span><Icon name="activity" /><strong>디렉터 공개 활동</strong><small aria-live="polite">{summary}</small></span>
      <span role="status" className={`activity-connection ${activity?.connected ? 'online' : 'reconnecting'}`}><i />{activity?.connected ? '실시간' : '재연결 중'}</span>
    </summary>
    <div className="director-activity-body">
      <p>비공개 사고과정이 아니라 실제 실행 단계, Worker 상태와 검증 체크포인트를 표시합니다.</p>
      {activity?.error && <small className="activity-stream-error">{activity.error}</small>}
      {events.length ? <ol className="director-activity-list" role="log" aria-live="polite" aria-relevant="additions text">
        {events.map(event => <li key={event.id} className={`tone-${event.tone || 'idle'}`}>
          <span className="activity-rail"><i /></span>
          <span><small>{String(event.phase || event.type).replaceAll('_', ' ')}</small><strong>{event.message}</strong></span>
          <time dateTime={event.at} title={event.at}>{relativeTime(event.at)}</time>
        </li>)}
      </ol> : <div className="activity-empty"><span className="activity-pulse" />첫 실행 이벤트를 기다리는 중…</div>}
    </div>
    {compact && <Splitter label="디렉터 활동 영역 높이" side="bottom" orientation="horizontal" value={activityHeight} min={72} max={260} onChange={setActivityHeight} onReset={() => setActivityHeight(112)} />}
  </details>;
}

function TraceView({ goal, runs, tasks, trace, selectedEntry, onSelectEntry, onSelectTask, onOpenTask, onDirector, onDecision, directorId, refresh, errors, taskTrace, selectedTask, supervision, liveActivity, activityHeight, setActivityHeight, onOpenSettings }) {
  const scrollRef = useRef(null);
  const [follow, setFollow] = useState(true);
  const [traceLimit, setTraceLimit] = useState(160);
  const [logExpanded, setLogExpanded] = useState(false);
  const runtimeUnavailable = runtimeNeedsAttention(errors.trace);
  const visibleTrace = trace.slice(-traceLimit);
  const omittedTrace = trace.length - visibleTrace.length;
  useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' });
  }, [trace.length, follow]);
  useEffect(() => { setTraceLimit(160); }, [goal?.id]);
  useEffect(() => {
    if (!selectedTask || taskIsTerminal(selectedTask)) setLogExpanded(false);
    else if (['running', 'executing', 'planning', 'materializing'].includes(taskDisplayStatus(selectedTask))) setLogExpanded(true);
  }, [selectedTask?.id, selectedTask?.status]);
  if (!goal) return <div className="workspace-empty"><Empty icon="branch" title="표시할 Goal이 없습니다">디렉터 채팅에서 새 목표를 보내세요.</Empty><button type="button" className="primary-button" onClick={onDirector}>디렉터 열기</button></div>;
  const ownerDecision = goal.ownerDecision?.required;
  const decisionHeadingId = `decision-${String(goal.id).replace(/[^a-zA-Z0-9_-]/g, '-')}-heading`;
  const openDecision = () => {
    const scrollTop = scrollRef.current?.scrollTop;
    onDecision();
    requestAnimationFrame(() => { if (scrollRef.current && scrollTop != null) scrollRef.current.scrollTop = scrollTop; });
  };
  return <div className={`trace-view ${logExpanded ? 'log-expanded' : 'log-collapsed'}`}>
    <GoalHeader directorId={directorId} goal={goal} tasks={tasks} supervision={supervision} onDirector={onDirector} refresh={refresh} />
    <div className="worker-now-bar"><WorkerNow goal={goal} tasks={tasks} error={errors.board} onOpen={onOpenTask} /></div>
    <div className="conclusion-bar"><LatestConclusion goal={goal} runs={runs} onOpen={onDirector} onDecision={openDecision} /></div>
    <div className="trace-content" ref={scrollRef} onScroll={event => setFollow(event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight < 48)}>
      {ownerDecision && <section className="decision-gate" aria-labelledby={decisionHeadingId}>
        <header><span><Icon name="user" />오너 결정 필요</span><time>{formatClock(goal.ownerDecision.askedAt)}</time></header>
        <h2 id={decisionHeadingId}>{goal.ownerDecision.question}</h2>
        <footer><span>배경·선택별 영향·근거·Worker 결과를 확인한 뒤 결정하세요.</span><button type="button" className="attention-button compact" onClick={openDecision}>판단 정보 열기 <Icon name="chevron" /></button></footer>
      </section>}
      {errors.goal && <ErrorNotice title="목표 상세 동기화 실패" onRetry={refresh}>{errors.goal} · 기존 기록을 보존합니다.</ErrorNotice>}
      {errors.board && <ErrorNotice title="Worker 목록 동기화 실패" onRetry={refresh}>{errors.board} · 마지막 Worker 목록을 보존합니다.</ErrorNotice>}
      <section className="trace-section" aria-label="실행 trace">
        <header className="section-title"><span><Icon name="branch" />실행 흐름</span><small>{trace.length}개 기록</small></header>
        <div className="trace-list">
          {omittedTrace > 0 && <button type="button" className="load-older" onClick={() => setTraceLimit(limit => limit + 160)}>이전 {Math.min(160, omittedTrace)}개 불러오기</button>}
          {visibleTrace.map((entry, index) => <button type="button" key={entry.id} className={`trace-row ${selectedEntry?.id === entry.id ? 'selected' : ''}`} style={{ '--trace-depth': entry.depth || 0 }} onClick={() => { onSelectEntry(entry); if (entry.taskId && entry.taskId !== selectedTask?.id) onSelectTask(entry.taskId); }}>
            <span className="trace-rail"><i className={`trace-dot tone-${entry.status}`} />{index < visibleTrace.length - 1 && <b />}</span>
            <span className="trace-body"><span className="trace-meta"><em>{entry.eyebrow}</em><Status value={entry.status} dot={false} /><time>{formatClock(entry.at)}</time></span><strong>{entry.title}</strong>{entry.detail && <small>{entry.detail}</small>}</span>
          </button>)}
        </div>
      </section>
      <DirectorActivityPanel activity={liveActivity} goalId={goal.id} compact activityHeight={activityHeight} setActivityHeight={setActivityHeight} />
    </div>
    <section className={`live-log-pane ${logExpanded ? 'expanded' : 'collapsed'}`}>
      <div className="live-log">
        <button type="button" className="section-title live-log-toggle" aria-expanded={logExpanded} onClick={() => setLogExpanded(current => !current)}><span><Icon name="terminal" />Worker 원문 로그</span><span className="log-actions"><small>{selectedTask ? selectedTask.title : 'Worker를 선택하세요'}</small>{selectedTask && <Status value={taskDisplayStatus(selectedTask)} />}<Icon name="chevron" /></span></button>
        {logExpanded && (errors.trace ? <ErrorNotice title={runtimeUnavailable ? '실행 환경 확인 필요' : '실행 로그 동기화 실패'} onRetry={runtimeUnavailable && onOpenSettings ? onOpenSettings : refresh} retryLabel={runtimeUnavailable && onOpenSettings ? '환경 확인' : '다시 시도'}>{errors.trace}</ErrorNotice>
          : taskTrace?.availability === 'not_started' ? <Empty icon="terminal" title="아직 실행 전입니다">Worker가 시작되면 원문 로그가 여기에 표시됩니다.</Empty>
            : <pre>{taskTrace?.log || 'Trace에서 Worker를 선택하면 원문 로그를 표시합니다.'}</pre>)}
      </div>
    </section>
  </div>;
}

function DirectorView({ director, goal, summary, refresh, onGoalAccepted, onOpenDecision, projectMessages, onLoadOlderMessages }) {
  const canGuideGoal = guideableGoalStates.has(goal?.status);
  const [messageRoute, setMessageRoute] = useState(canGuideGoal ? 'goal' : 'new');
  useEffect(() => { setMessageRoute(canGuideGoal ? 'goal' : 'new'); }, [goal?.id, canGuideGoal]);
  const messages = useMemo(() => {
    const project = buildConversation(null, { recentRuns: projectMessages?.items || [] }, director, 'project')
      .map(message => ({ ...message, kind: message.kind ? `프로젝트 · ${message.kind}` : '프로젝트' }));
    const current = buildConversation(goal, summary, director, 'goal')
      .map(message => ({ ...message, kind: message.kind ? `현재 작업 · ${message.kind}` : '현재 작업' }));
    const unique = new Map([...project, ...current].map(message => [message.id, message]));
    return [...unique.values()].sort((left, right) => Date.parse(left.at || 0) - Date.parse(right.at || 0));
  }, [director, goal, projectMessages?.items, summary]);
  const routeToGoal = canGuideGoal && messageRoute === 'goal';
  const waitingForOwner = goal?.status === 'awaiting_owner' && goal?.ownerDecision?.required;
  return <section className={`director-view ${waitingForOwner ? 'has-context' : ''}`}>
    <header className="channel-header"><span className="director-avatar large">D</span><span><strong>Owner ↔ Director</strong><small>{director?.name || '프로젝트'}의 지속 대화</small></span><div className="channel-route" role="group" aria-label="메시지 전달 대상"><button type="button" disabled={!canGuideGoal} className={routeToGoal ? 'selected' : ''} onClick={() => setMessageRoute('goal')}>현재 작업에 반영</button><button type="button" className={!routeToGoal ? 'selected' : ''} onClick={() => setMessageRoute('new')}>새 작업으로 전달</button></div><span className="channel-actions"><Status value={director?.status} /></span></header>
    {waitingForOwner && <div className="director-context"><section className="director-decision-banner" role="alert" aria-live="polite">
        <span><small>완료 아님 · 오너 결정 대기</small><strong>{goal.ownerDecision.question}</strong></span>
        <button type="button" className="attention-button" onClick={onOpenDecision}>결정 화면 열기 <Icon name="chevron" /></button>
      </section></div>}
    <DirectorComposer
      key={`${director?.id}:${routeToGoal ? goal?.id : 'project'}`}
      directorId={director?.id}
      goalId={routeToGoal ? goal?.id : null}
      messages={messages}
      hasOlder={projectMessages?.hasMore}
      loadingOlder={projectMessages?.loading}
      historyError={projectMessages?.error || ''}
      onLoadOlder={onLoadOlderMessages}
      onAccepted={async accepted => { if (!routeToGoal) onGoalAccepted(accepted?.goalId); refresh(); }}
    />
  </section>;
}

function CompletedTasksMenu({ tasks, onOpen }) {
  if (!tasks.length) return null;
  return <details className="completed-tasks-menu">
    <summary><Icon name="check" /><span>종료 작업</span><b>{tasks.length}</b></summary>
    <div>
      {tasks.map(task => <button type="button" key={task.id} onClick={event => { event.currentTarget.closest('details').open = false; onOpen(task.id); }}><span className={`task-tab-dot ${taskDisplayStatus(task)}`} /><span><strong>{task.title}</strong><small>{workerTabName(tasks, task)} · {statusText(taskDisplayStatus(task))}</small></span></button>)}
    </div>
  </details>;
}

function DecisionBrief({ goal, tasks }) {
  const decision = goal.ownerDecision;
  const analysis = goal.analysis || {};
  const risks = analysis.risks || [];
  const unknowns = analysis.unknowns || [];
  const completed = tasks.filter(task => successStates.has(taskDisplayStatus(task))).length;
  const problems = tasks.filter(task => ['blocked', 'failed'].includes(taskDisplayStatus(task))).length;
  const currentWave = (goal.waves || []).findLast(wave => !successStates.has(wave.status)) || (goal.waves || []).at(-1);
  const recentWorkerEvidence = tasks.map(task => {
    const result = textValue(task.result || task.report || task.summary);
    const checkpoint = textValue(task.checkpoint);
    if (!result && !checkpoint) return null;
    return {
      task,
      content: result || checkpoint,
      kind: result && taskIsTerminal(task) ? '최종 결과' : '공개 체크포인트',
    };
  }).filter(Boolean).slice(-3).reverse();
  const impactByOption = new Map((Array.isArray(decision.optionImpacts) ? decision.optionImpacts : []).map(item => [item.option, item.impact]));
  const optionImpacts = (decision.options || []).map(option => ({
    option,
    impact: impactByOption.get(option) || decisionActionImpacts[decision.optionActions?.[option]]
      || '선택 내용을 기록하고 Director가 현재 증거와 다음 단계를 다시 평가합니다.',
  }));
  return <>
    <section className="inspector-block decision-brief">
      <h3>결정 전 확인</h3>
      <dl className="decision-state">
        <div><dt>현재 Goal</dt><dd>{goal.objective}</dd></div>
        <div><dt>진행 상태</dt><dd>{tasks.length ? `성공 ${completed} / 전체 ${tasks.length}${problems ? ` · 문제 ${problems}` : ''}` : 'Worker 없음'}{currentWave ? ` · Wave ${currentWave.index || (goal.waves || []).indexOf(currentWave) + 1}` : ''}</dd></div>
      </dl>
      {decision.context && <p className="decision-context">{decision.context}</p>}
      <div className={`decision-recommendation ${decision.recommendation ? '' : 'missing'}`}><span>Director 권고</span><strong>{decision.recommendation || '권고가 기록되지 않았습니다. 확인된 근거와 선택 후 동작을 기준으로 결정하세요.'}</strong></div>
    </section>
    {!!optionImpacts.length && <section className="inspector-block decision-impact-section"><h3>선택 후 동작</h3><ol className="decision-impact-list">{optionImpacts.map(item => <li key={item.option}><strong>{item.option}</strong><p>{item.impact}</p></li>)}</ol></section>}
    {!!decision.evidence?.length && <section className="inspector-block decision-facts"><h3>확인된 근거</h3><ul>{decision.evidence.map((item, index) => <li key={`${item}:${index}`}>{item}</li>)}</ul></section>}
    {!!recentWorkerEvidence.length && <section className="inspector-block decision-worker-evidence"><h3>관련 Worker 근거</h3><ul>{recentWorkerEvidence.map(item => <li key={item.task.id}><span><strong>{item.task.title}</strong><span><small>{item.kind}</small><Status value={taskDisplayStatus(item.task)} /></span></span><p>{item.content}</p></li>)}</ul></section>}
    {!!(risks.length || unknowns.length) && <section className="inspector-block decision-risks"><details><summary>위험·미확인 사항 {risks.length + unknowns.length}개</summary>{!!risks.length && <div><strong>위험</strong><ul>{risks.map((item, index) => <li key={`risk:${index}`}>{item}</li>)}</ul></div>}{!!unknowns.length && <div><strong>미확인</strong><ul>{unknowns.map((item, index) => <li key={`unknown:${index}`}>{item}</li>)}</ul></div>}</details></section>}
  </>;
}

async function taskControl(directorId, taskId, action, refresh) {
  await api(`/api/directors/${encodeURIComponent(directorId)}/tasks/${encodeURIComponent(taskId)}/control`, {
    method: 'POST', body: { action, reason: `오너가 Praetorium에서 ${action === 'pause' ? '일시정지' : '재개'}했습니다.` },
  });
  refresh();
}

export function Inspector({ id, closeRef, directorId, goal, selectedEntry, task, tasks = [], taskDetail, taskTrace, errors, refresh, decisionReady = true, workerControls = true, onClose, onOpenSettings }) {
  const [controlError, setControlError] = useState('');
  const record = taskDetail?.praetoriumRecord;
  const pausedByOwner = taskPausedByOwner(task, record);
  const workerTerminal = taskIsTerminal(task, record);
  const displayStatus = taskDisplayStatus(task, record);
  const controlAction = task?.status === 'running' ? 'pause' : pausedByOwner ? 'resume' : null;
  const selectedDecision = selectedEntry?.type === 'decision' && goal?.ownerDecision?.required;
  const runtimeUnavailable = runtimeNeedsAttention(errors.task);
  useEffect(() => { setControlError(''); }, [task?.id]);
  return <aside id={id} className="inspector" aria-label="Inspector">
    <header><span><strong>세부 정보</strong><small>{task ? 'Worker' : selectedEntry?.eyebrow || '선택한 기록'}</small></span>{onClose && <button ref={closeRef} className="icon-button inspector-close" type="button" onClick={onClose} aria-label="세부 정보 닫기"><Icon name="x" /></button>}</header>
    <div className="inspector-scroll">
      {task ? <>
        <section className="inspector-hero"><span className="worker-glyph"><Icon name="command" /></span><small>{task.assignee || task.profile || 'WORKER'}</small><h2>{task.title}</h2><Status value={displayStatus} /></section>
        <section className="inspector-block"><h3>실행 정보</h3><dl className="detail-list"><div><dt>Task ID</dt><dd><code>{task.id}</code></dd></div><div><dt>상태</dt><dd>{statusText(displayStatus)}</dd></div>{pausedByOwner && <div><dt>오너 제어</dt><dd className="attention-copy">일시정지됨 · 재개 가능</dd></div>}<div><dt>시작</dt><dd>{formatClock(task.started_at || task.startedAt)}</dd></div><div><dt>로그</dt><dd>{taskTrace?.availability === 'not_started' ? '실행 전' : taskTrace?.observedAt ? '동기화됨' : '확인 중'}</dd></div></dl></section>
        {!!record?.interventions?.length && <section className="inspector-block"><h3>오너 지시 기록</h3><div className="receipt-list">{record.interventions.map(item => <article key={item.id}><strong>{item.message}</strong><small>{interventionReceiptText(item)}</small>{item.deliveryError && <em>{item.deliveryError}</em>}</article>)}</div></section>}
        {workerControls ? <>
          <section className="inspector-block"><WorkerIntervention key={task.id} directorId={directorId} taskId={task.id} disabled={workerTerminal} onAccepted={refresh} /></section>
          {controlAction && <section className="inspector-block control-row"><button type="button" className="secondary-button" onClick={() => taskControl(directorId, task.id, controlAction, refresh).catch(error => setControlError(error.message))}>{controlAction === 'pause' ? 'Worker 일시정지' : 'Worker 재개'}</button>{controlError && <p className="form-error">{controlError}</p>}</section>}
        </> : <section className="inspector-block"><p className="inspector-copy">Worker 탭 아래 입력에서 지시하거나 실행을 제어할 수 있습니다.</p></section>}
      </> : selectedEntry ? <>
        <section className="inspector-hero"><small>{selectedEntry.eyebrow}</small><h2>{selectedEntry.title}</h2><Status value={selectedEntry.status} /></section>
        {selectedDecision ? <DecisionBrief goal={goal} tasks={tasks} /> : <section className="inspector-block"><h3>상세</h3><p className="inspector-copy">{selectedEntry.detail || '추가 상세 정보가 없습니다.'}</p></section>}
        {selectedDecision && <section className="inspector-block inspector-decision"><h3>결정 전달</h3>{decisionReady
          ? <DecisionForm key={goal.ownerDecision.askedAt || goal.ownerDecision.question} directorId={directorId} goal={goal} onAccepted={refresh} />
          : <p className="decision-unavailable" role="status">{errors.goal ? '전체 결정 범위를 불러오지 못했습니다. 다시 동기화한 뒤 결정하세요.' : '전체 결정 범위를 불러오는 중입니다. 확인 전에는 결정할 수 없습니다.'}</p>}</section>}
        {selectedEntry.raw && <section className="inspector-block"><details><summary>증거 원문</summary><pre className="evidence-json">{JSON.stringify(selectedEntry.raw, null, 2)}</pre></details></section>}
      </> : <Empty icon="activity" title="Trace 항목을 선택하세요">판단 근거, Worker 상태, 실행 원문을 여기서 확인합니다.</Empty>}
      {task && errors.task && <ErrorNotice title={runtimeUnavailable ? '실행 환경 확인 필요' : 'Worker 상세 실패'} onRetry={runtimeUnavailable && onOpenSettings ? onOpenSettings : refresh} retryLabel={runtimeUnavailable && onOpenSettings ? '환경 확인' : '다시 시도'}>{errors.task}</ErrorNotice>}
      {goal?.error && <ErrorNotice title="Goal 오류">{goal.error}</ErrorNotice>}
    </div>
  </aside>;
}

function ProjectRoomHeader({ director, goal, tasks, supervision, onDecision, onDetails, onOwnerDetails, onWorkerAttention, onWorkers, onResetLayout, workerRoomOpen, refresh }) {
  const focus = goalOperationalFocus({ goal, tasks, supervision });
  const ownerAction = { decision: onDecision, worker: onWorkerAttention, refresh, details: onOwnerDetails }[focus.owner.action] || null;
  return <header className={`project-room-header tone-${focus.tone}`}>
    <span className="project-room-signal"><i /></span>
    <div className="project-room-focus" title={focus.current.detail}>
      <small>현재 · {focus.current.label}</small><strong>{focus.current.value}</strong><span>{focus.current.detail}</span>
    </div>
    <div className="project-room-handoff" title={focus.next.detail}><small>다음</small><strong>{focus.next.value}</strong><span>{focus.next.detail}</span></div>
    <button type="button" className={`project-room-owner tone-${focus.owner.tone}`} onClick={ownerAction || undefined} disabled={!ownerAction} title={focus.owner.detail}>
      <small>OWNER</small><strong>{focus.owner.value}</strong><span>{focus.owner.detail}</span>
    </button>
    <ol className="project-room-route" aria-label="Goal 워크플로 진행 단계">{focus.route.map(step => <li key={step.id} className={step.state}><i />{step.label}</li>)}</ol>
    {supervision && <span className={`project-room-health tone-${supervision.tone}`} title={supervision.detail}>{supervision.label}</span>}
    <div className="project-room-actions">
      <button type="button" className={`secondary-button compact ${workerRoomOpen ? 'selected' : ''}`} onClick={onWorkers} aria-pressed={workerRoomOpen}><Icon name="command" />Workers {tasks.length}</button>
      <button type="button" className="icon-button" onClick={onResetLayout} aria-label="탭 배치 초기화" title="탭 배치 초기화"><Icon name="layers" /></button>
      {goal?.ownerDecision?.required && <button type="button" className="attention-button compact" onClick={onDecision}>결정하기</button>}
      <button type="button" className="secondary-button compact" onClick={onDetails}><Icon name="panel" />세부 정보</button>
      {goal && <GoalControls directorId={director?.id} goal={goal} refresh={refresh} />}
    </div>
  </header>;
}

function DockSplitter({ node, onChange }) {
  const dragging = useRef(false);
  const horizontal = node.dir === 'h';
  const boundedRatio = (value, bounds) => {
    const size = horizontal ? bounds?.width : bounds?.height;
    const minimum = Math.min(.45, (horizontal ? 240 : 180) / Math.max(1, size || 1));
    return Math.max(minimum, Math.min(1 - minimum, value));
  };
  const update = event => {
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    const position = horizontal ? event.clientX - bounds.left : event.clientY - bounds.top;
    const size = horizontal ? bounds.width : bounds.height;
    onChange(node.id, boundedRatio(position / Math.max(1, size), bounds));
  };
  const end = event => {
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyDown = event => {
    const delta = horizontal
      ? event.key === 'ArrowLeft' ? -.04 : event.key === 'ArrowRight' ? .04 : 0
      : event.key === 'ArrowUp' ? -.04 : event.key === 'ArrowDown' ? .04 : 0;
    if (!delta && event.key !== 'Home') return;
    event.preventDefault();
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    onChange(node.id, boundedRatio(event.key === 'Home' ? .5 : node.ratio + delta, bounds));
  };
  return <div className={`dock-divider ${horizontal ? 'horizontal' : 'vertical'}`} role="separator" aria-label="탭 패널 크기 조절" aria-orientation={horizontal ? 'vertical' : 'horizontal'} aria-valuemin="18" aria-valuemax="82" aria-valuenow={Math.round(node.ratio * 100)} tabIndex="0" onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); update(event); }} onPointerMove={event => { if (dragging.current) update(event); }} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={() => { dragging.current = false; }} onDoubleClick={() => onChange(node.id, .5)} onKeyDown={keyDown} />;
}

function DockGroup({ node, tasks, taskByPanel, draggedPanel, splitAllowed, compact, dropTarget, setDropTarget, onDragStart, onDragEnd, onActivate, onFocus, onMove, onCanSplit, renderPanel }) {
  const groupRef = useRef(null);
  const [paneSize, setPaneSize] = useState({ width: 0, height: 0 });
  const active = node.tabs.includes(node.active) ? node.active : node.tabs[0];
  const canSplitHere = splitAllowed && !(node.tabs.length === 1 && node.tabs[0] === draggedPanel);
  const dropPositions = ['top', 'right', 'bottom', 'left', 'center'].filter(position => position === 'center' || (canSplitHere
    && (['left', 'right'].includes(position) ? paneSize.width >= 520 : paneSize.height >= 360)));
  useLayoutEffect(() => {
    if (!draggedPanel) return;
    const bounds = groupRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setPaneSize(current => current.width === bounds.width && current.height === bounds.height
      ? current : { width: bounds.width, height: bounds.height });
  }, [draggedPanel, node.id, node.tabs.length]);
  const drop = (event, position = 'center', index = Number.POSITIVE_INFINITY) => {
    event.preventDefault();
    event.stopPropagation();
    if (draggedPanel) onMove(draggedPanel, node.id, position, index);
    setDropTarget(null);
  };
  const keyDownTab = (event, panelId, index) => {
    const splitPosition = !compact && event.ctrlKey && event.altKey && {
      ArrowUp: 'top', ArrowRight: 'right', ArrowDown: 'bottom', ArrowLeft: 'left',
    }[event.key];
    if (splitPosition) {
      event.preventDefault();
      const bounds = groupRef.current?.getBoundingClientRect();
      const enoughSpace = ['left', 'right'].includes(splitPosition) ? bounds?.width >= 520 : bounds?.height >= 360;
      if (node.tabs.length > 1 && enoughSpace && onCanSplit(panelId)) onMove(panelId, node.id, splitPosition);
      return;
    }
    if (!compact && event.altKey && event.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      onMove(panelId, node.id, 'center', event.key === 'ArrowLeft' ? Math.max(0, index - 1) : Math.min(node.tabs.length, index + 2));
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? node.tabs.length - 1
      : (index + (event.key === 'ArrowLeft' ? -1 : 1) + node.tabs.length) % node.tabs.length;
    onActivate(node.tabs[nextIndex]);
    requestAnimationFrame(() => event.currentTarget.parentElement?.querySelectorAll('.dock-tab')[nextIndex]?.focus());
  };
  return <section ref={groupRef} className="dock-group" data-dock-group={node.id}>
    <header className={`dock-tabbar ${dropTarget?.kind === 'tab' && dropTarget.groupId === node.id && dropTarget.index === node.tabs.length ? 'drop-at-end' : ''}`}>
      <div role="tablist" aria-label="작업 탭" onDragOver={event => { if (event.target.closest('.dock-tab')) return; event.preventDefault(); setDropTarget({ kind: 'tab', groupId: node.id, index: node.tabs.length }); }} onDrop={event => drop(event, 'center', node.tabs.length)}>
        {node.tabs.map((panelId, index) => {
          const task = taskByPanel.get(panelId);
          const directorPanel = panelId === DIRECTOR_PANEL_ID;
          const processPanel = panelId === PROCESS_PANEL_ID;
          const label = directorPanel ? 'Director 채팅' : processPanel ? '작업 과정' : workerTabName(tasks, task);
          const title = directorPanel ? 'Owner ↔ Director' : processPanel ? '계획·위임·검증 기록' : task?.title || panelId;
          const insertBefore = dropTarget?.kind === 'tab' && dropTarget.groupId === node.id && dropTarget.index === index;
          return <button type="button" role="tab" draggable={!compact} key={panelId} className={`dock-tab ${active === panelId ? 'selected' : ''} ${insertBefore ? 'drop-before' : ''}`} aria-selected={active === panelId} tabIndex={active === panelId ? 0 : -1} title={compact ? title : `${title} · 끌어서 이동/분할 · Ctrl+Alt+방향키로 분할`} onClick={() => onActivate(panelId)} onDragStart={compact ? undefined : event => onDragStart(event, panelId)} onDragEnd={compact ? undefined : onDragEnd} onDragOver={event => { if (compact) return; event.preventDefault(); event.stopPropagation(); const bounds = event.currentTarget.getBoundingClientRect(); const targetIndex = event.clientX < bounds.left + bounds.width / 2 ? index : index + 1; setDropTarget({ kind: 'tab', groupId: node.id, index: targetIndex }); }} onDrop={compact ? undefined : event => drop(event, 'center', dropTarget?.groupId === node.id ? dropTarget.index : index)} onKeyDown={event => keyDownTab(event, panelId, index)}>
            <Icon name="grip" size={12} />
            {directorPanel ? <span className="tab-avatar">D</span> : processPanel ? <span className="tab-core-icon"><Icon name="activity" size={12} /></span> : <span className={`task-tab-dot ${taskDisplayStatus(task)}`} />}
            <span><strong>{label}</strong><small>{title}</small></span>
          </button>;
        })}
      </div>
    </header>
    <div className="dock-panel-body" role="tabpanel" aria-label={active === DIRECTOR_PANEL_ID ? 'Director 채팅' : active === PROCESS_PANEL_ID ? '작업 과정' : taskByPanel.get(active)?.title || 'Worker'} onPointerDown={() => onFocus(active)}>{renderPanel(active)}</div>
    {draggedPanel && <div className="dock-drop-overlay" aria-hidden="true">
      {dropPositions.map(position => <div key={position} className={`dock-drop-zone ${position} ${dropTarget?.kind === 'zone' && dropTarget.groupId === node.id && dropTarget.position === position ? 'active' : ''}`} data-label={{ top: '위', right: '오른쪽', bottom: '아래', left: '왼쪽', center: '탭' }[position]} onDragOver={event => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropTarget({ kind: 'zone', groupId: node.id, position }); }} onDrop={event => drop(event, position)} />)}
    </div>}
  </section>;
}

function DockNode(props) {
  const { node, onRatio } = props;
  if (node.type === 'group') return <DockGroup {...props} />;
  const firstSize = `${node.ratio * 100}%`;
  const secondSize = `${(1 - node.ratio) * 100}%`;
  return <div className={`dock-split ${node.dir === 'h' ? 'horizontal' : 'vertical'}`} data-split-id={node.id}>
    <div className="dock-split-child" style={{ flexBasis: firstSize }}><DockNode {...props} node={node.children[0]} /></div>
    <DockSplitter node={node} onChange={onRatio} />
    <div className="dock-split-child" style={{ flexBasis: secondSize }}><DockNode {...props} node={node.children[1]} /></div>
  </div>;
}

export default function Workspace({ director, goal, goalDetail, summary, board, selectedTaskId, selectTask, selectGoal, taskDetail, taskTrace, taskFocusRequest, errors, refresh, projectMessages, loadMoreProjectMessages, inspectorOpen, setInspectorOpen, inspectorWidth, setInspectorWidth, activityHeight, setActivityHeight, dockLayout, setDockLayout = () => {}, workerRoomOpen = true, setWorkerRoomOpen = () => {}, lastSyncedAt = null, liveActivity, onOpenSettings }) {
  const detailedGoal = goalDetail?.id === goal?.id ? goalDetail : null;
  const currentGoal = detailedGoal || goal;
  const tasks = useMemo(() => goalTasks(board, currentGoal).map(task => task.id === taskDetail?.task?.id
    ? { ...task, comments: taskDetail.comments || [], events: taskDetail.events || [] }
    : task), [board, currentGoal, taskDetail]);
  const runs = detailedGoal?.runs || (summary?.recentRuns || []).filter(run => run.goalId === goal?.id);
  const trace = useMemo(() => buildTrace(currentGoal, runs, tasks), [currentGoal, runs, tasks]);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [draggedPanel, setDraggedPanel] = useState('');
  const [dropTarget, setDropTarget] = useState(null);
  const [focusedPanel, setFocusedPanel] = useState(DIRECTOR_PANEL_ID);
  const [compactDock, setCompactDock] = useState(false);
  const projectRoomRef = useRef(null);
  const inspectorToggleRef = useRef(null);
  const inspectorCloseRef = useRef(null);
  const selectedTask = tasks.find(task => task.id === selectedTaskId) || null;
  const orderedTasks = useMemo(() => {
    const currentTaskIds = new Set(currentGoal?.currentWaveTaskIds || []);
    return [...tasks].sort((left, right) => {
      const rank = task => {
        if (currentTaskIds.has(task.id)) return 0;
        if (['running', 'executing', 'planning', 'materializing'].includes(taskDisplayStatus(task))) return 1;
        if (taskPausedByOwner(task) || ['failed', 'blocked'].includes(taskDisplayStatus(task))) return 2;
        return taskIsTerminal(task) ? 4 : 3;
      };
      return rank(left) - rank(right);
    });
  }, [tasks, currentGoal]);
  const taskIds = useMemo(() => [...new Set([
    ...orderedTasks.map(task => task.id),
    ...(currentGoal?.taskIds || []),
    ...(currentGoal?.taskRecords || []).map(record => record.taskId).filter(Boolean),
  ])], [orderedTasks, currentGoal]);
  const taskIdsKey = taskIds.join('\u0000');
  const taskByPanel = useMemo(() => new Map(tasks.map(task => [workerPanelId(task.id), task])), [tasks]);
  const layoutReady = Boolean(summary);
  const effectiveDockLayout = useMemo(() => layoutReady
    ? reconcileDockLayout(dockLayout, taskIds, selectedTaskId)
    : createDockLayout(), [dockLayout, layoutReady, taskIdsKey, selectedTaskId]);
  const visibleDockLayout = useMemo(() => {
    const visible = workerRoomOpen ? effectiveDockLayout : filterDockLayout(effectiveDockLayout, panelId => !workerTaskId(panelId));
    return compactDock ? compactDockLayout(visible, focusedPanel) : visible;
  }, [compactDock, effectiveDockLayout, focusedPanel, workerRoomOpen]);
  const supervision = useMemo(() => goalSupervisionHealth({
    director,
    goal: currentGoal,
    runs,
    scheduler: summary?.scheduler,
    lastSyncedAt,
  }), [director, currentGoal, runs, summary?.scheduler, lastSyncedAt]);

  useEffect(() => {
    if (!selectedTaskId) {
      const preferred = tasks.find(task => task.status === 'running') || tasks.at(-1);
      if (preferred) selectTask(preferred.id);
    } else if (!tasks.some(task => task.id === selectedTaskId)) selectTask('');
  }, [tasks, selectedTaskId, selectTask]);
  useEffect(() => {
    if (taskFocusRequest?.taskId) setFocusedPanel(workerPanelId(taskFocusRequest.taskId));
  }, [taskFocusRequest]);
  useEffect(() => { setSelectedEntry(null); }, [goal?.id]);
  useLayoutEffect(() => {
    const room = projectRoomRef.current;
    if (!room) return undefined;
    const update = () => setCompactDock(room.getBoundingClientRect().width < 820);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(room);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!layoutReady) return;
    if (JSON.stringify(dockLayout) !== JSON.stringify(effectiveDockLayout)) setDockLayout(effectiveDockLayout);
  }, [dockLayout, effectiveDockLayout, layoutReady, setDockLayout]);
  useEffect(() => {
    if (!layoutReady || !selectedTaskId) return;
    setDockLayout(current => {
      const reconciled = reconcileDockLayout(current, taskIds, selectedTaskId);
      const next = activateDockPanel(reconciled, workerPanelId(selectedTaskId));
      return JSON.stringify(current) === JSON.stringify(next) ? current : next;
    });
  }, [layoutReady, selectedTaskId, taskIdsKey, setDockLayout]);
  useEffect(() => {
    if (!selectedEntry && selectedTaskId) {
      const taskEntry = trace.find(entry => entry.type === 'task' && entry.taskId === selectedTaskId)
        || trace.find(entry => entry.taskId === selectedTaskId);
      if (taskEntry) setSelectedEntry(taskEntry);
    }
  }, [selectedEntry, selectedTaskId, trace]);
  useEffect(() => {
    if (!inspectorOpen) return undefined;
    const frame = requestAnimationFrame(() => inspectorCloseRef.current?.focus());
    const closeOnEscape = event => { if (event.key === 'Escape' && !document.querySelector('dialog[open], [role="dialog"]')) setInspectorOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', closeOnEscape); inspectorToggleRef.current?.focus(); };
  }, [inspectorOpen, setInspectorOpen]);

  const openTask = id => {
    selectTask(id);
    setSelectedEntry(trace.find(entry => entry.type === 'task' && entry.taskId === id) || trace.find(entry => entry.taskId === id) || null);
  };
  const openOwnerDecision = () => {
    setSelectedEntry(trace.findLast(entry => entry.type === 'decision') || null);
    setInspectorOpen(true);
  };
  const openDetails = () => {
    if (!selectedEntry) setSelectedEntry(trace.at(-1) || null);
    setInspectorOpen(true);
  };
  const beginPanelDrag = (event, panelId) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', panelId);
    setDraggedPanel(panelId);
  };
  const endPanelDrag = () => { setDraggedPanel(''); setDropTarget(null); };
  const activatePanel = panelId => {
    setFocusedPanel(panelId);
    setDockLayout(current => activateDockPanel(reconcileDockLayout(current, taskIds, selectedTaskId), panelId));
    const taskId = workerTaskId(panelId);
    if (taskId) openTask(taskId);
  };
  const openOwnerWorker = () => {
    const task = tasks.find(item => taskPausedByOwner(item) || taskDisplayStatus(item) === 'paused');
    if (!task) return;
    setWorkerRoomOpen(true);
    activatePanel(workerPanelId(task.id));
  };
  const focusPanel = panelId => {
    setFocusedPanel(panelId);
    const taskId = workerTaskId(panelId);
    if (taskId && taskId !== selectedTaskId) selectTask(taskId);
  };
  const movePanel = (panelId, targetGroupId, position, index) => {
    setFocusedPanel(panelId);
    setDockLayout(current => {
      const reconciled = reconcileDockLayout(current, taskIds, selectedTaskId);
      const targetIndex = position === 'center' && !workerRoomOpen
        ? mapDockInsertionIndex(reconciled, filterDockLayout(reconciled, candidate => !workerTaskId(candidate)), targetGroupId, index)
        : index;
      return moveDockPanel(reconciled, panelId, targetGroupId, position, targetIndex);
    });
    const taskId = workerTaskId(panelId);
    if (taskId) selectTask(taskId);
    if (taskId) setWorkerRoomOpen(true);
    endPanelDrag();
  };
  const changeRatio = (splitId, ratio) => setDockLayout(current => updateDockRatio(reconcileDockLayout(current, taskIds, selectedTaskId), splitId, ratio));
  const canSplitPanel = panelId => canSplitDockPanel(effectiveDockLayout, panelId);
  const directorPanel = <DirectorView key="director-panel" director={director} goal={currentGoal} summary={summary} refresh={refresh} projectMessages={projectMessages} onLoadOlderMessages={loadMoreProjectMessages} onOpenDecision={openOwnerDecision} onGoalAccepted={id => { if (id) selectGoal(id); }} />;
  const processPanel = <TraceView key="process-panel" goal={currentGoal} runs={runs} tasks={tasks} trace={trace} selectedEntry={selectedEntry} onSelectEntry={setSelectedEntry} onSelectTask={openTask} onOpenTask={id => activatePanel(workerPanelId(id))} onDirector={() => activatePanel(DIRECTOR_PANEL_ID)} onDecision={openOwnerDecision} directorId={director?.id} refresh={refresh} errors={errors} taskTrace={taskTrace} selectedTask={selectedTask} supervision={supervision} liveActivity={liveActivity} activityHeight={activityHeight} setActivityHeight={setActivityHeight} onOpenSettings={onOpenSettings} />;
  const renderPanel = panelId => {
    if (panelId === DIRECTOR_PANEL_ID) return directorPanel;
    if (panelId === PROCESS_PANEL_ID) return processPanel;
    const task = taskByPanel.get(panelId);
    if (!task) return <div className="workspace-empty"><strong>Worker를 찾을 수 없습니다.</strong><span>현재 Goal의 탭 배치를 다시 동기화합니다.</span></div>;
    const selected = task.id === selectedTaskId;
    return <Suspense key={task.id} fallback={<div className="workspace-empty"><strong>Worker Console 여는 중…</strong><span>실행 출력을 불러오고 있습니다.</span></div>}><WorkerConsole directorId={director?.id} goalId={currentGoal?.id} task={task} detail={selected ? taskDetail : null} trace={selected ? taskTrace : null} detailError={selected ? errors.task : null} traceError={selected ? errors.trace : null} onRefresh={refresh} onOpenSettings={onOpenSettings} /></Suspense>;
  };
  return <>
    <ProjectRoomHeader director={director} goal={currentGoal} tasks={tasks} supervision={supervision} onDecision={openOwnerDecision} onDetails={() => { if (!selectedEntry) setSelectedEntry(trace.at(-1) || null); setInspectorOpen(value => !value); }} onOwnerDetails={openDetails} onWorkerAttention={openOwnerWorker} onWorkers={() => setWorkerRoomOpen(value => !value)} onResetLayout={() => { setDockLayout(createDockLayout(taskIds, selectedTaskId)); setWorkerRoomOpen(true); }} workerRoomOpen={workerRoomOpen} refresh={refresh} />
    <main ref={projectRoomRef} id="workspace" className={`project-room ${compactDock ? 'dock-compact' : ''} ${draggedPanel ? 'dock-dragging' : ''}`} tabIndex="-1">
      <DockNode node={visibleDockLayout} tasks={tasks} taskByPanel={taskByPanel} draggedPanel={draggedPanel} splitAllowed={!draggedPanel || canSplitPanel(draggedPanel)} compact={compactDock} dropTarget={dropTarget} setDropTarget={setDropTarget} onDragStart={beginPanelDrag} onDragEnd={endPanelDrag} onActivate={activatePanel} onFocus={focusPanel} onMove={movePanel} onCanSplit={canSplitPanel} onRatio={changeRatio} renderPanel={renderPanel} />
    </main>
    {inspectorOpen && <><Splitter label="세부 정보 너비" side="right" value={inspectorWidth} min={280} max={520} onChange={setInspectorWidth} onReset={() => setInspectorWidth(312)} /><Inspector id="inspector" closeRef={inspectorCloseRef} directorId={director?.id} goal={currentGoal} selectedEntry={selectedEntry} task={selectedEntry?.type === 'task' ? selectedTask : null} tasks={tasks} taskDetail={taskDetail} taskTrace={taskTrace} errors={errors} refresh={refresh} decisionReady={Boolean(detailedGoal) && !errors.goal} workerControls={false} onClose={() => setInspectorOpen(false)} onOpenSettings={onOpenSettings} /></>}
  </>;
}
