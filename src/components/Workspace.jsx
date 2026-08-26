import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import {
  buildConversation, buildTrace, goalControlOptions, goalSupervisionHealth, goalTasks,
  interventionReceiptText, taskDisplayStatus, taskIsTerminal, taskPausedByOwner, textValue,
} from '../domain/operator-model.js';
import { DecisionForm, DirectorComposer, WorkerIntervention } from './forms.jsx';
import { Empty, ErrorNotice, formatClock, Icon, relativeTime, Splitter, Status, statusText } from './common.jsx';

const successStates = new Set(['done', 'completed', 'succeeded', 'success', 'archived']);
const activeGoalStates = new Set(['clarifying', 'planning', 'executing', 'evaluating', 'remediating', 'verifying', 'awaiting_owner']);
const guideableGoalStates = new Set(['clarifying', 'planning', 'executing', 'evaluating', 'remediating', 'verifying']);
const EVIDENCE_PAGE_SIZE = 20;

const workerRoleNames = {
  'codex-implementer': '구현', remediator: '수정',
  'adversarial-reviewer': '반대 검증', 'quality-gate-reviewer': '품질 게이트',
  'convention-reviewer': '규칙 검토', 'test-gap-reviewer': '테스트 검토',
  'security-reviewer': '보안 검토', 'architecture-reviewer': '구조 검토',
  'performance-reviewer': '성능 검토', 'release-reviewer': '배포 검토',
};

function workerTabName(tasks, task) {
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

function LatestConclusion({ goal, runs, onOpen }) {
  const run = [...(runs || [])].reverse().find(item => item.output || item.publicDecisions?.length);
  const conclusion = textValue(goal?.finalReport) || run?.output || textValue(run?.publicDecisions?.at(-1));
  const preview = String(conclusion || '').replace(/\[([^\]]+)\]\(https?:\/\/[^)\s]+\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^\s*(?:```[^\n]*|\d+\.\s+|[-*#>]\s*)/gm, '').replace(/\s+/g, ' ').trim();
  return <button type="button" className="conclusion-preview" onClick={onOpen}>
    <span className="director-avatar large">D</span>
    <span><small>디렉터 최근 결론</small><strong>{preview || (run?.status === 'running' ? '디렉터가 다음 행동을 판단하고 있습니다.' : '아직 디렉터 결론이 없습니다.')}</strong><em>대화에서 전체 보기 <Icon name="chevron" /></em></span>
  </button>;
}

function DirectorActivityPanel({ activity, goalId = null, compact = false }) {
  const scopedEvents = (activity?.events || []).filter(event => !goalId || event.goalId === goalId || ['ready', 'resync'].includes(event.type));
  const events = scopedEvents.slice(compact ? -10 : -18).reverse();
  return <details className={`director-activity-panel ${compact ? 'compact' : ''}`} open>
    <summary>
      <span><Icon name="activity" /><strong>디렉터 공개 활동</strong><small>운영 단계 · 체크포인트</small></span>
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
  </details>;
}

function TraceView({ goal, runs, tasks, trace, selectedEntry, onSelectEntry, onSelectTask, onDirector, directorId, refresh, errors, taskTrace, selectedTask, supervision, liveActivity }) {
  const scrollRef = useRef(null);
  const [follow, setFollow] = useState(true);
  const [traceLimit, setTraceLimit] = useState(160);
  const visibleTrace = trace.slice(-traceLimit);
  const omittedTrace = trace.length - visibleTrace.length;
  useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' });
  }, [trace.length, follow]);
  useEffect(() => { setTraceLimit(160); }, [goal?.id]);
  if (!goal) return <div className="workspace-empty"><Empty icon="branch" title="표시할 Goal이 없습니다">디렉터 채팅에서 새 목표를 보내세요.</Empty><button type="button" className="primary-button" onClick={onDirector}>디렉터 열기</button></div>;
  const ownerDecision = goal.ownerDecision?.required;
  return <div className="trace-view">
    <GoalHeader directorId={directorId} goal={goal} tasks={tasks} supervision={supervision} onDirector={onDirector} refresh={refresh} />
    <div className="conclusion-bar"><LatestConclusion goal={goal} runs={runs} onOpen={onDirector} /></div>
    <div className="trace-content" ref={scrollRef} onScroll={event => setFollow(event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight < 48)}>
      <DirectorActivityPanel activity={liveActivity} goalId={goal.id} compact />
      {ownerDecision && <section className="decision-gate">
        <header><span><Icon name="user" />오너 결정 필요</span><time>{formatClock(goal.ownerDecision.askedAt)}</time></header>
        <h2>{goal.ownerDecision.question}</h2>
        {!!goal.ownerDecision.evidence?.length && <ul>{goal.ownerDecision.evidence.map(item => <li key={item}>{item}</li>)}</ul>}
        <DecisionForm key={goal.ownerDecision.askedAt || goal.ownerDecision.question} directorId={directorId} goal={goal} onAccepted={refresh} />
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
    </div>
    <section className="live-log-pane">
      <div className="live-log">
        <header className="section-title"><span><Icon name="terminal" />Worker 원문 로그</span><span className="log-actions"><small>{selectedTask ? selectedTask.title : 'Worker를 선택하세요'}</small>{selectedTask && <Status value={taskDisplayStatus(selectedTask)} />}</span></header>
        {errors.trace ? <ErrorNotice title="실행 로그 동기화 실패" onRetry={refresh}>{errors.trace}</ErrorNotice>
          : taskTrace?.availability === 'not_started' ? <Empty icon="terminal" title="아직 실행 전입니다">Worker가 시작되면 원문 로그가 여기에 표시됩니다.</Empty>
            : <pre>{taskTrace?.log || 'Trace에서 Worker를 선택하면 원문 로그를 표시합니다.'}</pre>}
      </div>
    </section>
  </div>;
}

function DirectorView({ director, goal, summary, refresh, onGoalAccepted, onOpenDecision, chatScope, setChatScope, projectMessages, onLoadOlderMessages, liveActivity }) {
  const conversationSummary = chatScope === 'project' ? { recentRuns: projectMessages?.items || [] } : summary;
  const messages = useMemo(() => buildConversation(goal, conversationSummary, director, chatScope), [goal, conversationSummary, director, chatScope]);
  const canGuideGoal = chatScope === 'goal' && guideableGoalStates.has(goal?.status);
  return <section className="director-view">
    <header className="channel-header"><span className="director-avatar large">D</span><span><strong>디렉터</strong><small>{chatScope === 'goal' && goal ? goal.objective : `${director?.name || '프로젝트'} 전체 대화`}</small></span><div className="channel-scope" role="group" aria-label="디렉터 대화 범위"><button type="button" className={chatScope === 'project' ? 'selected' : ''} onClick={() => setChatScope('project')}>프로젝트</button><button type="button" disabled={!goal} className={chatScope === 'goal' ? 'selected' : ''} onClick={() => setChatScope('goal')}>현재 Goal</button></div><span className="channel-actions"><Status value={director?.status} />{chatScope === 'goal' && goal?.ownerDecision?.required && <button type="button" className="attention-button" onClick={onOpenDecision}>결정 필요 <Icon name="chevron" /></button>}</span></header>
    <DirectorActivityPanel activity={liveActivity} goalId={chatScope === 'goal' ? goal?.id : null} compact />
    <DirectorComposer
      key={`${director?.id}:${chatScope}:${chatScope === 'goal' ? goal?.id || 'none' : 'project'}`}
      directorId={director?.id}
      goalId={canGuideGoal ? goal?.id : null}
      messages={messages}
      readOnly={chatScope === 'goal' && !canGuideGoal}
      readOnlyAction={goal?.status === 'awaiting_owner'
        ? <button type="button" className="attention-button" onClick={onOpenDecision}>대기 중인 결정 응답하기</button>
        : <button type="button" className="secondary-button compact" onClick={() => setChatScope('project')}>프로젝트 대화 열기</button>}
      hasOlder={chatScope === 'project' && projectMessages?.hasMore}
      loadingOlder={chatScope === 'project' && projectMessages?.loading}
      historyError={chatScope === 'project' ? projectMessages?.error : ''}
      onLoadOlder={onLoadOlderMessages}
      onAccepted={async accepted => { if (chatScope === 'project') onGoalAccepted(accepted?.goalId); refresh(); }}
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

function WorkerView({ task, detail, trace, error, onRetry }) {
  const [commentLimit, setCommentLimit] = useState(EVIDENCE_PAGE_SIZE);
  const [eventLimit, setEventLimit] = useState(EVIDENCE_PAGE_SIZE);
  useEffect(() => {
    setCommentLimit(EVIDENCE_PAGE_SIZE);
    setEventLimit(EVIDENCE_PAGE_SIZE);
  }, [task?.id]);
  if (!task) return <div className="workspace-empty"><Empty icon="terminal" title="Worker를 선택하세요">Trace나 상단 Worker 탭에서 작업을 여세요.</Empty></div>;
  const raw = detail?.task || task;
  const allComments = Array.isArray(detail?.comments) ? detail.comments : [];
  const allEvents = Array.isArray(detail?.events) ? detail.events : [];
  const comments = allComments.slice(-commentLimit);
  const events = allEvents.slice(-eventLimit);
  const omittedComments = Math.max(0, allComments.length - comments.length);
  const omittedEvents = Math.max(0, allEvents.length - events.length);
  const runs = detail?.runs || [];
  const latestSummary = detail?.latest_summary || detail?.latestSummary || raw.summary;
  const validation = detail?.validation || raw.validation || runs.at(-1)?.validation || null;
  const validationSummary = textValue(validation?.summary || validation?.report || validation?.result || validation);
  const finalEvidence = detail?.report || raw.report || raw.result || runs.at(-1)?.report || runs.at(-1)?.output || runs.at(-1)?.result || latestSummary || validationSummary;
  const displayStatus = taskDisplayStatus(task, detail?.praetoriumRecord);
  return <section className="worker-view">
    <header className="worker-header"><span className="worker-glyph"><Icon name="command" /></span><span><small>{task.assignee || task.profile || 'WORKER'}</small><h1>{task.title}</h1></span><Status value={displayStatus} /></header>
    {error && <ErrorNotice title="Worker 상세 동기화 실패" onRetry={onRetry}>{error}</ErrorNotice>}
    <div className="worker-summary-grid">
      <dl><div><dt>Task ID</dt><dd><code>{task.id}</code></dd></div><div><dt>상태</dt><dd>{statusText(displayStatus)}</dd></div><div><dt>시작</dt><dd>{task.started_at ? `${formatClock(task.started_at)} · ${relativeTime(task.started_at)}` : '아직 시작하지 않음'}</dd></div><div><dt>담당</dt><dd>{task.assignee || task.profile || '미배정'}</dd></div></dl>
      <article><h2>공개 체크포인트</h2><p>{textValue(latestSummary || raw.checkpoint || raw.description) || '아직 Worker가 외부화한 체크포인트가 없습니다.'}</p></article>
    </div>
    <div className="worker-evidence-grid">
      <section><header className="section-title"><span><Icon name="message" />공개 체크포인트</span><small>{comments.length} / {allComments.length}</small></header><div className="evidence-list">{omittedComments > 0 && <button type="button" className="evidence-more" onClick={() => setCommentLimit(limit => limit + EVIDENCE_PAGE_SIZE)}>이전 {Math.min(EVIDENCE_PAGE_SIZE, omittedComments)}개 보기</button>}{comments.map((comment, index) => { const at = comment.createdAt || comment.created_at || comment.at; return <article key={comment.id || `${at}:${index}`}><header><strong>{comment.author || 'Worker'}</strong><time dateTime={at || undefined}>{formatClock(at)}</time></header><p>{textValue(comment.body || comment.message || comment)}</p></article>; })}{!comments.length && <p className="evidence-empty">공개 체크포인트가 아직 없습니다.</p>}</div></section>
      <section><header className="section-title"><span><Icon name="activity" />수명주기 증거</span><small>{events.length} / {allEvents.length}</small></header><div className="evidence-list">{omittedEvents > 0 && <button type="button" className="evidence-more" onClick={() => setEventLimit(limit => limit + EVIDENCE_PAGE_SIZE)}>이전 {Math.min(EVIDENCE_PAGE_SIZE, omittedEvents)}개 보기</button>}{events.map((event, index) => { const at = event.createdAt || event.created_at || event.at; return <article key={event.id || `${at}:${index}`}><header><strong>{statusText(event.status || event.phase || event.type || event.kind)}</strong><time dateTime={at || undefined}>{formatClock(at)}</time></header><p>{textValue(event.message || event.details || event.payload || event)}</p></article>; })}{!events.length && <p className="evidence-empty">수명주기 이벤트가 아직 없습니다.</p>}</div></section>
      <section className="final-evidence"><header className="section-title"><span><Icon name="check" />최종 결과·검증</span><small>{runs.length ? `${runs.length} runs` : ''}</small></header><p>{textValue(finalEvidence) || '최종 결과나 구조화 검증이 아직 없습니다.'}</p>{validation && <div className="validation-evidence"><strong>구조화 검증</strong>{validationSummary && <p>{validationSummary}</p>}<details><summary>검증 원문 보기</summary><pre>{typeof validation === 'string' ? validation : JSON.stringify(validation, null, 2)}</pre></details></div>}</section>
    </div>
    <div className="worker-log-full"><header className="section-title"><span><Icon name="terminal" />명령·결과 원문</span><small>{trace?.observedAt ? `동기화 ${formatClock(trace.observedAt)}` : ''}</small></header><pre>{trace?.log || (trace?.availability === 'not_started' ? 'Worker 실행 전 · 로그 없음' : '로그를 불러오는 중…')}</pre></div>
  </section>;
}

async function taskControl(directorId, taskId, action, refresh) {
  await api(`/api/directors/${encodeURIComponent(directorId)}/tasks/${encodeURIComponent(taskId)}/control`, {
    method: 'POST', body: { action, reason: `오너가 Praetorium에서 ${action === 'pause' ? '일시정지' : '재개'}했습니다.` },
  });
  refresh();
}

export function Inspector({ id, closeRef, directorId, goal, selectedEntry, task, taskDetail, taskTrace, errors, refresh, onClose }) {
  const [controlError, setControlError] = useState('');
  const record = taskDetail?.praetoriumRecord;
  const pausedByOwner = taskPausedByOwner(task, record);
  const workerTerminal = taskIsTerminal(task, record);
  const displayStatus = taskDisplayStatus(task, record);
  const controlAction = task?.status === 'running' ? 'pause' : pausedByOwner ? 'resume' : null;
  useEffect(() => { setControlError(''); }, [task?.id]);
  return <aside id={id} className="inspector" aria-label="Inspector">
    <header><span><strong>세부 정보</strong><small>{task ? 'Worker' : selectedEntry?.eyebrow || '선택한 기록'}</small></span>{onClose && <button ref={closeRef} className="icon-button inspector-close" type="button" onClick={onClose} aria-label="세부 정보 닫기"><Icon name="x" /></button>}</header>
    <div className="inspector-scroll">
      {task ? <>
        <section className="inspector-hero"><span className="worker-glyph"><Icon name="command" /></span><small>{task.assignee || task.profile || 'WORKER'}</small><h2>{task.title}</h2><Status value={displayStatus} /></section>
        <section className="inspector-block"><h3>실행 정보</h3><dl className="detail-list"><div><dt>Task ID</dt><dd><code>{task.id}</code></dd></div><div><dt>상태</dt><dd>{statusText(displayStatus)}</dd></div>{pausedByOwner && <div><dt>오너 제어</dt><dd className="attention-copy">일시정지됨 · 재개 가능</dd></div>}<div><dt>시작</dt><dd>{formatClock(task.started_at || task.startedAt)}</dd></div><div><dt>로그</dt><dd>{taskTrace?.availability === 'not_started' ? '실행 전' : taskTrace?.observedAt ? '동기화됨' : '확인 중'}</dd></div></dl></section>
        {!!record?.interventions?.length && <section className="inspector-block"><h3>오너 지시 기록</h3><div className="receipt-list">{record.interventions.map(item => <article key={item.id}><strong>{item.message}</strong><small>{interventionReceiptText(item)}</small>{item.deliveryError && <em>{item.deliveryError}</em>}</article>)}</div></section>}
        <section className="inspector-block"><WorkerIntervention key={task.id} directorId={directorId} taskId={task.id} disabled={workerTerminal} onAccepted={refresh} /></section>
        {controlAction && <section className="inspector-block control-row"><button type="button" className="secondary-button" onClick={() => taskControl(directorId, task.id, controlAction, refresh).catch(error => setControlError(error.message))}>{controlAction === 'pause' ? 'Worker 일시정지' : 'Worker 재개'}</button>{controlError && <p className="form-error">{controlError}</p>}</section>}
      </> : selectedEntry ? <>
        <section className="inspector-hero"><small>{selectedEntry.eyebrow}</small><h2>{selectedEntry.title}</h2><Status value={selectedEntry.status} /></section>
        <section className="inspector-block"><h3>상세</h3><p className="inspector-copy">{selectedEntry.detail || '추가 상세 정보가 없습니다.'}</p></section>
        {selectedEntry.type === 'decision' && goal?.ownerDecision?.required && <section className="inspector-block inspector-decision"><h3>결정 전달</h3><DecisionForm key={goal.ownerDecision.askedAt || goal.ownerDecision.question} directorId={directorId} goal={goal} onAccepted={refresh} /></section>}
        {selectedEntry.raw && <section className="inspector-block"><details><summary>증거 원문</summary><pre className="evidence-json">{JSON.stringify(selectedEntry.raw, null, 2)}</pre></details></section>}
      </> : <Empty icon="activity" title="Trace 항목을 선택하세요">판단 근거, Worker 상태, 실행 원문을 여기서 확인합니다.</Empty>}
      {errors.task && <ErrorNotice title="Worker 상세 실패" onRetry={refresh}>{errors.task}</ErrorNotice>}
      {goal?.error && <ErrorNotice title="Goal 오류">{goal.error}</ErrorNotice>}
    </div>
  </aside>;
}

export default function Workspace({ activeTab, setActiveTab, chatScope, setChatScope, director, goal, goalDetail, summary, board, selectedTaskId, selectTask, selectGoal, taskDetail, taskTrace, errors, refresh, projectMessages, loadMoreProjectMessages, inspectorOpen, setInspectorOpen, inspectorWidth, setInspectorWidth, lastSyncedAt = null, liveActivity }) {
  const tasks = useMemo(() => goalTasks(board, goalDetail || goal).map(task => task.id === taskDetail?.task?.id
    ? { ...task, comments: taskDetail.comments || [], events: taskDetail.events || [] }
    : task), [board, goalDetail, goal, taskDetail]);
  const runs = goalDetail?.runs || (summary?.recentRuns || []).filter(run => run.goalId === goal?.id);
  const trace = useMemo(() => buildTrace(goalDetail || goal, runs, tasks), [goalDetail, goal, runs, tasks]);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const inspectorToggleRef = useRef(null);
  const inspectorCloseRef = useRef(null);
  const selectedTask = tasks.find(task => task.id === selectedTaskId) || null;
  const completedTasks = tasks.filter(task => taskIsTerminal(task));
  const taskTabs = tasks.filter(task => !taskIsTerminal(task) || activeTab === `task:${task.id}`);
  const supervision = useMemo(() => goalSupervisionHealth({
    director,
    goal: goalDetail || goal,
    runs,
    scheduler: summary?.scheduler,
    lastSyncedAt,
  }), [director, goalDetail, goal, runs, summary?.scheduler, lastSyncedAt]);

  useEffect(() => {
    if (!selectedTaskId) {
      const preferred = tasks.find(task => task.status === 'running') || tasks.at(-1);
      if (preferred) selectTask(preferred.id);
    } else if (!tasks.some(task => task.id === selectedTaskId)) selectTask('');
    else if (activeTab === 'trace' && taskIsTerminal(tasks.find(task => task.id === selectedTaskId))) {
      const running = tasks.find(task => task.status === 'running');
      if (running && running.id !== selectedTaskId) selectTask(running.id);
    }
  }, [activeTab, tasks, selectedTaskId, selectTask]);
  useEffect(() => { setSelectedEntry(null); }, [goal?.id]);
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
    const closeOnEscape = event => { if (event.key === 'Escape' && !document.querySelector('[role="dialog"]')) setInspectorOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', closeOnEscape); inspectorToggleRef.current?.focus(); };
  }, [inspectorOpen, setInspectorOpen]);

  const openTask = id => {
    selectTask(id);
    setSelectedEntry(trace.find(entry => entry.type === 'task' && entry.taskId === id) || trace.find(entry => entry.taskId === id) || null);
    setActiveTab(`task:${id}`);
  };
  const tabId = value => `workspace-tab-${value.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const handleTabKey = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]:not(:disabled)')];
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    tabs[next].click();
  };
  return <>
    <div className="workspace-tabbar">
      <nav className="workspace-tabs" role="tablist" aria-label="작업 공간" onKeyDown={handleTabKey}>
        <button id={tabId('trace')} type="button" role="tab" aria-controls="workspace" aria-selected={activeTab === 'trace'} tabIndex={activeTab === 'trace' ? 0 : -1} className={activeTab === 'trace' ? 'selected' : ''} onClick={() => setActiveTab('trace')}><Icon name="activity" />현황</button>
        <button id={tabId('director')} type="button" role="tab" aria-controls="workspace" aria-selected={activeTab === 'director'} tabIndex={activeTab === 'director' ? 0 : -1} className={activeTab === 'director' ? 'selected' : ''} onClick={() => setActiveTab('director')}><span className="tab-avatar">D</span>디렉터{director?.status === 'running' && <i className="tab-live" />}</button>
        <span className="tab-divider" />
        <div className="worker-tabs">
          {taskTabs.map(task => <button id={tabId(`task:${task.id}`)} type="button" key={task.id} role="tab" aria-controls="workspace" aria-selected={activeTab === `task:${task.id}`} tabIndex={activeTab === `task:${task.id}` ? 0 : -1} className={activeTab === `task:${task.id}` ? 'selected' : ''} onClick={() => openTask(task.id)} title={`${workerTabName(tasks, task)} · ${task.title}`}><span className={`task-tab-dot ${taskDisplayStatus(task)}`} /><span>{workerTabName(tasks, task)}</span><small>{taskPausedByOwner(task) ? '일시정지 · 재개 가능' : task.title}</small></button>)}
        </div>
        <CompletedTasksMenu tasks={completedTasks} onOpen={openTask} />
      </nav>
      <button ref={inspectorToggleRef} type="button" className={`inspector-toggle ${inspectorOpen ? 'selected' : ''}`} aria-controls="inspector" aria-expanded={inspectorOpen} onClick={() => setInspectorOpen(value => !value)}><Icon name="panel" /><span>세부</span></button>
    </div>
    <main id="workspace" className="workspace" role="tabpanel" aria-labelledby={tabId(activeTab)} tabIndex="-1">
      {activeTab === 'director' ? <DirectorView director={director} goal={goalDetail || goal} summary={summary} refresh={refresh} chatScope={chatScope} setChatScope={setChatScope} projectMessages={projectMessages} onLoadOlderMessages={loadMoreProjectMessages} liveActivity={liveActivity} onOpenDecision={() => setActiveTab('trace')} onGoalAccepted={id => { if (id) { selectGoal(id); setChatScope('goal'); setActiveTab('trace'); } }} />
        : activeTab.startsWith('task:') ? <WorkerView task={selectedTask} detail={taskDetail} trace={taskTrace} error={errors.task} onRetry={refresh} />
          : <TraceView goal={goalDetail || goal} runs={runs} tasks={tasks} trace={trace} selectedEntry={selectedEntry} onSelectEntry={setSelectedEntry} onSelectTask={selectTask} onDirector={() => setActiveTab('director')} directorId={director?.id} refresh={refresh} errors={errors} taskTrace={taskTrace} selectedTask={selectedTask} supervision={supervision} liveActivity={liveActivity} />}
    </main>
    {inspectorOpen && <><Splitter label="세부 정보 너비" side="right" value={inspectorWidth} min={280} max={520} onChange={setInspectorWidth} onReset={() => setInspectorWidth(336)} /><Inspector id="inspector" closeRef={inspectorCloseRef} directorId={director?.id} goal={goalDetail || goal} selectedEntry={selectedEntry} task={(selectedEntry?.type === 'task' || activeTab.startsWith('task:')) ? selectedTask : null} taskDetail={taskDetail} taskTrace={taskTrace} errors={errors} refresh={refresh} onClose={() => setInspectorOpen(false)} /></>}
  </>;
}
