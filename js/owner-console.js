const MAX_PROJECTS = 3;
const POLL_INTERVAL_MS = 3000;
const TASK_POLL_INTERVAL_MS = 2800;
const NARROW_VIEW_QUERY = '(max-width: 860px)';

const state = {
  summary: null,
  projects: [],
  projectsLoaded: false,
  projectsError: null,
  runtimes: [],
  runtimesLoaded: false,
  runtimesError: null,
  runtimeRequestId: 0,
  profiles: [],
  profilesLoaded: false,
  profilesError: null,
  selectedProfileId: null,
  selectedSkillId: null,
  managementTab: 'projects',
  selectedId: 'project-director-1',
  board: [],
  boardStatus: null,
  selection: { type: 'overview', id: null },
  taskDetail: null,
  taskTrace: null,
  taskError: null,
  taskTraceError: null,
  taskLoading: false,
  taskLoadedAt: 0,
  goalDetail: null,
  goalDetailId: null,
  goalDetailError: null,
  goalDetailErrorId: null,
  goalDetailLoading: false,
  goalDetailLoadingId: null,
  goalDetailLoadedAt: 0,
  inspectorRenderKey: null,
  inspectorOpener: null,
  interventionDraft: '',
  interventionComposing: false,
  interventionReceipt: null,
  decisionDraft: '',
  decisionOption: '',
  decisionGoalId: null,
  decisionError: null,
  decisionComposing: false,
  rawLogOpen: null,
  traceFilters: new Set(['decision', 'worker', 'gate', 'failure']),
  waveExpansion: new Map(),
  runtimeGuideId: null,
  busyActions: new Set(),
  managementLoads: {},
  consoleError: null,
  lastSyncedAt: 0,
  refreshing: false,
  staleSince: 0,
  loading: null,
  timer: null,
};

const $ = id => document.getElementById(id);

const FOCUS_KEYS = [
  'data-director', 'data-trace-selection', 'data-select-trace', 'data-select-task', 'data-attention-task', 'data-profile', 'data-skill',
  'data-worker-control', 'data-send-intervention', 'data-raw-worker-log-summary', 'data-retry-board',
  'data-retry-task', 'data-open-projects', 'data-goal-task', 'data-owner-decision-option',
  'data-owner-decision-submit', 'data-trace-filter', 'data-wave-toggle',
  'data-retry-goal',
];

function activeElementIdentity() {
  const element = document.activeElement;
  if (!element || element === document.body) return null;
  if (element.id) return { id: element.id };
  const attribute = FOCUS_KEYS.find(key => element.hasAttribute(key));
  return attribute ? { attribute, value: element.getAttribute(attribute) } : null;
}

function elementFromIdentity(identity) {
  if (!identity) return null;
  return identity.id
    ? $(identity.id)
    : [...document.querySelectorAll(`[${identity.attribute}]`)].find(item => item.getAttribute(identity.attribute) === identity.value);
}

function restoreActiveElement(identity) {
  if (!identity) return;
  requestAnimationFrame(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    elementFromIdentity(identity)?.focus?.({ preventScroll: true });
  });
}

function updateHtml(element, html) {
  if (element.innerHTML === html) return false;
  element.innerHTML = html;
  return true;
}

function preferredScrollBehavior() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function panelErrorHtml(title, message, target) {
  return `<div class="project-empty" role="alert"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(friendlyErrorMessage(message))}</span><button type="button" class="secondary-button" data-retry-management="${escapeHtml(target)}">다시 시도</button></div>`;
}

function friendlyErrorMessage(value) {
  const message = String(value?.message || value || '알 수 없는 오류가 발생했습니다.');
  const known = [
    [/Director has no assigned project directory/i, '프로젝트를 먼저 Director에 연결하세요.'],
    [/Director is already running/i, 'Director가 현재 다른 요청을 처리하고 있습니다. 완료 후 다시 시도하세요.'],
    [/Director not found/i, '선택한 Director를 찾을 수 없습니다. 화면을 새로고침하세요.'],
    [/Task not found/i, '선택한 Worker 작업을 찾을 수 없습니다. 작업 보드를 다시 불러오세요.'],
    [/Only a paused task can be resumed/i, '일시정지된 Worker만 재개할 수 있습니다.'],
    [/previous Praetorium shutdown|Interrupted by/i, '이전 앱 종료로 Director 실행이 중단됐습니다. 같은 목표를 새로 보내 다시 시작하세요.'],
    [/timed out|timeout/i, '로컬 실행 응답이 제한 시간을 넘겼습니다. 런타임 상태를 확인한 뒤 다시 시도하세요.'],
    [/Failed to fetch|NetworkError/i, '로컬 Praetorium 서버에 연결할 수 없습니다. 서버 상태를 확인하세요.'],
  ];
  return known.find(([pattern]) => pattern.test(message))?.[1] || message;
}

function inlineErrorHtml(title, error, retry = '') {
  const raw = String(error?.message || error || '');
  const friendly = friendlyErrorMessage(raw);
  return `<div class="inline-error" role="alert"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(friendly)}</p>${raw && raw !== friendly ? `<details><summary>기술 정보</summary><code>${escapeHtml(raw)}</code></details>` : ''}${retry ? `<button type="button" class="secondary-button" ${retry}>다시 시도</button>` : ''}</div>`;
}

function setManagementFeedback(message = '', kind = 'info') {
  const root = $('management-feedback');
  if (!root) return;
  root.hidden = !message;
  root.className = `management-feedback ${kind}`;
  root.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  root.textContent = message ? friendlyErrorMessage(message) : '';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function formatText(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

function stripAnsi(value) {
  return String(value || '').replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
}

function timeMs(value) {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function elapsedLabel(value, end = Date.now()) {
  const started = timeMs(value);
  const ended = timeMs(end) || end;
  if (!started || !Number.isFinite(ended)) return '';
  const seconds = Math.max(0, Math.floor((ended - started) / 1000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

function clockLabel(value) {
  const parsed = timeMs(value);
  return parsed ? new Date(parsed).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
}

function phaseLabel(phase) {
  return ({
    queued: '대기', preparing: '요청 분류', analyzing: '요구·위험 분석', analyzed: '분석 확정',
    directing: '실행 설계', retrying: '판단 재시도', materializing: '작업 생성', dispatching: 'Worker 배치',
    delegated: 'Worker 실행', clarifying: '명세 확인', planning: '계획 수립', executing: 'Worker 실행',
    evaluating: '결과 평가', remediating: '재작업', verifying: '완료 검증', awaiting_owner: 'Owner 판단 대기',
    assessing_evidence: 'Worker 증거 평가', goal_completed: 'Goal 완료 판정', goal_blocked: 'Goal 중단 판정',
    recovering: 'Goal 감독 복구', worker_progress: 'Worker 상태 감시', retry_scheduled: '자동 재시도 예약',
    owner_answered: 'Owner 결정 반영', completed: '완료', blocked: '중단', failed: '실패',
  })[phase] || phase || '대기';
}

function controlPlaneUnavailable() {
  return Boolean(state.consoleError || state.boardStatus?.error);
}

function statusLabel(status) {
  return ({
    idle: '대기', running: '실행 중', unassigned: '미배정', error: '확인 필요',
    ready: '실행 대기', todo: '선행 작업 대기', review: '리뷰 중', blocked: 'Owner 판단',
    done: '완료', archived: '보관', scheduled: '일시정지', failed: '실패', queued: '대기', completed: '완료',
    clarifying: '명세 확인', planning: '계획 수립', executing: 'Worker 실행', evaluating: '결과 평가',
    remediating: '재작업', verifying: '완료 검증', awaiting_owner: 'Owner 판단 대기', materializing: '작업 생성',
    cancelled: '취소됨',
  })[status] || status || '대기';
}

function runtimeLabel(value) {
  return value?.runtime === 'wsl' || value?.kind === 'wsl'
    ? `WSL · ${value.distro || '배포판 미지정'}`
    : 'Windows';
}

function traceStatus(status) {
  if (['done', 'completed', 'archived', 'delegated'].includes(status)) return 'done';
  if (['running', 'analyzing', 'directing', 'materializing', 'dispatching', 'clarifying', 'planning', 'executing', 'evaluating', 'remediating', 'verifying'].includes(status)) return 'running';
  if (status === 'awaiting_owner') return 'blocked';
  if (['blocked', 'review', 'failed', 'error'].includes(status)) return status === 'failed' || status === 'error' ? 'failed' : 'blocked';
  if (['ready', 'todo', 'scheduled'].includes(status)) return status === 'scheduled' ? 'blocked' : 'ready';
  return 'queued';
}

function toast(message, kind = 'info') {
  if ($('project-dialog')?.open) {
    setManagementFeedback(message, kind);
    return;
  }
  const root = $('toast');
  root.textContent = friendlyErrorMessage(message);
  root.className = `toast visible ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { root.className = 'toast'; }, 3200);
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
  try {
    const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
    const response = await fetch(path, {
      ...fetchOptions,
      signal: options.signal || controller.signal,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('로컬 Praetorium 응답 시간이 초과됐습니다.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function selectedDirector() {
  return state.summary?.directors?.find(director => director.id === state.selectedId) || null;
}

function selectedRuns() {
  const director = selectedDirector();
  return (state.summary?.recentRuns || []).filter(run => director?.kind === 'project'
    ? run.projectId === director.projectId
    : run.directorId === state.selectedId);
}

function goalMatchesDirector(goal, director = selectedDirector()) {
  if (!goal || !director) return false;
  return goal.directorId === director.id
    || (director.kind === 'project' && Boolean(goal.projectId) && goal.projectId === director.projectId);
}

function goalTime(goal) {
  return timeMs(goal?.updatedAt || goal?.completedAt || goal?.createdAt);
}

function selectedGoals() {
  const all = [...(state.summary?.goals || [])];
  for (const goal of state.summary?.activeGoals || []) {
    if (typeof goal === 'object' && goal?.id && !all.some(candidate => candidate.id === goal.id)) all.push(goal);
  }
  for (const goal of state.summary?.queuedGoals || []) {
    if (typeof goal === 'object' && goal?.id && !all.some(candidate => candidate.id === goal.id)) all.push(goal);
  }
  return all.filter(goal => goalMatchesDirector(goal)).sort((left, right) => goalTime(right) - goalTime(left));
}

function queuedGoalsForDirector(director = selectedDirector()) {
  return (state.summary?.queuedGoals || []).filter(goal => typeof goal === 'object' && goalMatchesDirector(goal, director));
}

function activeGoalIds() {
  return new Set((state.summary?.activeGoals || []).map(goal => typeof goal === 'string' ? goal : goal?.id).filter(Boolean));
}

function activeGoalForDirector(director) {
  if (!director) return null;
  const active = state.summary?.activeGoals || [];
  const expanded = active.map(item => typeof item === 'string'
    ? (state.summary?.goals || []).find(goal => goal.id === item)
    : item).filter(Boolean);
  return expanded.find(goal => goalMatchesDirector(goal, director))
    || [...(state.summary?.queuedGoals || []), ...(state.summary?.goals || [])].find(goal => typeof goal === 'object' && goalMatchesDirector(goal, director) && !goalIsTerminal(goal))
    || null;
}

function goalIsTerminal(goal) {
  return ['completed', 'blocked', 'failed', 'cancelled'].includes(goal?.status);
}

function goalIsActive(goal) {
  if (!goal) return false;
  const ids = activeGoalIds();
  return ids.size ? ids.has(goal.id) : !goalIsTerminal(goal) && !['blocked', 'queued'].includes(goal.status);
}

function selectedGoalSummary() {
  const goals = selectedGoals();
  return activeGoalForDirector(selectedDirector()) || goals.find(goal => goalIsActive(goal)) || goals[0] || null;
}

function selectedGoal() {
  const summaryGoal = selectedGoalSummary();
  if (!summaryGoal || state.goalDetailId !== summaryGoal.id || !state.goalDetail) return summaryGoal;
  return { ...state.goalDetail, ...summaryGoal, runs: state.goalDetail.runs || summaryGoal.runs || [] };
}

function selectedGoalDetailError(goal = selectedGoalSummary()) {
  return goal?.id && state.goalDetailErrorId === goal.id ? state.goalDetailError : null;
}

function goalRuns(goal = selectedGoal()) {
  if (!goal) return [];
  if (Array.isArray(goal.runs)) return [...goal.runs].sort((left, right) => timeMs(right.createdAt || right.startedAt) - timeMs(left.createdAt || left.startedAt));
  return selectedRuns().filter(run => run.goalId === goal.id);
}

function goalLatestRun(goal = selectedGoal()) {
  return goalRuns(goal)[0] || null;
}

function latestRun() {
  return goalLatestRun() || selectedRuns()[0] || null;
}

function workflowFor(id) {
  return (state.summary?.workflows || []).find(workflow => workflow.id === id) || null;
}

function actionForTask(taskId) {
  const primary = goalRuns();
  const runs = [...primary, ...selectedRuns().filter(run => !primary.includes(run))];
  for (const run of runs) {
    const action = (run.actions || []).find(item => item.taskId === taskId);
    if (action) return action;
  }
  return null;
}

function taskForAction(action) {
  return state.board.find(task => task.id === action.taskId) || null;
}

function goalStatusLabel(status) {
  return ({
    queued: '실행 대기열',
    clarifying: '명세 확인 중', planning: '계획 수립 중', executing: 'Worker 실행 중', evaluating: '결과 평가 중',
    remediating: '재작업 중', verifying: '완료 검증 중', awaiting_owner: 'Owner 판단 대기', completed: '목표 완료',
    blocked: '진행 중단', failed: '목표 실패', cancelled: '취소됨',
  })[status] || phaseLabel(status);
}

function goalStatusTone(status) {
  if (status === 'completed') return 'done';
  if (['failed', 'cancelled'].includes(status)) return 'failed';
  if (['blocked', 'awaiting_owner'].includes(status)) return 'blocked';
  return ['clarifying', 'planning', 'executing', 'evaluating', 'remediating', 'verifying'].includes(status) ? 'running' : 'queued';
}

function currentWave(goal = selectedGoal()) {
  const waves = goal?.waves || [];
  const currentIds = new Set(goal?.currentWaveTaskIds || []);
  return waves.find(wave => currentIds.size && (wave.taskIds || []).some(id => currentIds.has(id)))
    || [...waves].reverse().find(wave => !['completed', 'failed', 'blocked'].includes(wave.status))
    || waves.at(-1)
    || null;
}

function goalTaskIds(goal = selectedGoal()) {
  const ids = new Set(goal?.taskIds || []);
  for (const wave of goal?.waves || []) for (const id of wave.taskIds || []) ids.add(id);
  for (const run of goalRuns(goal)) for (const id of run.taskIds || []) ids.add(id);
  return [...ids];
}

function goalTaskRecord(taskId, goal = selectedGoal()) {
  return goal?.taskRecords?.find(record => record.taskId === taskId) || null;
}

function goalActions(goal = selectedGoal()) {
  const seen = new Set();
  const actions = [];
  for (const run of [...goalRuns(goal)].reverse()) {
    for (const action of run.actions || []) {
      if (!action?.taskId || seen.has(action.taskId)) continue;
      seen.add(action.taskId);
      actions.push(action);
    }
  }
  for (const record of goal?.taskRecords || []) {
    if (!record?.taskId || seen.has(record.taskId)) continue;
    seen.add(record.taskId);
    actions.push({
      taskId: record.taskId,
      title: record.title || record.taskId,
      target: record.profile || 'worker',
      task: normaliseTextList(record.acceptance)[0] || '영속 Goal에 보존된 Worker 작업입니다.',
      acceptance: record.acceptance || [],
      parentTaskIds: record.parentTaskIds || [],
      skills: record.skills || [],
      status: record.status,
    });
  }
  return actions;
}

function goalAnalysis(goal, run = goalLatestRun(goal)) {
  return goal?.analysis || run?.analysis || null;
}

function goalCriteria(goal, run = goalLatestRun(goal)) {
  return goal?.successCriteria || goalAnalysis(goal, run)?.successCriteria || [];
}

function normaliseTextList(value) {
  if (!value) return [];
  const text = item => typeof item === 'string' ? item
    : item?.decision || item?.message || item?.summary || item?.answer || item?.label || item?.text || item?.title || JSON.stringify(item);
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  return [text(value)].filter(Boolean);
}

function sectionFromBody(body, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(body || '').match(new RegExp(`\\[${escaped}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\n\\[[A-Z ]+\\]|$)`));
  return match?.[1]?.trim() || '';
}

function listHtml(values, empty = '없음') {
  if (!values?.length) return `<p class="detail-empty">${escapeHtml(empty)}</p>`;
  return `<ul>${values.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>`;
}

function detailGroup(title, content, className = '') {
  return `<section class="detail-group ${className}"><h4>${escapeHtml(title)}</h4>${content}</section>`;
}

function syncFocusDialog() {
  const dialog = $('focus-dialog');
  if (!dialog.open) return;
  const content = $('focus-dialog-content');
  const previousTop = content.scrollTop;
  const rawLogOpen = content.querySelector('.raw-worker-log')?.open;
  const rawLogFocused = document.activeElement?.closest('#focus-dialog-content')?.hasAttribute('data-raw-worker-log-summary');
  const copy = $('owner-inspector').cloneNode(true);
  copy.querySelectorAll('.worker-control, .owner-decision-form').forEach(element => element.remove());
  copy.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
  content.replaceChildren(...copy.childNodes);
  content.querySelectorAll('[data-goal-task]').forEach(button => button.addEventListener('click', () => {
    $('focus-dialog').close();
    void selectTask(button.dataset.goalTask);
  }));
  content.querySelectorAll('[data-select-trace]').forEach(button => button.addEventListener('click', () => {
    $('focus-dialog').close();
    selectTrace(button.dataset.selectTrace, button.dataset.traceId || null);
  }));
  if (rawLogOpen != null && content.querySelector('.raw-worker-log')) content.querySelector('.raw-worker-log').open = rawLogOpen;
  content.scrollTop = previousTop;
  if (rawLogFocused) requestAnimationFrame(() => content.querySelector('[data-raw-worker-log-summary]')?.focus({ preventScroll: true }));
}

function openFocus(title) {
  $('focus-dialog-title').textContent = title;
  $('focus-dialog').showModal();
  syncFocusDialog();
}

function renderTopbar() {
  const director = selectedDirector();
  const sessions = state.summary?.sessions || { total: 0 };
  $('active-project-name').textContent = director?.kind === 'skill' ? '스킬 운영' : (director?.name || '프로젝트').replace(/ Director$/, '');
  $('active-project-path').textContent = director?.cwd || '프로젝트 미배정';
  const runtimeBadge = $('mission-runtime-badge');
  runtimeBadge.textContent = runtimeLabel(director).toUpperCase();
  runtimeBadge.className = `runtime-badge ${director?.runtime === 'wsl' ? 'wsl' : 'windows'}`;
  const sessionSignal = $('session-count');
  sessionSignal.className = `signal ${sessions.total ? 'active' : 'idle'}`;
  const sessionLabel = sessions.total
    ? `${sessions.total} 실행 중 · Director ${sessions.directors || 0} · Worker ${sessions.workers || 0}`
    : '실행 대기';
  if (sessionSignal.lastElementChild.textContent !== sessionLabel) sessionSignal.lastElementChild.textContent = sessionLabel;
  const accessibleSessionLabel = sessions.total ? sessionLabel : '실행 중인 세션 없음';
  if (sessionSignal.getAttribute('aria-label') !== accessibleSessionLabel) sessionSignal.setAttribute('aria-label', accessibleSessionLabel);
  $('director-count').textContent = state.summary?.directors?.length || 0;
}

function renderSyncBanner() {
  const root = $('sync-banner');
  if (!root) return;
  const recovery = state.summary?.stateRecovery;
  const error = state.consoleError || state.boardStatus?.error;
  const lastSynced = state.lastSyncedAt ? clockLabel(state.lastSyncedAt) : '아직 없음';
  root.hidden = false;
  if (error) {
    root.className = 'sync-banner stale';
    root.setAttribute('role', 'alert');
    root.innerHTML = `<i></i><div><strong>최신 상태 확인 실패 · 기존 trace 보존 중</strong><p>${escapeHtml(friendlyErrorMessage(error))} 상태 변경 버튼은 안전을 위해 잠겼습니다.</p></div><span>LAST SYNC ${escapeHtml(lastSynced)}</span><button type="button" class="secondary-button" data-retry-board>다시 동기화</button>`;
    return;
  }
  root.setAttribute('role', 'status');
  if (state.refreshing) {
    root.className = 'sync-banner refreshing';
    root.innerHTML = `<i></i><div><strong>Stale-while-revalidate</strong><p>기존 실행 흐름을 유지한 채 최신 Director·Worker 상태를 확인하고 있습니다.</p></div><span>LAST SYNC ${escapeHtml(lastSynced)}</span>`;
    return;
  }
  if (recovery) {
    const failures = Array.isArray(recovery.failures) ? recovery.failures.length : 0;
    root.className = 'sync-banner recovered';
    root.innerHTML = `<i></i><div><strong>State recovery · 백업 상태에서 복구됨</strong><p>주 상태 파일 검증에 실패해 checksum이 유효한 백업에서 Goal 감독 상태를 복원했습니다${failures ? ` · 감지 ${failures}건` : ''}.</p></div><span>RECOVERED ${escapeHtml(clockLabel(recovery.at))} · LAST SYNC ${escapeHtml(lastSynced)}</span>`;
    return;
  }
  root.className = 'sync-banner healthy';
  root.innerHTML = `<i></i><div><strong>상태 동기화됨</strong></div><span>LAST SYNC ${escapeHtml(lastSynced)}</span>`;
}

function renderDirectors() {
  const directors = state.summary?.directors || [];
  const groups = [
    ['프로젝트 운영', directors.filter(director => director.kind === 'project')],
    ['공용 운영', directors.filter(director => director.kind === 'skill')],
  ];
  $('owner-director-list').innerHTML = groups.filter(([, items]) => items.length).map(([label, items]) => `<section class="director-group"><h2>${label}</h2>${items.map(director => {
    const index = director.kind === 'skill' ? 'S' : director.id.split('-').at(-1);
    const goal = activeGoalForDirector(director);
    const queued = queuedGoalsForDirector(director);
    const operationalStatus = goal?.status || director.status;
    const subtitle = goal ? `${goalStatusLabel(goal.status)}${goal.status === 'queued' ? ` · 대기 ${goal.queuePosition || 1}번째` : ` · Cycle ${goal.cycleCount || 0}`}${goal.status !== 'queued' && queued.length ? ` · 다음 ${queued.length}개` : ''}` : director.kind === 'skill' ? '스킬·운영 플로우 관리' : (director.projectId ? `${runtimeLabel(director)} · ${statusLabel(director.status)}` : '프로젝트 연결 필요');
    const accessibleName = `${director.name}, ${subtitle}, ${goal ? goalStatusLabel(goal.status) : statusLabel(director.status)}`;
    return `<button class="director-row ${director.id === state.selectedId ? 'active' : ''}" data-director="${escapeHtml(director.id)}" type="button" aria-label="${escapeHtml(accessibleName)}" data-tooltip="${escapeHtml(accessibleName)}">
      <span class="director-index">${escapeHtml(index)}</span>
      <span class="director-copy"><strong>${escapeHtml(director.name)}</strong><small>${escapeHtml(subtitle)}</small></span>
      <i class="status-dot ${traceStatus(operationalStatus)}" title="${escapeHtml(goal ? goalStatusLabel(goal.status) : statusLabel(director.status))}"></i>
    </button>`;
  }).join('')}</section>`).join('');
  document.querySelectorAll('[data-director]').forEach(button => {
    if (button.dataset.director === state.selectedId) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => selectDirector(button.dataset.director));
  });
}

function renderMissionHeader() {
  const director = selectedDirector();
  const goal = selectedGoal();
  const run = latestRun();
  const workflow = workflowFor(goal?.workflowId || run?.workflowId);
  const queuedGoals = queuedGoalsForDirector(director);
  const taskIds = new Set(goal ? goalTaskIds(goal) : run?.taskIds || []);
  const relevantTasks = goal ? state.board.filter(task => taskIds.has(task.id)) : taskIds.size ? state.board.filter(task => taskIds.has(task.id)) : state.board;
  const activeTasks = relevantTasks.filter(task => task.status === 'running').length;
  const readyTasks = relevantTasks.filter(task => ['ready', 'todo'].includes(task.status)).length;
  $('mission-board-name').textContent = director?.board || 'BOARD';
  $('mission-run-time').textContent = goal
    ? (goalIsActive(goal) ? `목표 ${elapsedLabel(goal.createdAt)}` : clockLabel(goal.completedAt || goal.updatedAt || goal.createdAt))
    : run ? (run.status === 'running' ? `판단 ${elapsedLabel(run.startedAt)}` : clockLabel(run.completedAt || run.createdAt)) : '대기';
  $('mission-title').textContent = goal?.objective || run?.prompt || (director?.cwd ? '새 목표를 기다리고 있습니다' : '첫 프로젝트를 연결하세요');
  $('mission-subtitle').textContent = goal
    ? goal.status === 'queued'
      ? `Director 실행 대기열 ${goal.queuePosition || 1}번째 · 앞선 Goal이 끝나면 자동 시작 · Worker는 아직 생성되지 않음`
      : `${goalStatusLabel(goal.status)} · ${workflow?.name || goal.workflowId || '플로우 선택 중'} · ${goalTaskIds(goal).length}개 Worker 작업 · ${activeTasks}개 실행 중${queuedGoals.length ? ` · 다음 Goal ${queuedGoals.length}개 대기` : ''}`
    : run
      ? `${phaseLabel(run.phase)} · Director 판단 턴 ${run.status === 'completed' ? '완료' : statusLabel(run.status)} · ${run.taskIds?.length || 0}개 작업`
    : director?.cwd
      ? '기능, 버그, API 명세나 완료 기준을 보내면 Director가 실행과 검증 흐름을 만듭니다.'
      : '운영 환경에서 로컬 프로젝트를 연결한 뒤 목표를 보내면 실행 흐름이 시작됩니다.';
  const goalOccupiesDirector = goal && goalIsActive(goal);
  const messageMode = $('owner-message-mode').value;
  const conversationBlocked = messageMode === 'conversation' && director?.status === 'running';
  const unavailable = controlPlaneUnavailable();
  const canMessage = !unavailable && Boolean(director?.cwd) && !conversationBlocked && !state.busyActions.has('send-message');
  $('owner-message-input').disabled = !canMessage;
  $('owner-message-input').placeholder = director?.cwd
    ? unavailable ? '최신 상태를 다시 확인한 뒤 요청을 보낼 수 있습니다.'
      : conversationBlocked ? '현재 Director 판단 턴이 끝나면 질문을 보낼 수 있습니다.'
        : messageMode !== 'conversation' && (goalOccupiesDirector || director.status === 'running') ? '새 목표를 입력하세요. 현재 Goal 뒤 Director 대기열에 안전하게 추가됩니다…'
          : goal?.status === 'awaiting_owner' ? '결정은 위 카드에서 답하고, 별도 질문은 여기서 보낼 수 있습니다.'
            : goalOccupiesDirector ? '현재 Goal의 상태·근거를 Director에게 질문하세요…'
              : '목표, 제약, 완료 기준을 입력하세요…'
    : '먼저 프로젝트를 배정하세요.';
  $('owner-send-btn').disabled = !canMessage;
  $('owner-send-btn').textContent = state.busyActions.has('send-message') ? '전송 중…' : '보내기';
  const dispatch = $('owner-dispatch-btn');
  dispatch.textContent = state.busyActions.has('dispatch') ? 'Worker 시작 중…' : readyTasks ? `대기 Worker ${readyTasks}개 실행` : '대기 Worker 없음';
  dispatch.disabled = unavailable || !director?.cwd || director.kind !== 'project' || !readyTasks || state.busyActions.has('dispatch');
  dispatch.title = unavailable ? '최신 상태를 확인할 때까지 상태 변경이 잠겼습니다.' : !director?.cwd ? '프로젝트를 먼저 연결하세요.' : !readyTasks ? '지금 수동으로 시작할 대기 작업이 없습니다.' : `${director.name}의 대기 작업 ${readyTasks}개를 지금 실행합니다.`;
}

function renderGoalProgress() {
  const root = $('goal-progress');
  if (!root) return;
  const goal = selectedGoal();
  if (!goal) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  const wave = currentWave(goal);
  const run = goalLatestRun(goal);
  const cycle = Number(goal.cycleCount || 0);
  const cycleLimit = Number(goal.maxCycles || 0);
  const remediation = Number(goal.remediationCount || 0);
  const remediationLimit = Number(goal.maxRemediationLoops || 0);
  const turnCopy = run
    ? goal.status === 'queued' ? `Director 실행 대기열 ${goal.queuePosition || run.queuePosition || 1}번째 · 판단 턴 미시작` : run.status === 'running' ? `Director 판단 턴 실행 중 · ${phaseLabel(run.phase)}` : `최근 Director 판단 턴 ${statusLabel(run.status)} · 목표는 ${goalStatusLabel(goal.status)}`
    : 'Director 판단 기록을 기다리는 중';
  root.hidden = false;
  root.className = `goal-progress ${goalStatusTone(goal.status)}`;
  root.innerHTML = `<button type="button" class="goal-progress-main" data-select-trace="goal" aria-label="목표 감독 상세 열기">
      <span class="goal-state"><i></i><b>${escapeHtml(goalStatusLabel(goal.status))}</b></span>
      <span class="goal-turn">${escapeHtml(turnCopy)}</span>
    </button>
    <dl aria-label="목표 진행 한도">
      <div><dt>WAVE</dt><dd>${escapeHtml(wave ? `${wave.index ?? (goal.waves || []).indexOf(wave) + 1} / ${(goal.waves || []).length}` : `0 / ${(goal.waves || []).length}`)}</dd></div>
      <div><dt>CYCLE</dt><dd>${escapeHtml(cycleLimit ? `${cycle} / ${cycleLimit}` : String(cycle))}</dd></div>
      <div><dt>REWORK</dt><dd>${escapeHtml(remediationLimit ? `${remediation} / ${remediationLimit}` : String(remediation))}</dd></div>
    </dl>`;
  root.querySelector('[data-select-trace]')?.addEventListener('click', event => selectTrace(event.currentTarget.dataset.selectTrace));
}

function currentOperationalTask() {
  const goal = selectedGoal();
  const currentIds = new Set(goal?.currentWaveTaskIds?.length ? goal.currentWaveTaskIds : goal ? goalTaskIds(goal) : latestRun()?.taskIds || []);
  const tasks = goal ? state.board.filter(task => currentIds.has(task.id)) : currentIds.size ? state.board.filter(task => currentIds.has(task.id)) : state.board;
  return tasks.find(task => task.status === 'running')
    || tasks.find(task => task.status === 'failed')
    || tasks.find(task => ['blocked', 'review', 'scheduled'].includes(task.status))
    || tasks.find(task => ['ready', 'todo'].includes(task.status))
    || null;
}

function renderCurrentFocus() {
  const director = selectedDirector();
  const goal = selectedGoal();
  const run = latestRun();
  const task = currentOperationalTask();
  let status = 'queued';
  let kicker = '목표 대기';
  let title = 'Owner의 다음 목표를 기다리는 중';
  let description = '목표를 보내면 Director가 작업 플로우와 Worker 구성을 먼저 공개합니다.';
  let meta = '개입 없음';
  let action = '';
  if (state.consoleError) {
    status = 'failed';
    kicker = 'CONNECTION';
    title = '로컬 Praetorium 연결이 끊겼습니다';
    description = state.consoleError;
    meta = '새로고침으로 재시도';
    action = '<button type="button" class="secondary-button" data-retry-board>다시 연결</button>';
  } else if (director?.kind === 'project' && !director.cwd) {
    status = 'queued';
    kicker = '시작 준비';
    title = '첫 프로젝트를 Director에 연결하세요';
    description = 'Windows 또는 WSL의 로컬 경로를 연결하면 목표 입력과 Worker 실행이 열립니다.';
    meta = '1 / 3 단계';
    action = '<button type="button" class="primary-button" data-open-projects>프로젝트 연결</button>';
  } else if (goal?.status === 'awaiting_owner' || goal?.ownerDecision?.required) {
    status = 'blocked';
    kicker = 'OWNER DECISION';
    title = goal.ownerDecision?.question || 'Director가 중요한 결정을 기다리고 있습니다';
    description = goal.ownerDecision?.evidence || '선택에 따라 구현 범위나 외부 영향이 달라져 Owner 확인 전까지 목표를 안전하게 멈췄습니다.';
    meta = `Cycle ${goal.cycleCount || 0}${goal.maxCycles ? ` / ${goal.maxCycles}` : ''}`;
    action = '<button type="button" class="primary-button" data-select-trace="owner-decision">판단하기</button>';
  } else if (goal?.status === 'queued') {
    status = 'queued';
    kicker = 'GOAL QUEUED';
    title = `Director 실행 대기열 ${goal.queuePosition || 1}번째`;
    description = '앞선 Goal이 종료되면 이 목표의 분석 턴이 자동 시작됩니다. 아직 Worker나 실행 증거는 생성되지 않았습니다.';
    meta = `queue ${goal.queuePosition || 1} · ${clockLabel(goal.createdAt)}`;
  } else if (task) {
    const taskAction = actionForTask(task.id);
    status = traceStatus(task.status);
    kicker = statusLabel(task.status).toUpperCase();
    title = task.status === 'running'
      ? `${task.assignee || 'Worker'}가 “${task.title}” 수행 중`
      : task.status === 'failed' ? `“${task.title}” 실패 확인 필요`
      : task.status === 'blocked' || task.status === 'scheduled'
        ? `“${task.title}”에 Owner 판단이 필요함`
        : task.status === 'review' ? `“${task.title}” 리뷰 결과 확인 중`
          : task.status === 'todo' ? `“${task.title}” 선행 작업 완료 대기` : `“${task.title}” 실행 대기`;
    description = taskAction?.task || sectionFromBody(task.body, 'ACTION') || task.result || '작업 세부 정보를 열어 실행 근거를 확인하세요.';
    meta = `${task.assignee || '미배정'}${task.started_at ? ` · ${elapsedLabel(task.started_at, task.completed_at || Date.now())}` : ''}`;
  } else if (goal && goalIsActive(goal)) {
    status = 'running';
    kicker = goalStatusLabel(goal.status).toUpperCase();
    title = run?.status === 'running'
      ? run.progressEvents?.at(-1)?.message || `Director가 ${goalStatusLabel(goal.status)}`
      : goal.events?.at(-1)?.message || `Director가 다음 ${goalStatusLabel(goal.status)} 단계를 감독하는 중`;
    description = run?.status === 'completed'
      ? 'Director의 최근 판단 턴은 끝났지만 Goal은 계속 살아 있습니다. Worker 결과가 모이면 새 판단 턴으로 평가·재작업·검증을 이어갑니다.'
      : goalAnalysis(goal, run)?.requestSummary || '공개 근거를 바탕으로 다음 Worker 배치 또는 완료 판정을 준비합니다.';
    meta = run?.status === 'running' ? `Director turn · ${elapsedLabel(run.startedAt)}` : `Goal · ${elapsedLabel(goal.createdAt)}`;
  } else if (goal?.status === 'completed') {
    status = 'done';
    kicker = 'GOAL COMPLETE';
    title = '완료 기준과 품질 게이트를 통과했습니다';
    description = typeof goal.finalReport === 'string' ? goal.finalReport : goal.finalReport?.summary || 'Director가 전체 목표의 완료를 판정했습니다. 상세 보고와 근거를 열어 확인하세요.';
    meta = clockLabel(goal.completedAt || goal.updatedAt);
    action = '<button type="button" class="secondary-button" data-select-trace="final">완료 보고 보기</button>';
  } else if (goal && ['failed', 'blocked', 'cancelled'].includes(goal.status)) {
    status = goal.status === 'blocked' ? 'blocked' : 'failed';
    kicker = goalStatusLabel(goal.status).toUpperCase();
    title = goal.error || '목표를 더 진행할 수 없습니다';
    description = typeof goal.finalReport === 'string' ? goal.finalReport : goal.finalReport?.summary || 'Inspector에서 중단 근거와 마지막 증거를 확인하세요.';
    meta = clockLabel(goal.updatedAt || goal.completedAt);
    action = '<button type="button" class="secondary-button" data-select-trace="final">중단 근거 보기</button>';
  } else if (run?.status === 'running') {
    status = 'running';
    kicker = phaseLabel(run.phase).toUpperCase();
    title = run.progressEvents?.at(-1)?.message || 'Director가 목표를 분석하는 중';
    description = run.analysis?.requestSummary || '요구, 위험, 플로우 후보와 Worker 분할을 판단하고 있습니다.';
    meta = `Director 판단 턴 · ${elapsedLabel(run.startedAt)}`;
  } else if (run?.taskIds?.length && run.taskIds.every(id => ['done', 'archived'].includes(state.board.find(taskItem => taskItem.id === id)?.status))) {
    status = 'done';
    kicker = '이번 작업 묶음 완료';
    title = `${run.taskIds.length}개 작업이 완료됨`;
    description = '프로젝트 전체 완료 판정은 아니며, 실행 흐름에서 각 Worker의 결과와 검증 근거를 확인할 수 있습니다.';
    meta = clockLabel(run.completedAt);
  }
  updateHtml($('current-focus'), `<i class="focus-pulse ${status}"></i><div class="focus-copy"><span>${escapeHtml(kicker)}</span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(description)}</small></div><div class="focus-meta"><b>${escapeHtml(meta)}</b>${action}</div>`);
  $('current-focus').querySelector('[data-select-trace]')?.addEventListener('click', event => selectTrace(event.currentTarget.dataset.selectTrace));
  const announcement = `${statusLabel(status)}. ${title}`;
  if ($('status-announcer') && $('status-announcer').textContent !== announcement) $('status-announcer').textContent = announcement;
}

function ownerAttentionTasks() {
  const goal = selectedGoal();
  const ids = new Set(goal ? goalTaskIds(goal) : []);
  return state.board.filter(task => (!goal || ids.has(task.id)) && ['failed', 'blocked', 'review', 'scheduled'].includes(task.status));
}

function decisionOptionValue(option) {
  return String(typeof option === 'string' ? option : option?.value || option?.id || option?.label || option?.title || '');
}

function decisionOptionLabel(option) {
  return String(typeof option === 'string' ? option : option?.label || option?.title || option?.value || option?.id || '선택');
}

function decisionOptionDescription(option) {
  return typeof option === 'object' ? option?.description || option?.impact || option?.tradeoff || '' : '';
}

function approvalKindLabel(kind) {
  return ({
    external_action: '외부 변경 실행',
    skill_activation: '스킬 활성화',
    material_decision: '중요 운영 결정',
  })[kind] || kind || '일반 Owner 결정';
}

function effectLabel(effect) {
  return ({
    read_only: '읽기 전용',
    workspace_write: '작업공간 변경',
    external_mutation: '외부 변경',
    skill_activation: '스킬 활성화',
  })[effect] || effect || '영향 미기록';
}

function ownerDecisionContract(goal, { compact = false } = {}) {
  const decision = goal?.ownerDecision || {};
  const pending = goal?.pendingAuthorityPlan || {};
  const actions = decision.plannedActions?.length
    ? decision.plannedActions
    : pending.plan?.actions?.length
      ? pending.plan.actions
      : decision.target || decision.effect || decision.writeScope
        ? [decision]
        : [];
  const approvalKind = decision.approvalKind || pending.approvalKind || null;
  const planDigest = decision.planDigest || pending.planDigest || null;
  const candidateDigest = decision.candidateDigest || pending.candidateDigest || goal?.currentCandidate?.digest || null;
  const throughWave = decision.throughWave ?? pending.throughWave ?? null;
  if (!approvalKind && !planDigest && !candidateDigest && throughWave == null && !actions.length) return '';
  const rows = actions.map((action, index) => {
    const writeScope = normaliseTextList(action.writeScope || action.write_scope);
    return `<article class="approval-action">
      <header><span>ACTION ${index + 1}</span><strong>${escapeHtml(action.title || action.task || action.id || '계획된 실행')}</strong></header>
      <dl><div><dt>EFFECT</dt><dd><b class="effect-badge ${escapeHtml(action.effect || 'unknown')}">${escapeHtml(effectLabel(action.effect))}</b><code>${escapeHtml(action.effect || 'not-recorded')}</code></dd></div><div><dt>TARGET</dt><dd><code>${escapeHtml(action.target || 'not-recorded')}</code></dd></div><div><dt>WRITE SCOPE</dt><dd>${writeScope.length ? `<ul>${writeScope.map(item => `<li><code>${escapeHtml(item)}</code></li>`).join('')}</ul>` : '<span class="scope-empty">변경 범위 미기록</span>'}</dd></div></dl>
      ${!compact && action.task ? `<p>${escapeHtml(action.task)}</p>` : ''}
    </article>`;
  }).join('');
  return `<section class="decision-contract ${compact ? 'compact' : ''}" aria-label="승인 실행 계약">
    <header><div><span>APPROVAL CONTRACT</span><strong>이 답변으로 허용되는 정확한 실행 범위</strong></div><b>${escapeHtml(approvalKindLabel(approvalKind))}</b></header>
    <dl class="approval-identifiers">
      <div><dt>APPROVAL KIND</dt><dd><code>${escapeHtml(approvalKind || 'material_decision')}</code></dd></div>
      <div><dt>THROUGH WAVE</dt><dd><code>${escapeHtml(throughWave == null ? 'not-bounded' : String(throughWave))}</code></dd></div>
      <div><dt>PLAN DIGEST</dt><dd><code>${escapeHtml(planDigest || 'not-recorded')}</code></dd></div>
      <div><dt>CANDIDATE DIGEST</dt><dd><code>${escapeHtml(candidateDigest || 'not-applicable')}</code></dd></div>
    </dl>
    ${rows ? `<div class="approval-actions">${rows}</div>` : '<p class="scope-empty">별도 실행 action이 없는 판단 요청입니다.</p>'}
  </section>`;
}

function ownerDecisionForm(goal, { compact = false } = {}) {
  const decision = goal?.ownerDecision || {};
  const options = decision.options || [];
  const busy = state.busyActions.has(`decision:${goal.id}`);
  const unavailable = controlPlaneUnavailable();
  const error = state.decisionGoalId === goal.id ? state.decisionError : null;
  return `<form class="owner-decision-form ${compact ? 'compact' : ''}" data-owner-decision-form data-goal-id="${escapeHtml(goal.id)}">
    ${options.length ? `<fieldset><legend>선택지</legend><div class="decision-options">${options.map(option => {
      const value = decisionOptionValue(option);
      const selected = state.decisionGoalId === goal.id && state.decisionOption === value;
      return `<button type="button" class="decision-option ${selected ? 'selected' : ''}" data-owner-decision-option="${escapeHtml(value)}" aria-pressed="${selected}" ${busy || unavailable ? 'disabled' : ''}><b>${escapeHtml(decisionOptionLabel(option))}</b>${decisionOptionDescription(option) ? `<small>${escapeHtml(decisionOptionDescription(option))}</small>` : ''}</button>`;
    }).join('')}</div></fieldset>` : ''}
    <label><span>${options.length ? '선택 이유 또는 추가 지시' : 'Owner 답변'}</span><textarea rows="${compact ? 2 : 3}" data-owner-decision-input placeholder="결정과 필요한 제약을 구체적으로 남기세요." ${busy || unavailable ? 'disabled' : ''}>${escapeHtml(state.decisionGoalId === goal.id ? state.decisionDraft : '')}</textarea></label>
    ${error ? `<p class="decision-error" role="alert">${escapeHtml(friendlyErrorMessage(error))}</p>` : ''}
    <div class="decision-submit"><small>${unavailable ? '최신 상태를 확인할 때까지 중복·오판 승인을 막기 위해 제출이 잠겼습니다.' : '답변을 보내면 Director가 새 판단 턴을 열어 목표를 계속 감독합니다.'}</small><button type="submit" data-owner-decision-submit ${busy || unavailable ? 'disabled' : ''}>${busy ? '전달 중…' : unavailable ? '동기화 필요' : '결정 전달'}</button></div>
  </form>`;
}

function renderOwnerGate() {
  const goal = selectedGoal();
  const tasks = ownerAttentionTasks();
  const gate = $('owner-gate');
  const decisionRequired = Boolean(goal && (goal.status === 'awaiting_owner' || goal.ownerDecision?.required));
  if (decisionRequired) {
    gate.hidden = false;
    gate.className = 'owner-gate decision-gate';
    if (!state.decisionComposing || state.decisionGoalId !== goal.id) {
      if (state.decisionGoalId !== goal.id) {
        state.decisionGoalId = goal.id;
        state.decisionDraft = '';
        state.decisionOption = '';
        state.decisionError = null;
      }
      gate.innerHTML = `<header><div><span>OWNER DECISION · 목표 일시정지</span><strong>${escapeHtml(goal.ownerDecision?.question || 'Director가 중요한 판단을 기다리고 있습니다')}</strong></div><button type="button" class="quiet-button" data-select-trace="owner-decision">근거 크게 보기</button></header>
        ${goal.ownerDecision?.evidence ? `<p class="decision-evidence">${formatText(normaliseTextList(goal.ownerDecision.evidence).join('\n'))}</p>` : ''}
        ${ownerDecisionContract(goal, { compact: true })}
        ${ownerDecisionForm(goal, { compact: true })}`;
      bindDecisionActions(gate);
      gate.querySelector('[data-select-trace]')?.addEventListener('click', event => selectTrace(event.currentTarget.dataset.selectTrace));
    }
  } else if (tasks.length) {
    gate.hidden = false;
    gate.className = 'owner-gate';
    gate.innerHTML = `<div><span>OWNER 확인</span><strong>${escapeHtml(tasks.length === 1 ? tasks[0].title : `${tasks.length}개 작업에 판단이 필요합니다`)}</strong></div><button type="button" id="owner-gate-open">확인</button>`;
    $('owner-gate-open').onclick = () => selectTask(tasks[0].id);
  } else {
    gate.hidden = true;
    gate.innerHTML = '';
  }
  $('attention-section').hidden = !tasks.length;
  if (!tasks.length) return;
  $('owner-attention-list').innerHTML = tasks.map(task => `<button type="button" class="attention-row" data-attention-task="${escapeHtml(task.id)}"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(statusLabel(task.status))} · ${escapeHtml(task.assignee || '미배정')}</span></button>`).join('');
  document.querySelectorAll('[data-attention-task]').forEach(button => button.addEventListener('click', () => selectTask(button.dataset.attentionTask)));
}

function bindDecisionActions(root) {
  root.querySelectorAll('[data-owner-decision-form]').forEach(form => {
    const goalId = form.dataset.goalId;
    const input = form.querySelector('[data-owner-decision-input]');
    input?.addEventListener('input', event => {
      state.decisionGoalId = goalId;
      state.decisionDraft = event.currentTarget.value;
      state.decisionError = null;
    });
    input?.addEventListener('compositionstart', () => { state.decisionComposing = true; });
    input?.addEventListener('compositionend', event => {
      state.decisionComposing = false;
      state.decisionGoalId = goalId;
      state.decisionDraft = event.currentTarget.value;
    });
    form.querySelectorAll('[data-owner-decision-option]').forEach(button => button.addEventListener('click', () => {
      state.decisionGoalId = goalId;
      state.decisionOption = button.dataset.ownerDecisionOption;
      state.decisionError = null;
      renderOwnerGate();
      if (state.selection.type === 'owner-decision') renderInspector({ force: true });
    }));
    form.addEventListener('submit', event => {
      event.preventDefault();
      void sendOwnerDecision(goalId, form);
    });
  });
}

async function sendOwnerDecision(goalId, form) {
  const selectedOption = state.decisionGoalId === goalId ? state.decisionOption.trim() : '';
  const typed = form.querySelector('[data-owner-decision-input]')?.value.trim() || '';
  const answer = typed || selectedOption;
  if (!answer) {
    state.decisionGoalId = goalId;
    state.decisionError = '선택지를 고르거나 답변을 입력하세요.';
    renderOwnerGate();
    if (state.selection.type === 'owner-decision') renderInspector({ force: true });
    return;
  }
  const key = `decision:${goalId}`;
  if (state.busyActions.has(key)) return;
  state.busyActions.add(key);
  state.decisionError = null;
  renderOwnerGate();
  if (state.selection.type === 'owner-decision') renderInspector({ force: true });
  try {
    await api(`/api/directors/${encodeURIComponent(state.selectedId)}/goals/${encodeURIComponent(goalId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ answer, ...(selectedOption ? { selectedOption } : {}) }),
      timeoutMs: 30000,
    });
    state.decisionDraft = '';
    state.decisionOption = '';
    state.decisionGoalId = null;
    state.decisionError = null;
    state.selection = { type: 'goal', id: goalId };
    toast('Owner 결정을 전달했습니다. Director가 목표 감독을 재개합니다.', 'success');
    await loadConsole({ quiet: true });
  } catch (error) {
    state.decisionGoalId = goalId;
    state.decisionError = error.message;
    toast(error.message, 'error');
  } finally {
    state.busyActions.delete(key);
    renderOwnerGate();
    renderInspector({ force: true });
  }
}

function traceCategory(key, status, explicit = null) {
  if (explicit) return explicit;
  if (['failed', 'blocked', 'cancelled', 'error'].includes(String(status))) return 'failure';
  if (key === 'task' || key === 'wave') return 'worker';
  if (key === 'assessment' || key === 'final') return 'gate';
  return 'decision';
}

function traceNode({ key, id = null, kind, title, description, status = 'queued', side = '', tags = [], marker = '·', depth = 0, category = null, concealed = false, waveToggle = null }) {
  const selectionId = id ?? (key === 'task' ? marker : null);
  const selected = state.selection.type === key && (selectionId == null || state.selection.id === selectionId);
  const resolvedCategory = traceCategory(key, status, category);
  const filtered = !state.traceFilters.has(resolvedCategory);
  const data = key === 'task'
    ? `data-select-task="${escapeHtml(selectionId)}" data-trace-selection="task:${escapeHtml(selectionId)}"`
    : `data-select-trace="${escapeHtml(key)}" ${selectionId != null ? `data-trace-id="${escapeHtml(selectionId)}"` : ''} data-trace-selection="${escapeHtml(key)}:${escapeHtml(selectionId || '')}"`;
  const accessibleName = [title, kind, statusLabel(status), side, description].filter(Boolean).join(', ');
  return `<article class="trace-node ${traceStatus(status)} depth-${Math.min(2, depth)} ${selected ? 'selected' : ''}" data-trace-category="${escapeHtml(resolvedCategory)}" data-filtered="${filtered}" data-concealed="${concealed}" ${concealed || filtered ? 'hidden' : ''}>
    <span class="trace-marker">${escapeHtml(key === 'task' ? 'W' : marker)}</span>
    <div class="trace-body"><button class="trace-button" type="button" ${data} aria-label="${escapeHtml(accessibleName)}" ${selected ? 'aria-current="step"' : ''}>
      <span class="trace-title-row"><strong class="trace-title">${escapeHtml(title)}</strong><small class="trace-kind">${escapeHtml(kind)}</small></span>
      <span class="trace-description">${escapeHtml(description || '세부 정보를 준비하는 중입니다.')}</span>
      ${tags.length ? `<span class="trace-tags">${tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</span>` : ''}
    </button></div>
    <div class="trace-side"><b>${escapeHtml(statusLabel(status))}</b><small>${escapeHtml(side)}</small>${waveToggle ? `<button type="button" class="wave-toggle" data-wave-toggle="${escapeHtml(waveToggle.id)}" aria-expanded="${waveToggle.expanded}" aria-label="${escapeHtml(waveToggle.expanded ? `${title} 접기` : `${title} 펼치기`)}">${waveToggle.expanded ? '접기' : '펼치기'}</button>` : ''}</div>
  </article>`;
}

function goalEventEntries(goal) {
  return (goal?.events || []).map((event, index) => ({
    event,
    id: String(event?.id || `${event?.at || event?.createdAt || 'event'}-${index}`),
    index,
  }));
}

function directorTurnEntries(goal) {
  const entries = [];
  for (const run of goalRuns(goal)) {
    for (const [index, event] of (run.progressEvents || []).entries()) {
      if (!event?.message || event.phase === 'queued') continue;
      entries.push({ run, event, index, id: `${run.id}:${index}` });
    }
  }
  return entries;
}

function directorTurnStatus(run, event, index) {
  if (event.phase === 'failed' || run.status === 'failed' && index === (run.progressEvents || []).length - 1) return 'failed';
  if (run.status === 'running' && index === (run.progressEvents || []).length - 1) return 'running';
  if (['awaiting_owner', 'goal_blocked'].includes(event.phase)) return 'blocked';
  return 'completed';
}

function goalEventPresentation(event) {
  const kind = String(event?.kind || 'update').toLowerCase();
  const phase = String(event?.phase || '').toLowerCase();
  const details = event?.details || {};
  const ownerControlLabels = {
    pause_requested: ['Owner가 Worker 일시정지 요청', 'OWNER CONTROL'],
    paused_by_owner: ['Worker 일시정지 적용', 'OWNER CONTROL'],
    pause_race_terminal: ['일시정지 전에 Worker 종료', 'OWNER CONTROL'],
    resumed_by_owner: ['Owner가 Worker 재개', 'OWNER CONTROL'],
  };
  const labels = {
    created: ['Goal 생성', 'OWNER'], goal_created: ['Goal 생성', 'OWNER'], owner: [event?.phase === 'owner_answered' ? 'Owner 결정 반영' : 'Goal 생성', 'OWNER'], clarified: ['명세 확인', 'DIRECTOR'],
    analysis: ['요구 분석 갱신', 'DIRECTOR'], analyzed: ['요구 분석 확정', 'DIRECTOR'], planned: ['실행 계획 확정', 'DIRECTOR'],
    director: [event?.phase === 'assessing_evidence' ? 'Worker 결과 평가 시작' : 'Director 판단 기록', 'DIRECTOR'],
    wave: [event?.phase === 'materializing' ? 'Worker Wave 생성' : 'Worker Wave 감시 시작', 'DIRECTOR WAVE'],
    task: ['Worker 작업 배정', 'DIRECTOR'], monitor: ['Worker 상태 감시', 'SUPERVISOR'], recovery: ['Goal 감독 복구', 'SUPERVISOR'],
    terminal: [event?.phase === 'completed' ? 'Goal 완료 판정' : 'Goal 중단 판정', 'DIRECTOR'], error: ['감독 오류·재시도', 'SUPERVISOR'],
    wave_started: ['새 Worker wave 시작', 'DIRECTOR'], wave_completed: ['Worker wave 종료', 'SUPERVISOR'],
    evaluating: ['결과 평가 시작', 'SUPERVISOR'], evaluated: ['결과 평가', 'SUPERVISOR'], assessment: ['결과 평가', 'SUPERVISOR'],
    remediation: ['재작업 결정', 'DIRECTOR'], remediating: ['재작업 시작', 'DIRECTOR'],
    verification: ['완료 검증', 'QUALITY GATE'], verifying: ['완료 검증 시작', 'QUALITY GATE'],
    owner_decision_requested: ['Owner 판단 요청', 'OWNER GATE'], awaiting_owner: ['Owner 판단 대기', 'OWNER GATE'],
    owner_decision: ['Owner 결정 반영', 'OWNER'], owner_answered: ['Owner 결정 반영', 'OWNER'],
    completed: ['Goal 완료 판정', 'DIRECTOR'], blocked: ['Goal 중단', 'DIRECTOR'], failed: ['Goal 실패', 'DIRECTOR'],
  };
  const [title, category] = ownerControlLabels[phase] || labels[kind] || [kind.replaceAll('_', ' '), 'GOAL EVENT'];
  const status = event?.status || details.status || (phase === 'pause_requested' ? 'running'
    : ['paused_by_owner', 'pause_race_terminal', 'resumed_by_owner'].includes(phase) ? 'completed'
      : kind === 'owner_decision' && event?.phase === 'awaiting_owner' ? 'awaiting_owner'
    : kind === 'error' || kind.includes('fail') ? 'failed'
      : kind === 'terminal' ? event?.phase || 'completed'
        : kind.includes('block') ? 'blocked'
          : ['assessing_evidence', 'recovering', 'worker_progress', 'retry_scheduled'].includes(event?.phase) ? 'running' : 'completed');
  const traceCategory = kind === 'error' || kind.includes('fail') || ['failed', 'blocked', 'cancelled'].includes(status)
    ? 'failure'
    : ['task', 'wave', 'wave_started', 'wave_completed'].includes(kind) ? 'worker'
      : category.includes('GATE') || ['verification', 'verifying', 'evaluating', 'evaluated', 'assessment'].includes(kind) ? 'gate'
        : 'decision';
  return { title, category, status, traceCategory };
}

function waveLabel(wave, index) {
  const number = Number.isFinite(Number(wave?.index)) ? Number(wave.index) : index + 1;
  const kind = String(wave?.kind || '').toLowerCase();
  if (kind.includes('remedi')) return `Wave ${number} · 재작업`;
  if (kind.includes('review')) return `Wave ${number} · 전문 리뷰`;
  if (kind.includes('verif') || kind.includes('gate')) return `Wave ${number} · 완료 검증`;
  return `Wave ${number} · Worker 실행`;
}

function waveExpansionKey(goal, wave, index) {
  return `${goal?.id || 'legacy'}:${String(wave?.id || index)}`;
}

function waveIsExpanded(goal, wave, index) {
  const key = waveExpansionKey(goal, wave, index);
  return state.waveExpansion.has(key) ? state.waveExpansion.get(key) : currentWave(goal) === wave;
}

function waveActionForTask(goal, wave, taskId) {
  return (wave?.actions || []).find(action => action.taskId === taskId)
    || actionForTask(taskId)
    || goalTaskRecord(taskId, goal)
    || null;
}

function taskDisplayName(goal, taskId) {
  const waveAction = (goal?.waves || []).flatMap(wave => wave.actions || []).find(action => action.taskId === taskId);
  const action = waveAction || actionForTask(taskId);
  const record = goalTaskRecord(taskId, goal);
  const task = state.board.find(candidate => candidate.id === taskId);
  return action?.title || record?.title || task?.title || taskId;
}

function taskDependencyTags(goal, wave, action, taskId) {
  const waveActions = wave?.actions || [];
  const taskByAction = new Map(waveActions.filter(item => item.id && item.taskId).map(item => [item.id, item.taskId]));
  const parentIds = [...new Set([
    ...(action?.parentTaskIds || []),
    ...(action?.dependencies || []).map(id => taskByAction.get(id)).filter(Boolean),
  ])];
  const childIds = waveActions.filter(item => (item.parentTaskIds || []).includes(taskId)
    || (action?.id && (item.dependencies || []).includes(action.id))).map(item => item.taskId).filter(Boolean);
  const tags = [];
  if (parentIds.length) tags.push(`blocked by: ${parentIds.map(id => taskDisplayName(goal, id)).join(', ')}`);
  if (childIds.length) tags.push(`unlocks: ${childIds.map(id => taskDisplayName(goal, id)).join(', ')}`);
  return tags;
}

function renderLegacyTrace(run, root) {
  const nodes = [];
  nodes.push(traceNode({ key: 'objective', marker: '1', kind: 'OWNER', title: '목표 접수', description: run.prompt, status: 'done', side: clockLabel(run.createdAt) }));
  const analysisStatus = run.analysis ? 'done' : run.status === 'running' && ['preparing', 'analyzing', 'retrying'].includes(run.phase) ? 'running' : run.status === 'failed' ? 'failed' : 'queued';
  nodes.push(traceNode({
    key: 'analysis', marker: '2', kind: 'DIRECTOR', title: '요구·위험·대안 분석',
    description: run.analysis?.requestSummary || run.progressEvents?.find(event => event.phase === 'analyzing')?.message,
    status: analysisStatus, side: run.analysis ? workflowFor(run.analysis.recommendedWorkflow)?.name : phaseLabel(run.phase),
    tags: run.analysis ? [`위험 ${run.analysis.risks?.length || 0}`, `불확실성 ${run.analysis.unknowns?.length || 0}`] : [],
  }));
  const planStatus = run.workflowId || run.resolvedMode === 'conversation' && run.status === 'completed' ? 'done' : run.status === 'running' && !['preparing', 'analyzing'].includes(run.phase) ? 'running' : run.status === 'failed' ? 'failed' : 'queued';
  nodes.push(traceNode({
    key: 'plan', marker: '3', kind: 'DIRECTOR', title: run.workflowId ? `${workflowFor(run.workflowId)?.name || run.workflowId} 실행 계획` : 'Worker 구성과 실행 경계 설계',
    description: run.publicDecisions?.[0] || run.progressEvents?.find(event => event.phase === 'directing')?.message,
    status: planStatus, side: `작업 ${run.actions?.length || 0}개`, tags: run.publicDecisions?.slice(0, 2) || [],
  }));
  for (const action of run.actions || []) {
    const task = taskForAction(action);
    const status = task?.status || action.status || 'queued';
    const started = task?.started_at || task?.startedAt;
    const ended = task?.completed_at || task?.completedAt;
    nodes.push(traceNode({
      key: 'task', marker: action.taskId, kind: state.summary?.workerProfiles?.[action.target]?.label || action.target,
      title: action.title, description: action.task, status,
      side: started ? elapsedLabel(started, ended || Date.now()) : action.target,
      tags: [action.taskId, ...(action.skills || []), ...(action.parentTaskIds?.length ? [`선행 ${action.parentTaskIds.length}`] : [])],
      depth: action.parentTaskIds?.length ? 1 : 0,
    }));
  }
  root.innerHTML = nodes.join('');
  const statuses = (run.actions || []).map(action => taskForAction(action)?.status || action.status || 'queued');
  return statuses;
}

function renderGoalTrace(goal, root) {
  const run = goalLatestRun(goal);
  const analysis = goalAnalysis(goal, run);
  const workflow = workflowFor(goal.workflowId || run?.workflowId);
  const nodes = [
    traceNode({ key: 'objective', marker: '1', kind: 'OWNER', title: 'Goal 접수', description: goal.objective, status: 'done', side: clockLabel(goal.createdAt), tags: [goal.id] }),
    traceNode({ key: 'analysis', marker: '2', kind: 'DIRECTOR', title: '명세·성공 조건·위험 분석', description: analysis?.requestSummary || 'Director가 공개 판단 근거를 구성하고 있습니다.', status: analysis ? 'done' : goal.status === 'clarifying' ? 'running' : 'queued', side: `${goalCriteria(goal, run).length}개 성공 조건`, tags: [`제약 ${normaliseTextList(goal.constraints || analysis?.constraints).length}`, `위험 ${analysis?.risks?.length || 0}`] }),
    traceNode({ key: 'plan', marker: '3', kind: 'DIRECTOR', title: workflow ? `${workflow.name} 감독 계획` : '실행·검증 계획', description: normaliseTextList(goal.publicDecisions || run?.publicDecisions)[0] || 'Worker wave와 품질 게이트를 설계합니다.', status: goal.workflowId || run?.workflowId ? 'done' : ['planning', 'clarifying'].includes(goal.status) ? 'running' : 'queued', side: `${(goal.waves || []).length}개 wave`, tags: [goal.workflowId || run?.workflowId].filter(Boolean) }),
  ];
  const timeline = [];
  const seenTasks = new Set();
  for (const [index, wave] of (goal.waves || []).entries()) {
    const waveId = String(wave.id || index);
    const expanded = waveIsExpanded(goal, wave, index);
    timeline.push({
      time: timeMs(wave.startedAt) || timeMs(goal.createdAt) + index + 1,
      order: index * 100,
      html: traceNode({ key: 'wave', id: waveId, marker: `W${Number.isFinite(Number(wave.index)) ? wave.index : index + 1}`, kind: 'DIRECTOR WAVE', title: waveLabel(wave, index), description: `${(wave.taskIds || []).length}개 Worker 작업을 배치·감시합니다. ${expanded ? '작업과 평가가 펼쳐져 있습니다.' : '접힌 wave입니다.'}`, status: wave.status || ((goal.currentWaveTaskIds || []).some(id => (wave.taskIds || []).includes(id)) ? goal.status : 'completed'), side: wave.startedAt ? elapsedLabel(wave.startedAt, wave.completedAt || Date.now()) : '', tags: [wave.kind, wave.id].filter(Boolean), waveToggle: { id: waveExpansionKey(goal, wave, index), expanded } }),
    });
    for (const [taskIndex, taskId] of (wave.taskIds || []).entries()) {
      if (seenTasks.has(taskId)) continue;
      seenTasks.add(taskId);
      const action = waveActionForTask(goal, wave, taskId);
      const task = state.board.find(candidate => candidate.id === taskId);
      const record = goalTaskRecord(taskId, goal);
      const status = task?.status || record?.status || action?.status || (wave.status === 'completed' ? 'done' : 'queued');
      const started = task?.started_at || task?.startedAt;
      const ended = task?.completed_at || task?.completedAt;
      timeline.push({
        time: timeMs(started) || timeMs(wave.startedAt) || timeMs(goal.createdAt) + index + 1,
        order: index * 100 + taskIndex + 1,
        html: traceNode({ key: 'task', marker: taskId, kind: state.summary?.workerProfiles?.[action?.target || record?.profile || task?.assignee]?.label || action?.target || record?.profile || task?.assignee || 'WORKER', title: action?.title || record?.title || task?.title || taskId, description: action?.task || sectionFromBody(task?.body, 'ACTION') || task?.result || normaliseTextList(record?.acceptance)[0] || 'Worker 작업 상세를 열어 공개 실행 근거를 확인하세요.', status, side: started ? elapsedLabel(started, ended || Date.now()) : action?.target || record?.profile || task?.assignee || '', tags: [taskId, ...(action?.skills || []), ...taskDependencyTags(goal, wave, action, taskId)], depth: 1, concealed: !expanded && state.traceFilters.has('worker') }),
      });
    }
    if (wave.assessment) timeline.push({
      time: timeMs(wave.completedAt) || timeMs(wave.startedAt) || timeMs(goal.createdAt) + index + 1,
      order: index * 100 + 90,
      html: traceNode({ key: 'assessment', id: waveId, marker: 'A', kind: 'SUPERVISOR', title: `${waveLabel(wave, index)} 평가`, description: typeof wave.assessment === 'string' ? wave.assessment : wave.assessment.summary || wave.assessment.decision || '평가 근거가 기록되었습니다.', status: wave.assessment.status || wave.status || 'completed', side: clockLabel(wave.completedAt), tags: normaliseTextList(wave.assessment.missingGates || wave.assessment.missingCriteria).slice(0, 3), concealed: !expanded && state.traceFilters.has('worker') }),
    });
  }
  for (const { event, id, index } of goalEventEntries(goal)) {
    if ((event.kind === 'owner' && event.phase === 'queued') || (event.kind === 'director' && event.phase === 'analyzed')) continue;
    const presentation = goalEventPresentation(event);
    timeline.push({
      time: timeMs(event.at || event.createdAt) || timeMs(goal.createdAt) + index,
      order: 10000 + index,
      html: traceNode({ key: 'goal-event', id, marker: 'D', kind: presentation.category, title: presentation.title, description: event.message || 'Director 감독 이벤트가 기록되었습니다.', status: presentation.status, side: clockLabel(event.at || event.createdAt), tags: [event.phase, event.kind].filter(Boolean), category: presentation.traceCategory }),
    });
  }
  for (const { run: turn, event, index, id } of directorTurnEntries(goal)) {
    timeline.push({
      time: timeMs(event.at) || timeMs(turn.startedAt || turn.createdAt),
      order: 20000 + timeMs(turn.createdAt) + index,
      html: traceNode({ key: 'director-turn', id, marker: 'D', kind: 'DIRECTOR TURN', title: phaseLabel(event.phase), description: event.message, status: directorTurnStatus(turn, event, index), side: clockLabel(event.at), tags: [`turn ${turn.id.slice(0, 8)}`, turn.status === 'completed' && goalIsActive(goal) ? 'Goal 계속 감독' : ''] .filter(Boolean) }),
    });
  }
  timeline.sort((left, right) => left.time - right.time || left.order - right.order);
  nodes.push(...timeline.map(item => item.html));
  if (goal.status === 'awaiting_owner' || goal.ownerDecision?.required) nodes.push(traceNode({ key: 'owner-decision', marker: '!', kind: 'OWNER GATE', title: goal.ownerDecision?.question || 'Owner 판단 필요', description: normaliseTextList(goal.ownerDecision?.evidence)[0] || 'Director가 중요한 선택 전 목표를 일시정지했습니다.', status: 'awaiting_owner', side: goal.ownerDecision?.askedAt ? clockLabel(goal.ownerDecision.askedAt) : '응답 대기', tags: (goal.ownerDecision?.options || []).map(decisionOptionLabel).slice(0, 3) }));
  if (goalIsTerminal(goal) || goal.finalReport || goal.error) nodes.push(traceNode({ key: 'final', marker: '✓', kind: 'DIRECTOR', title: goal.status === 'completed' ? 'Goal 완료 판정' : `${goalStatusLabel(goal.status)} 보고`, description: typeof goal.finalReport === 'string' ? goal.finalReport : goal.finalReport?.summary || goal.error || '최종 보고와 검증 근거를 확인하세요.', status: goal.status, side: clockLabel(goal.completedAt || goal.updatedAt), tags: [`Cycle ${goal.cycleCount || 0}`, `재작업 ${goal.remediationCount || 0}`] }));
  root.innerHTML = nodes.join('');
  return goalTaskIds(goal).map(id => state.board.find(task => task.id === id)?.status || goalTaskRecord(id, goal)?.status || actionForTask(id)?.status || 'queued');
}

function renderTrace() {
  const run = latestRun();
  const goal = selectedGoal();
  const root = $('owner-trace-list');
  document.querySelectorAll('[data-trace-filter]').forEach(button => {
    const active = state.traceFilters.has(button.dataset.traceFilter);
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('active', active);
  });
  if (state.boardStatus?.error && !run && !goal) {
    root.innerHTML = `<div class="trace-empty" role="alert"><strong>작업 보드를 불러오지 못했습니다</strong><span>${escapeHtml(friendlyErrorMessage(state.boardStatus.error))}</span><button class="secondary-button" type="button" data-retry-board>다시 시도</button></div>`;
    $('trace-summary').innerHTML = '<span class="blocked"><i></i>보드 오류</span>';
    return;
  }
  if (!run && !goal) {
    const director = selectedDirector();
    root.innerHTML = director?.kind === 'project' && !director.cwd
      ? '<div class="trace-empty onboarding-empty"><strong>목표를 맡길 준비를 시작하세요</strong><span>프로젝트 연결 → 목표·완료 기준 입력 → 실행·검증 추적 순서로 진행됩니다.</span><ol><li class="current"><b>1</b>로컬 프로젝트 연결</li><li><b>2</b>목표와 완료 기준 입력</li><li><b>3</b>Worker 실행과 검증 확인</li></ol></div>'
      : '<div class="trace-empty"><strong>실행 흐름이 아직 없습니다</strong><span>오른쪽 입력창에 기능, 버그, API 명세나 완료 기준을 보내면 분석·계획·Worker 실행·검증이 시간순으로 표시됩니다.</span></div>';
    $('trace-summary').innerHTML = '<span><i></i>단계 0개</span>';
    return;
  }
  const statuses = goal ? renderGoalTrace(goal, root) : renderLegacyTrace(run, root);
  root.querySelectorAll('[data-select-trace]').forEach(button => button.addEventListener('click', () => selectTrace(button.dataset.selectTrace, button.dataset.traceId || null)));
  root.querySelectorAll('[data-select-task]').forEach(button => button.addEventListener('click', () => selectTask(button.dataset.selectTask)));
  root.querySelectorAll('[data-wave-toggle]').forEach(button => button.addEventListener('click', () => {
    const opener = activeElementIdentity();
    state.waveExpansion.set(button.dataset.waveToggle, button.getAttribute('aria-expanded') !== 'true');
    renderTrace();
    restoreActiveElement(opener);
  }));
  const running = statuses.filter(status => status === 'running').length;
  const blocked = statuses.filter(status => ['blocked', 'review', 'scheduled', 'failed'].includes(status)).length;
  const done = statuses.filter(status => ['done', 'archived'].includes(status)).length;
  const filtered = root.querySelectorAll('.trace-node[data-filtered="true"]').length;
  const visible = root.querySelectorAll('.trace-node:not([hidden])').length;
  if (!visible) root.insertAdjacentHTML('beforeend', '<div class="trace-filter-empty"><strong>선택한 필터에 표시할 이벤트가 없습니다.</strong><span>위 필터를 다시 켜면 기존 trace가 그대로 나타납니다.</span></div>');
  $('trace-summary').innerHTML = `${goal ? `<span class="${goalStatusTone(goal.status)}"><i></i>${escapeHtml(goalStatusLabel(goal.status))}</span>` : ''}<span class="running"><i></i>${running} 실행</span><span><i></i>${done} 완료</span><span class="blocked"><i></i>${blocked} 확인</span>${filtered ? `<span><i></i>${filtered} 숨김</span>` : ''}${state.goalDetailLoading && state.goalDetailLoadingId === goal?.id ? '<span class="running"><i></i>상세 이력 동기화</span>' : ''}${state.boardStatus?.error ? '<span class="blocked"><i></i>stale board</span>' : ''}${selectedGoalDetailError(goal) ? '<span class="blocked"><i></i>상세 이력 stale</span>' : ''}`;
}

function goalTaskLinks(taskIds) {
  if (!taskIds?.length) return '<p class="detail-empty">아직 배치된 Worker가 없습니다.</p>';
  return `<div class="goal-task-links">${taskIds.map(taskId => {
    const action = actionForTask(taskId);
    const task = state.board.find(candidate => candidate.id === taskId);
    const record = goalTaskRecord(taskId);
    const title = action?.title || record?.title || task?.title || taskId;
    const status = task?.status || record?.status || action?.status || 'queued';
    return `<button type="button" data-goal-task="${escapeHtml(taskId)}"><span><b>${escapeHtml(title)}</b><small>${escapeHtml(action?.target || record?.profile || task?.assignee || taskId)}</small></span><em class="${traceStatus(status)}">${escapeHtml(statusLabel(status))}</em></button>`;
  }).join('')}</div>`;
}

function structuredDetailsHtml(value) {
  if (value == null || value === '') return '<p class="detail-empty">기록 없음</p>';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return `<p>${formatText(String(value))}</p>`;
  if (Array.isArray(value)) return listHtml(normaliseTextList(value));
  const rows = Object.entries(value).map(([key, item]) => {
    const content = item && typeof item === 'object'
      ? (Array.isArray(item) ? listHtml(normaliseTextList(item)) : `<pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre>`)
      : `<p>${formatText(String(item ?? ''))}</p>`;
    return `<div><dt>${escapeHtml(key.replaceAll('_', ' '))}</dt><dd>${content}</dd></div>`;
  }).join('');
  return rows ? `<dl class="structured-details">${rows}</dl>` : '<p class="detail-empty">기록 없음</p>';
}

function renderGoalOverviewInspector(goal, run) {
  const wave = currentWave(goal);
  const analysis = goalAnalysis(goal, run);
  const latestEvent = goal.events?.at(-1);
  $('inspector-title').textContent = 'Goal 감독 현황';
  return `<div class="inspector-hero goal-hero"><span class="goal-state ${goalStatusTone(goal.status)}"><i></i>${escapeHtml(goalStatusLabel(goal.status))}</span><h3>${escapeHtml(goal.objective)}</h3><p>${escapeHtml(latestEvent?.message || analysis?.requestSummary || 'Director가 완료 기준을 향해 목표를 감독합니다.')}</p><div class="inspector-meta"><code>${escapeHtml(goal.id)}</code><span>${escapeHtml(goal.workflowId || run?.workflowId || '플로우 선택 중')}</span><span>Cycle ${escapeHtml(goal.cycleCount || 0)}${goal.maxCycles ? ` / ${escapeHtml(goal.maxCycles)}` : ''}</span><span>재작업 ${escapeHtml(goal.remediationCount || 0)}${goal.maxRemediationLoops ? ` / ${escapeHtml(goal.maxRemediationLoops)}` : ''}</span></div></div>
    ${selectedGoalDetailError(goal) ? inlineErrorHtml('Goal 전체 이력 동기화에 실패해 기존 trace를 유지합니다', selectedGoalDetailError(goal), 'data-retry-goal') : ''}
    ${detailGroup('완료 기준', listHtml(normaliseTextList(goalCriteria(goal, run)), 'Director가 성공 조건을 정리하는 중입니다.'))}
    ${detailGroup('현재 감독 단계', `<div class="supervision-state"><strong>${escapeHtml(wave ? waveLabel(wave, (goal.waves || []).indexOf(wave)) : goalStatusLabel(goal.status))}</strong><p>${escapeHtml(run?.status === 'completed' && goalIsActive(goal) ? '최근 Director 판단 턴은 완료됐습니다. Goal은 종료되지 않았으며 Worker 결과 뒤 새 평가 턴이 자동으로 이어집니다.' : run?.status === 'running' ? `Director 판단 턴 실행 중 · ${phaseLabel(run.phase)}` : latestEvent?.message || '다음 상태 전환을 기다리는 중입니다.')}</p></div>`)}
    ${wave ? detailGroup('현재 Wave Worker', goalTaskLinks(wave.taskIds || goal.currentWaveTaskIds)) : ''}
    ${detailGroup('공개 운영 결정', listHtml(normaliseTextList(goal.publicDecisions || run?.publicDecisions), '아직 공개된 운영 결정이 없습니다.'))}
    ${detailGroup('누적 증거', structuredDetailsHtml(goal.evidence))}
    ${goal.ownerAnswers?.length ? detailGroup('Owner 결정 이력', structuredDetailsHtml(goal.ownerAnswers)) : ''}
    ${goal.finalReport || goal.error ? detailGroup(goal.status === 'completed' ? '완료 보고' : '중단 보고', structuredDetailsHtml(goal.finalReport || goal.error)) : ''}`;
}

function renderOverviewInspector() {
  const director = selectedDirector();
  const goal = selectedGoal();
  const run = latestRun();
  $('inspector-title').textContent = 'Director 개요';
  if (director?.kind === 'project' && !director.cwd) {
    return `<div class="inspector-hero setup-hero"><span class="setup-kicker">시작 준비</span><h3>${escapeHtml(director.name)}</h3><p>이 슬롯에 Windows 또는 WSL 프로젝트를 연결하면 목표 입력과 Worker 실행이 열립니다.</p><button type="button" class="primary-button" data-open-projects>프로젝트 연결</button></div>
      ${detailGroup('연결 후 할 수 있는 일', listHtml(['기능·버그·API 명세를 목표로 전달', 'Director의 분석과 작업 분할 확인', 'Worker 실행·검증 근거와 Owner 판단 추적']))}`;
  }
  if (goal) return renderGoalOverviewInspector(goal, run);
  return `<div class="inspector-hero"><h3>${escapeHtml(director?.name || 'Director')}</h3><p>${escapeHtml(director?.cwd || '프로젝트가 배정되지 않았습니다.')}</p><div class="inspector-meta"><span>${escapeHtml(director?.kind === 'skill' ? 'Skill Director' : 'Project Director')}</span><span>${escapeHtml(runtimeLabel(director))}</span><span>${escapeHtml(statusLabel(director?.status))}</span><code>${escapeHtml(director?.board || '')}</code></div></div>
    ${detailGroup('현재 목표', run ? `<p>${formatText(run.prompt)}</p>` : '<p class="detail-empty">새 목표를 기다리는 중입니다.</p>')}
    ${run ? detailGroup('현재 운영 상태', `<p>${escapeHtml(phaseLabel(run.phase))} · 작업 ${run.taskIds?.length || 0}개 · ${elapsedLabel(run.startedAt, run.completedAt || Date.now())}</p>`) : ''}
    ${detailGroup('Owner 개입', '<p>Director 분석·계획과 모든 Worker 실행을 같은 trace에서 선택할 수 있습니다. 실행 중 Worker를 열면 추가 지시와 일시정지 제어가 나타납니다.</p>')}`;
}

function renderObjectiveInspector(run, goal = selectedGoal()) {
  $('inspector-title').textContent = 'Owner 목표';
  return `<div class="inspector-hero"><h3>${escapeHtml(goal?.objective || run?.prompt || '목표 없음')}</h3><p>이 문장이 여러 Director 판단 턴과 Worker wave를 묶는 지속형 Goal의 기준점입니다.</p><div class="inspector-meta"><span>Owner Goal</span><code>${escapeHtml(goal?.id || run?.id || '')}</code><span>${escapeHtml(clockLabel(goal?.createdAt || run?.createdAt))}</span>${goal ? `<span>${escapeHtml(goalStatusLabel(goal.status))}</span>` : ''}</div></div>
    ${goal ? detailGroup('완료 기준', listHtml(normaliseTextList(goalCriteria(goal, run)), 'Director가 성공 조건을 확정하는 중입니다.')) : ''}
    ${goal ? detailGroup('Owner가 준 제약', listHtml(normaliseTextList(goal.constraints || goalAnalysis(goal, run)?.constraints))) : ''}`;
}

function renderAnalysisInspector(run, goal = selectedGoal()) {
  $('inspector-title').textContent = 'Director 분석';
  const analysis = goalAnalysis(goal, run);
  if (!analysis) return `<div class="inspector-hero"><h3>판단 근거를 구성하는 중</h3><p>요구, 성공 조건, 확인된 근거, 위험과 대안을 공개 체크포인트로 정리합니다.</p><div class="inspector-meta"><span>Director 분석</span></div></div><div class="inspector-loading">${escapeHtml(run?.progressEvents?.at(-1)?.message || '대기 중…')}</div>`;
  const candidates = (analysis.workflowCandidates || []).map(candidate => `<div class="candidate-row ${candidate.id === analysis.recommendedWorkflow ? 'recommended' : ''}"><b>${escapeHtml(workflowFor(candidate.id)?.name || candidate.id)}</b><span>${escapeHtml(candidate.fit)}<small>${escapeHtml(candidate.tradeoff)}</small></span></div>`).join('');
  return `<div class="inspector-hero"><h3>${escapeHtml(analysis.requestSummary)}</h3><p>내부 사고문장이 아닌 검증 가능한 판단 근거와 운영 결정을 공개합니다.</p><div class="inspector-meta"><span>공개 판단 기록</span><span>${escapeHtml(workflowFor(analysis.recommendedWorkflow)?.name || analysis.recommendedWorkflow)}</span><code>analysis.v1</code></div></div>
    ${detailGroup('성공 조건', listHtml(normaliseTextList(goalCriteria(goal, run))))}
    ${detailGroup('확인된 근거', listHtml(analysis.evidence))}
    ${detailGroup('제약', listHtml(analysis.constraints))}
    ${detailGroup('위험', listHtml(analysis.risks))}
    ${detailGroup('불확실성', listHtml(analysis.unknowns))}
    ${detailGroup('플로우 후보', `<div class="candidate-list">${candidates || '<p class="detail-empty">후보 없음</p>'}</div>`)}
    ${detailGroup('Worker 분할 판단', listHtml(analysis.workerStrategy))}
    ${detailGroup('리뷰 전략', listHtml(analysis.reviewStrategy))}
    ${detailGroup('중단·Owner 호출 조건', listHtml(analysis.stopConditions))}`;
}

function renderPlanInspector(run, goal = selectedGoal()) {
  $('inspector-title').textContent = '실행 계획';
  const actionsList = goal ? goalActions(goal) : run?.actions || [];
  const workflowId = goal?.workflowId || run?.workflowId;
  if (!workflowId && !actionsList.length) return `<div class="inspector-hero"><h3>Worker 구성과 의존성을 설계하는 중</h3><p>${escapeHtml(run?.progressEvents?.at(-1)?.message || '분석 결과를 실행 가능한 작업 그래프로 변환합니다.')}</p><div class="inspector-meta"><span>Director 계획</span></div></div>`;
  const workflow = workflowFor(workflowId);
  const actions = actionsList.map((action, index) => `<article class="plan-action"><span>${index + 1}</span><div><strong>${escapeHtml(action.title)}</strong><p>${escapeHtml(action.task)}</p><small>${escapeHtml(action.target)}${action.parentTaskIds?.length ? ` · 선행 ${escapeHtml(action.parentTaskIds.join(', '))}` : ' · 즉시 실행 가능'}</small><button type="button" data-goal-task="${escapeHtml(action.taskId)}">Worker 상세</button></div></article>`).join('');
  const waves = (goal?.waves || []).map((wave, index) => `<button class="wave-link" type="button" data-select-trace="wave" data-trace-id="${escapeHtml(String(wave.id || index))}"><span>${escapeHtml(waveLabel(wave, index))}</span><b>${escapeHtml(statusLabel(wave.status || 'queued'))}</b><small>${(wave.taskIds || []).length}개 작업</small></button>`).join('');
  return `<div class="inspector-hero"><h3>${escapeHtml(workflow?.name || workflowId || '대화')}</h3><p>${escapeHtml(workflow?.description || 'Director 응답')}</p><div class="inspector-meta"><span>지속형 감독 계획</span><span>누적 작업 ${actionsList.length}개</span><span>Wave ${goal?.waves?.length || 0}개</span><code>${escapeHtml(workflowId || 'conversation')}</code></div></div>
    ${detailGroup('운영 판단', listHtml(normaliseTextList(goal?.publicDecisions || run?.publicDecisions)))}
    ${waves ? detailGroup('실행 Wave', `<div class="wave-links">${waves}</div>`) : ''}
    ${detailGroup('누적 작업 그래프', `<div class="plan-actions">${actions || '<p class="detail-empty">Worker 작업 없음</p>'}</div>`)}`;
}

function selectedWave(goal, id) {
  return (goal?.waves || []).find((wave, index) => String(wave.id || index) === String(id));
}

function renderWaveInspector(goal, id) {
  const wave = selectedWave(goal, id);
  $('inspector-title').textContent = 'Worker Wave';
  if (!wave) return '<div class="inspector-loading">선택한 Wave 기록을 찾지 못했습니다.</div>';
  const index = (goal.waves || []).indexOf(wave);
  return `<div class="inspector-hero"><span class="goal-state ${traceStatus(wave.status)}"><i></i>${escapeHtml(statusLabel(wave.status || 'running'))}</span><h3>${escapeHtml(waveLabel(wave, index))}</h3><p>Director가 이 묶음의 Worker들을 배치하고 모두 끝날 때까지 감시한 뒤 새 평가 턴을 엽니다.</p><div class="inspector-meta"><code>${escapeHtml(wave.id || String(index))}</code><span>Worker ${(wave.taskIds || []).length}개</span><span>${escapeHtml(elapsedLabel(wave.startedAt, wave.completedAt || Date.now()))}</span></div></div>
    ${detailGroup('Worker 작업', goalTaskLinks(wave.taskIds))}
    ${wave.assessment ? detailGroup('Wave 평가', structuredDetailsHtml(wave.assessment)) : detailGroup('다음 전환', '<p>모든 Worker가 종료되면 Director가 성공 조건과 품질 게이트를 평가합니다. 부족하면 재작업 Wave가 만들어집니다.</p>')}`;
}

function renderAssessmentInspector(goal, id) {
  const wave = selectedWave(goal, id);
  $('inspector-title').textContent = 'Director 평가';
  if (!wave?.assessment) return '<div class="inspector-loading">평가 기록을 기다리는 중입니다.</div>';
  const index = (goal.waves || []).indexOf(wave);
  return `<div class="inspector-hero"><h3>${escapeHtml(waveLabel(wave, index))} 평가</h3><p>Worker의 완료 선언이 아니라 Director가 성공 조건·검증 근거·누락 게이트를 다시 판정한 기록입니다.</p><div class="inspector-meta"><span>Supervisor checkpoint</span><code>${escapeHtml(wave.id || String(index))}</code><span>${escapeHtml(clockLabel(wave.completedAt))}</span></div></div>
    ${detailGroup('평가 결과', structuredDetailsHtml(wave.assessment))}
    ${detailGroup('후속 상태', `<p>${escapeHtml(goalStatusLabel(goal.status))}${goal.remediationCount ? ` · 누적 재작업 ${escapeHtml(goal.remediationCount)}회` : ''}</p>`)}`;
}

function renderGoalEventInspector(goal, id) {
  const entry = goalEventEntries(goal).find(candidate => candidate.id === String(id));
  $('inspector-title').textContent = 'Director 감독 이벤트';
  if (!entry) return '<div class="inspector-loading">선택한 감독 이벤트를 찾지 못했습니다.</div>';
  const { event } = entry;
  const presentation = goalEventPresentation(event);
  return `<div class="inspector-hero"><span class="goal-state ${traceStatus(presentation.status)}"><i></i>${escapeHtml(statusLabel(presentation.status))}</span><h3>${escapeHtml(presentation.title)}</h3><p>${escapeHtml(event.message || 'Director의 공개 운영 판단입니다.')}</p><div class="inspector-meta"><span>${escapeHtml(presentation.category)}</span><span>${escapeHtml(event.phase || goal.phase || '')}</span><code>${escapeHtml(event.kind || 'event')}</code><span>${escapeHtml(clockLabel(event.at || event.createdAt))}</span></div></div>
    ${detailGroup('판단 근거와 상태 변경', structuredDetailsHtml(event.details))}`;
}

function renderDirectorTurnInspector(goal, id) {
  const entry = directorTurnEntries(goal).find(candidate => candidate.id === String(id));
  $('inspector-title').textContent = 'Director 판단 턴';
  if (!entry) return '<div class="inspector-loading">선택한 Director 판단 기록을 찾지 못했습니다.</div>';
  const { run, event, index } = entry;
  const progress = (run.progressEvents || []).filter(item => item?.message).map((item, itemIndex) => `<li class="${itemIndex === index ? 'selected' : ''}"><i></i><span><b>${escapeHtml(phaseLabel(item.phase))}</b>${escapeHtml(item.message)}</span><time>${escapeHtml(clockLabel(item.at))}</time></li>`).join('');
  return `<div class="inspector-hero"><span class="goal-state ${traceStatus(directorTurnStatus(run, event, index))}"><i></i>${escapeHtml(run.status === 'running' ? 'LIVE TURN' : `TURN ${statusLabel(run.status)}`)}</span><h3>${escapeHtml(phaseLabel(event.phase))}</h3><p>${escapeHtml(event.message)}</p><div class="inspector-meta"><code>${escapeHtml(run.id)}</code><span>${escapeHtml(statusLabel(run.status))}</span><span>${escapeHtml(elapsedLabel(run.startedAt, run.completedAt || Date.now()))}</span><span>Goal ${escapeHtml(goal.id.slice(0, 12))}</span></div></div>
    ${detailGroup('공개 진행 체크포인트', `<ol class="turn-event-list">${progress}</ol>`)}
    ${detailGroup('이 체크포인트의 근거', structuredDetailsHtml(event.details))}
    ${run.publicDecisions?.length ? detailGroup('이번 턴의 운영 결정', listHtml(normaliseTextList(run.publicDecisions))) : ''}
    ${run.output ? detailGroup('Director 공개 보고', `<p>${formatText(run.output)}</p>`) : ''}
    ${run.error ? detailGroup('오류와 재시도 근거', `<p class="decision-error">${formatText(run.error)}</p>`) : ''}`;
}

function renderOwnerDecisionInspector(goal) {
  $('inspector-title').textContent = 'Owner 판단';
  const decision = goal?.ownerDecision;
  if (!decision) return '<div class="inspector-loading">현재 대기 중인 Owner 판단이 없습니다.</div>';
  return `<div class="inspector-hero decision-hero"><span class="goal-state blocked"><i></i>GOAL PAUSED</span><h3>${escapeHtml(decision.question || 'Director가 Owner 결정을 기다립니다')}</h3><p>권한·범위·외부 영향처럼 Director가 임의로 정하면 안 되는 지점입니다. 답변 뒤 새 판단 턴이 열립니다.</p><div class="inspector-meta"><code>${escapeHtml(goal.id)}</code><span>${escapeHtml(clockLabel(decision.askedAt))}</span><span>Cycle ${escapeHtml(goal.cycleCount || 0)}</span></div></div>
    ${detailGroup('왜 지금 물어보는가', structuredDetailsHtml(decision.evidence))}
    ${ownerDecisionContract(goal)}
    ${ownerDecisionForm(goal)}`;
}

function finalGateAudit(goal) {
  if (goal?.finalAudit) return goal.finalAudit.gateAudit || goal.finalAudit;
  if (goal?.finalReport && typeof goal.finalReport === 'object' && goal.finalReport.gateAudit) return goal.finalReport.gateAudit;
  const terminalAudit = [...(goal?.events || [])].reverse().find(event => event?.details?.gateAudit)?.details?.gateAudit;
  if (terminalAudit) return terminalAudit;
  return [...(goal?.waves || [])].reverse().find(wave => wave?.assessment?.gateAudit)?.assessment?.gateAudit || null;
}

function criterionEvidenceMatrix(goal, audit) {
  const criteria = normaliseTextList(goalCriteria(goal));
  const audited = new Map((audit?.acceptance?.criteria || []).map(item => [String(item.criterion || '').trim().replace(/\s+/g, ' ').toLowerCase(), item]));
  if (!criteria.length) return '<p class="detail-empty">성공 조건 기록이 없습니다.</p>';
  const rows = criteria.map(criterion => {
    const result = audited.get(criterion.trim().replace(/\s+/g, ' ').toLowerCase());
    const met = result?.met === true && normaliseTextList(result.evidence).length > 0;
    const status = result ? (met ? 'met' : 'not-met') : 'unknown';
    const evidence = normaliseTextList(result?.evidence);
    return `<tr><th scope="row">${escapeHtml(criterion)}</th><td><span class="matrix-verdict ${status}">${result ? (met ? 'MET' : 'NOT MET') : 'NO AUDIT'}</span></td><td>${evidence.length ? `<ul>${evidence.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<span class="matrix-empty">근거 없음</span>'}</td></tr>`;
  }).join('');
  return `<div class="evidence-matrix"><table><thead><tr><th>SUCCESS CRITERION</th><th>VERDICT</th><th>EXACT GATE EVIDENCE</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function gateProfileMatrix(goal, audit) {
  const workflow = workflowFor(goal?.workflowId);
  const profiles = audit?.requiredProfiles || workflow?.policy?.requiredProfiles || [];
  if (!profiles.length) return '<p class="detail-empty">필수 검증 프로필 기록이 없습니다.</p>';
  const missing = new Set(audit?.missingProfiles || []);
  const stale = new Set(audit?.staleProfiles || []);
  const rejected = new Set(audit?.rejectedProfiles || []);
  const credited = audit?.creditedTaskIds || {};
  const rows = profiles.map(profile => {
    const taskId = credited[profile] || null;
    const freshness = stale.has(profile) ? 'STALE' : rejected.has(profile) ? 'REJECTED' : missing.has(profile) ? 'MISSING' : taskId ? 'CURRENT' : 'UNKNOWN';
    const passes = taskId && !missing.has(profile) && !stale.has(profile) && !rejected.has(profile)
      && (profile !== 'quality-gate-reviewer' || audit?.gateConsistency?.satisfied !== false);
    const verdict = passes ? 'PASS' : missing.has(profile) || stale.has(profile) || rejected.has(profile) ? 'FAIL' : 'UNKNOWN';
    const label = state.summary?.workerProfiles?.[profile]?.label || profile;
    return `<tr><th scope="row"><span>${escapeHtml(label)}</span><code>${escapeHtml(profile)}</code></th><td>${taskId ? `<button type="button" data-goal-task="${escapeHtml(taskId)}"><code>${escapeHtml(taskId)}</code></button>` : '<span class="matrix-empty">없음</span>'}</td><td><span class="matrix-freshness ${freshness.toLowerCase()}">${freshness}</span></td><td><span class="matrix-verdict ${verdict.toLowerCase()}">${verdict}</span></td></tr>`;
  }).join('');
  const consistency = audit?.gateConsistency;
  const reasons = normaliseTextList(consistency?.reasons);
  return `<div class="evidence-matrix profile-matrix"><table><thead><tr><th>REQUIRED PROFILE</th><th>CREDITED TASK</th><th>FRESHNESS</th><th>GATE VERDICT</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${consistency ? `<div class="gate-consistency ${consistency.satisfied ? 'pass' : 'fail'}"><strong>Gate consistency ${consistency.satisfied ? 'PASS' : 'FAIL'}</strong>${reasons.length ? `<span>${escapeHtml(reasons.join(' · '))}</span>` : ''}</div>` : ''}`;
}

function candidateAuditSummary(goal, audit) {
  const candidate = audit?.hostCandidate || goal?.currentCandidate;
  const gateTaskId = audit?.approvedGateTaskId || audit?.acceptance?.gateTaskId;
  const receipts = audit?.hostReceipts;
  if (!candidate && !gateTaskId && !receipts) return '<p class="detail-empty">후보 digest와 Gate task 기록이 없습니다.</p>';
  return `<dl class="candidate-audit"><div><dt>CANDIDATE DIGEST</dt><dd><code>${escapeHtml(candidate?.digest || 'not-recorded')}</code></dd></div><div><dt>REVISION</dt><dd><code>${escapeHtml(candidate?.revision || 'not-recorded')}</code></dd></div><div><dt>DIRTY / FILES</dt><dd>${escapeHtml(candidate ? `${Boolean(candidate.dirty)} / ${candidate.fileCount ?? 'unknown'}` : 'not-recorded')}</dd></div><div><dt>APPROVED GATE TASK</dt><dd>${gateTaskId ? `<button type="button" data-goal-task="${escapeHtml(gateTaskId)}"><code>${escapeHtml(gateTaskId)}</code></button>` : '<span class="matrix-empty">없음</span>'}</dd></div></dl>
    ${receipts ? `<div class="host-receipt-summary ${receipts.satisfied ? 'pass' : 'fail'}"><header><strong>HOST RECEIPTS ${receipts.satisfied ? 'SATISFIED' : 'INCOMPLETE'}</strong><span>executionAttested: ${receipts.executionAttested === true ? 'true' : 'false'}</span></header><dl><div><dt>OBSERVED TASKS</dt><dd>${escapeHtml((receipts.observedTaskIds || []).join(', ') || 'none')}</dd></div><div><dt>MISSING TASKS</dt><dd>${escapeHtml((receipts.missingTaskIds || []).join(', ') || 'none')}</dd></div></dl><p>${escapeHtml(receipts.limitation || 'Host receipt는 관찰된 Hermes 기록을 증명하며 Worker가 작성한 실행 주장 자체를 증명하지 않습니다.')}</p></div>` : ''}`;
}

function renderFinalInspector(goal) {
  $('inspector-title').textContent = goal?.status === 'completed' ? 'Goal 완료 보고' : 'Goal 중단 보고';
  if (!goal) return '<div class="inspector-loading">Goal 기록이 없습니다.</div>';
  const complete = goal.status === 'completed';
  const audit = finalGateAudit(goal);
  return `<div class="inspector-hero"><span class="goal-state ${goalStatusTone(goal.status)}"><i></i>${escapeHtml(goalStatusLabel(goal.status))}</span><h3>${escapeHtml(complete ? '완료 기준과 품질 게이트 판정' : '진행 중단과 남은 위험')}</h3><p>${escapeHtml(typeof goal.finalReport === 'string' ? goal.finalReport : goal.finalReport?.summary || goal.error || (complete ? 'Director가 전체 목표 완료를 판정했습니다.' : 'Director가 더 진행할 수 없는 이유를 기록했습니다.'))}</p><div class="inspector-meta"><code>${escapeHtml(goal.id)}</code><span>Cycle ${escapeHtml(goal.cycleCount || 0)}</span><span>재작업 ${escapeHtml(goal.remediationCount || 0)}</span><span>${escapeHtml(clockLabel(goal.completedAt || goal.updatedAt))}</span></div></div>
    ${detailGroup('성공 조건별 완료 판정', criterionEvidenceMatrix(goal, audit))}
    ${detailGroup('필수 Profile · Freshness · Gate 판정', gateProfileMatrix(goal, audit))}
    ${detailGroup('검증 후보와 최종 Gate', candidateAuditSummary(goal, audit))}
    ${detailGroup('최종 보고', structuredDetailsHtml(goal.finalReport || goal.error))}
    ${detailGroup('누적 검증 증거', structuredDetailsHtml(goal.evidence))}
    ${!audit ? '<div class="audit-warning" role="note">Legacy Goal이라 구조화된 finalAudit이 없습니다. 완료 선언과 증거 원문은 보이지만 fresh gate 충족 여부는 이 화면이 추정하지 않습니다.</div>' : ''}`;
}

function eventDescription(event) {
  const payload = event.payload || {};
  if (event.kind === 'created') return `작업 생성 · ${payload.assignee || ''}`;
  if (event.kind === 'claimed') return `Worker가 작업을 확보함 · run ${payload.run_id || event.run_id || ''}`;
  if (event.kind === 'spawned') return `Worker 프로세스 시작 · PID ${payload.pid || ''}`;
  if (event.kind === 'commented') return `${payload.author || '사용자'}가 실행 중 지시를 추가함`;
  if (event.kind === 'reclaimed') return 'Owner가 Worker 실행을 일시정지함';
  if (event.kind === 'blocked') return '작업이 Owner 판단 대기로 전환됨';
  if (event.kind === 'completed') return `작업 완료 · ${payload.summary || ''}`;
  return event.kind;
}

function renderPublicTrace(details, log) {
  const task = details?.task || {};
  const comments = details?.comments || [];
  const events = details?.events || [];
  const logText = stripAnsi(log || '').trim();
  const observedSteps = logText.split(/\r?\n/).map(line => line.trim()).filter(line =>
    line && (/⚡|exec_comm|mcp\.|tool|command|error|warning|failed|completed/i.test(line))
  ).slice(-80);
  const commentsHtml = comments.map(comment => {
    const prefix = String(comment.body || '').match(/^(PLAN|OBSERVED|DECISION|VERIFY):/i)?.[1]?.toUpperCase() || (String(comment.author).toLowerCase() === 'owner' ? 'OWNER' : 'NOTE');
    return `<article class="reasoning-entry ${prefix.toLowerCase()}"><header><b>${escapeHtml(prefix)}</b><span>${escapeHtml(comment.author || 'Worker')}</span><time>${escapeHtml(clockLabel(comment.created_at))}</time></header><p>${formatText(comment.body)}</p></article>`;
  }).join('');
  const eventsHtml = events.map(event => `<li><i></i><span>${escapeHtml(eventDescription(event))}</span><time>${escapeHtml(clockLabel(event.created_at))}</time></li>`).join('');
  const rawLogOpen = state.rawLogOpen ?? task.status === 'running';
  const traceError = state.taskTraceError ? inlineErrorHtml('실행 로그를 불러오지 못했습니다', state.taskTraceError, 'data-retry-task') : '';
  const statusUncertain = Boolean(state.taskError || state.taskLoading);
  const statusText = state.taskError ? '상태 확인 실패' : state.taskLoading ? '동기화 중' : task.status === 'running' ? 'LIVE' : statusLabel(task.status);
  return `<div class="live-trace-head"><span class="live-indicator ${task.status === 'running' && !statusUncertain ? 'active' : ''}"><i></i>${statusText}</span><small>${state.taskError ? '최신 Worker 상태를 확인하지 못함' : state.taskTrace?.observedAt ? `마지막 동기화 ${clockLabel(state.taskTrace.observedAt)}` : state.taskTraceError ? '동기화 실패' : '로그 동기화 중'}</small></div>
    ${traceError}
    <div class="reasoning-feed">${commentsHtml || '<div class="trace-placeholder">이전 작업에는 공개 체크포인트가 없습니다. 새 작업부터 PLAN · OBSERVED · DECISION · VERIFY가 실시간으로 쌓입니다.</div>'}</div>
    ${observedSteps.length ? `<div class="observed-commands"><header><strong>관찰된 실행 단계</strong><span>${observedSteps.length}</span></header><ol>${observedSteps.map(step => `<li><i></i><code>${escapeHtml(step)}</code></li>`).join('')}</ol></div>` : ''}
    ${logText ? `<details class="raw-worker-log" ${rawLogOpen ? 'open' : ''}><summary data-raw-worker-log-summary>실행 로그 원문 <span>${logText.split(/\r?\n/).length}줄</span></summary><pre>${escapeHtml(logText)}</pre></details>` : state.taskTraceError ? '' : '<div class="trace-placeholder">Worker 로그가 아직 생성되지 않았습니다.</div>'}
    <ol class="event-list worker-lifecycle">${eventsHtml}</ol>`;
}

function renderTaskInspector() {
  $('inspector-title').textContent = 'Worker 실시간 추적';
  if (state.taskLoading && !state.taskDetail) return '<div class="inspector-loading">Worker 실행 trace를 불러오는 중…</div>';
  if (state.taskError && !state.taskDetail) return inlineErrorHtml('Worker 상세 정보를 불러오지 못했습니다', state.taskError, 'data-retry-task');
  const details = state.taskDetail;
  if (!details?.task) return '<div class="inspector-loading">Worker 상세 정보를 기다리는 중…</div>';
  const { task, latest_summary: summary, runs = [] } = details;
  const action = actionForTask(task.id);
  const record = goalTaskRecord(task.id);
  const lastRun = runs.at(-1);
  const taskAction = action?.task || sectionFromBody(task.body, 'ACTION') || task.body || '영속 Goal Worker 작업';
  const acceptance = action?.acceptance || record?.acceptance || sectionFromBody(task.body, 'ACCEPTANCE').split(/\r?\n/).map(line => line.replace(/^[-*]\s*/, '')).filter(Boolean);
  const statusUncertain = Boolean(state.taskError || state.taskLoading || controlPlaneUnavailable());
  const staleNotice = state.taskError ? inlineErrorHtml('최신 Worker 상태를 확인하지 못했습니다', state.taskError, 'data-retry-task') : '';
  const canIntervene = ['running', 'ready', 'todo', 'blocked', 'scheduled', 'review'].includes(task.status);
  const taskBusy = state.busyActions.has(`control:${task.id}`);
  const interventionBusy = state.busyActions.has(`intervention:${task.id}`);
  const control = task.status === 'running'
    ? `<button class="danger-button" type="button" data-worker-control="pause" ${taskBusy || statusUncertain ? 'disabled' : ''}>${taskBusy ? '처리 중…' : statusUncertain ? '동기화 필요' : '즉시 일시정지'}</button>`
    : ['blocked', 'scheduled'].includes(task.status)
      ? `<button class="resume-button" type="button" data-worker-control="resume" ${taskBusy || statusUncertain ? 'disabled' : ''}>${taskBusy ? '처리 중…' : statusUncertain ? '동기화 필요' : '재개'}</button>` : '';
  const receipt = state.interventionReceipt?.taskId === task.id ? state.interventionReceipt : null;
  const intervention = canIntervene ? `<section class="worker-control ${statusUncertain ? 'locked' : ''}"><header><div><span>OWNER 개입</span><strong>${statusUncertain ? '최신 상태 확인 전에는 조작할 수 없습니다' : '추가 지시를 실행 큐에 등록합니다'}</strong></div>${control}</header><textarea id="worker-intervention-input" rows="3" aria-label="Worker에게 전달할 추가 지시" placeholder="예: 그 파일은 건드리지 말고 API 계약부터 확인해." ${interventionBusy || statusUncertain ? 'disabled' : ''}>${escapeHtml(state.interventionDraft)}</textarea>${receipt ? `<p class="intervention-receipt"><b>ACCEPTED / QUEUED</b><span>${escapeHtml(clockLabel(receipt.at))} · Worker 반영 여부는 다음 공개 체크포인트에서 확인하세요.</span></p>` : ''}<div><small>${statusUncertain ? '기존 trace는 보존됩니다. 동기화에 성공하면 상태 변경 버튼이 다시 열립니다.' : '서버가 지시를 접수해 큐에 기록합니다. 실제 Worker 반영은 다음 동기화 이후 확인됩니다.'}</small><button type="button" data-send-intervention ${interventionBusy || statusUncertain ? 'disabled' : ''}>${interventionBusy ? '접수 중…' : statusUncertain ? '동기화 필요' : '지시 등록'}</button></div></section>` : '';
  const hostReceipt = record?.hostReceipt;
  const hostReceiptHtml = hostReceipt ? `<div class="host-receipt ${hostReceipt.executionAttested === true ? 'attested' : 'observed'}"><header><strong>${hostReceipt.executionAttested === true ? 'HOST EXECUTION ATTESTED' : 'HOST RECEIPT · EXECUTION NOT ATTESTED'}</strong><span>${hostReceipt.executionAttested === true ? '실행 증명 포함' : '관찰·기록만 확인됨'}</span></header>${structuredDetailsHtml(hostReceipt)}</div>` : '';
  return `${staleNotice}<div class="inspector-hero"><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(taskAction)}</p><div class="inspector-meta"><span>Worker 실행</span><code>${escapeHtml(task.id)}</code><span>${escapeHtml(task.assignee || '미배정')}</span><span>${escapeHtml(statusLabel(task.status))}</span>${task.started_at ? `<span>${escapeHtml(elapsedLabel(task.started_at, task.completed_at || Date.now()))}</span>` : ''}</div></div>
    ${intervention}
    ${detailGroup('공개 추론·실행 trace', renderPublicTrace(details, state.taskTrace?.log), 'public-trace-group')}
    ${hostReceipt ? detailGroup('Host 관찰 영수증', hostReceiptHtml) : ''}
    ${detailGroup('완료 기준', listHtml(acceptance))}
    ${summary ? detailGroup('최근 결과 요약', `<p>${formatText(summary)}</p>`) : ''}
    ${lastRun?.metadata?.verification ? detailGroup('검증', `<p>${formatText(lastRun.metadata.verification)}</p>`) : ''}`;
}

function bindInspectorActions() {
  const interventionInput = $('worker-intervention-input');
  interventionInput?.addEventListener('input', event => { state.interventionDraft = event.currentTarget.value; });
  interventionInput?.addEventListener('compositionstart', () => { state.interventionComposing = true; });
  interventionInput?.addEventListener('compositionend', event => {
    state.interventionComposing = false;
    state.interventionDraft = event.currentTarget.value;
    renderInspector({ force: true });
  });
  $('owner-inspector').querySelector('.raw-worker-log')?.addEventListener('toggle', event => { state.rawLogOpen = event.currentTarget.open; });
  $('owner-inspector').querySelector('[data-send-intervention]')?.addEventListener('click', sendIntervention);
  $('owner-inspector').querySelectorAll('[data-worker-control]').forEach(button => button.addEventListener('click', () => controlWorker(button.dataset.workerControl)));
  $('owner-inspector').querySelectorAll('[data-retry-task]').forEach(button => button.addEventListener('click', () => refreshSelectedTask({ force: true })));
  $('owner-inspector').querySelectorAll('[data-retry-goal]').forEach(button => button.addEventListener('click', () => refreshSelectedGoalDetail({ force: true })));
  $('owner-inspector').querySelectorAll('[data-goal-task]').forEach(button => button.addEventListener('click', () => selectTask(button.dataset.goalTask)));
  $('owner-inspector').querySelectorAll('[data-select-trace]').forEach(button => button.addEventListener('click', () => selectTrace(button.dataset.selectTrace, button.dataset.traceId || null)));
  bindDecisionActions($('owner-inspector'));
}

function renderInspector({ force = false } = {}) {
  if (!force && (state.interventionComposing || state.decisionComposing)) return;
  const focusedInput = document.activeElement?.id === 'worker-intervention-input' ? document.activeElement : null;
  const inputSelection = focusedInput ? {
    start: focusedInput.selectionStart,
    end: focusedInput.selectionEnd,
    direction: focusedInput.selectionDirection,
    scrollTop: focusedInput.scrollTop,
  } : null;
  const activeInFocus = Boolean(document.activeElement?.closest('#focus-dialog-content'));
  const activeElement = activeElementIdentity();
  const scroller = document.querySelector('.inspector-scroll');
  const renderKey = `${state.selectedId}:${state.selection.type}:${state.selection.id || ''}`;
  const preserve = state.inspectorRenderKey === renderKey;
  const previousTop = scroller?.scrollTop || 0;
  const stickToBottom = Boolean(scroller && scroller.scrollHeight - scroller.clientHeight - previousTop < 32);
  const goal = selectedGoal();
  const run = latestRun();
  let html;
  if (state.selection.type === 'objective') html = renderObjectiveInspector(run, goal);
  else if (state.selection.type === 'analysis') html = renderAnalysisInspector(run, goal);
  else if (state.selection.type === 'plan') html = renderPlanInspector(run, goal);
  else if (state.selection.type === 'wave') html = renderWaveInspector(goal, state.selection.id);
  else if (state.selection.type === 'assessment') html = renderAssessmentInspector(goal, state.selection.id);
  else if (state.selection.type === 'goal-event') html = renderGoalEventInspector(goal, state.selection.id);
  else if (state.selection.type === 'director-turn') html = renderDirectorTurnInspector(goal, state.selection.id);
  else if (state.selection.type === 'owner-decision') html = renderOwnerDecisionInspector(goal);
  else if (state.selection.type === 'final') html = renderFinalInspector(goal);
  else if (state.selection.type === 'task') html = renderTaskInspector();
  else html = renderOverviewInspector();
  $('owner-inspector').innerHTML = html;
  bindInspectorActions();
  syncFocusDialog();
  if (inputSelection) requestAnimationFrame(() => {
    const nextInput = $('worker-intervention-input');
    if (!nextInput || nextInput.disabled) return;
    nextInput.focus({ preventScroll: true });
    nextInput.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction);
    nextInput.scrollTop = inputSelection.scrollTop;
  });
  else if (!activeInFocus) restoreActiveElement(activeElement);
  state.inspectorRenderKey = renderKey;
  if (scroller) requestAnimationFrame(() => {
    scroller.scrollTop = preserve ? (stickToBottom ? scroller.scrollHeight : previousTop) : 0;
  });
}

function renderConversation() {
  const runs = selectedRuns().slice(0, 10).reverse();
  const goal = selectedGoal();
  const firstGoalRun = runs.find(run => goal && run.goalId === goal.id);
  const items = [];
  for (const run of runs) {
    if (!run.goalId || run === firstGoalRun) items.push(`<article class="chat-message owner"><div class="chat-label">OWNER${run.goalId ? ' · GOAL' : ''}</div>${formatText(run.goalId && goal?.id === run.goalId ? goal.objective : run.prompt)}</article>`);
    items.push(`<article class="chat-message director ${run.status === 'failed' ? 'failed' : ''}"><div class="chat-label">DIRECTOR TURN · ${escapeHtml(phaseLabel(run.phase || run.status))}${run.goalId ? ' · Goal 계속 감독' : ''}</div>${run.output ? formatText(run.output) : run.error ? formatText(run.error) : '<span class="thinking">판단 중…</span>'}</article>`);
  }
  $('conversation-count').textContent = `기록 ${items.length}개`;
  $('owner-chat-stream').innerHTML = items.length ? items.join('') : '<div class="chat-empty">아직 대화가 없습니다.</div>';
}

function renderWorkflowCatalog() {
  $('owner-workflow-list').innerHTML = (state.summary?.workflows || []).map(workflow => `<article class="workflow-card"><header><h3>${escapeHtml(workflow.name)}</h3><code>${escapeHtml(workflow.id)}</code></header><p>${escapeHtml(workflow.description)}</p><div class="workflow-steps">${(workflow.graph || []).map(step => `<span>${escapeHtml(step)}</span>`).join('')}</div></article>`).join('');
}

function renderAll() {
  const activeElement = activeElementIdentity();
  renderTopbar();
  renderSyncBanner();
  renderDirectors();
  renderMissionHeader();
  renderCurrentFocus();
  renderGoalProgress();
  renderOwnerGate();
  renderTrace();
  renderInspector();
  renderConversation();
  renderWorkflowCatalog();
  $('skill-count').textContent = String(Object.keys(state.summary?.skills || {}).length);
  if ($('project-dialog').open && state.managementTab === 'skills') renderSkills();
  restoreActiveElement(activeElement);
}

async function loadBoard() {
  const director = selectedDirector();
  if (!director?.cwd || director.kind !== 'project') {
    state.board = [];
    state.boardStatus = null;
    return;
  }
  try {
    const result = await api(`/api/directors/${encodeURIComponent(director.id)}/board`);
    if (state.selectedId !== director.id) return;
    state.board = result.tasks || [];
    state.boardStatus = result.status || null;
  } catch (error) {
    if (state.selectedId !== director.id) return;
    state.boardStatus = { ...(state.boardStatus || {}), error: error.message, stale: true };
  }
}

async function refreshSelectedGoalDetail({ force = false } = {}) {
  const goal = selectedGoalSummary();
  const directorId = state.selectedId;
  if (!goal?.id) return;
  if (state.goalDetailLoading && state.goalDetailLoadingId === goal.id) return;
  if (!force && state.goalDetailId === goal.id && Date.now() - state.goalDetailLoadedAt < TASK_POLL_INTERVAL_MS) return;
  const goalId = goal.id;
  state.goalDetailLoading = true;
  state.goalDetailLoadingId = goalId;
  try {
    const detail = await api(`/api/directors/${encodeURIComponent(directorId)}/goals/${encodeURIComponent(goalId)}`);
    if (state.selectedId !== directorId || selectedGoalSummary()?.id !== goalId) return;
    state.goalDetail = detail;
    state.goalDetailId = goalId;
    state.goalDetailError = null;
    state.goalDetailErrorId = null;
    state.goalDetailLoadedAt = Date.now();
  } catch (error) {
    if (state.selectedId !== directorId || selectedGoalSummary()?.id !== goalId) return;
    state.goalDetailError = error.message;
    state.goalDetailErrorId = goalId;
  } finally {
    if (state.goalDetailLoadingId === goalId) {
      state.goalDetailLoading = false;
      state.goalDetailLoadingId = null;
      renderTrace();
      renderInspector();
      renderConversation();
    }
  }
}

async function refreshSelectedTask({ force = false } = {}) {
  const taskId = state.selection.type === 'task' ? state.selection.id : null;
  if (!taskId || state.taskLoading || (!force && Date.now() - state.taskLoadedAt < TASK_POLL_INTERVAL_MS)) return;
  const directorId = state.selectedId;
  state.taskLoading = true;
  if (force) {
    state.taskError = null;
    state.taskTraceError = null;
  }
  if (force) renderInspector({ force: true });
  try {
    const [detailsResult, traceResult] = await Promise.allSettled([
      api(`/api/directors/${encodeURIComponent(directorId)}/tasks/${encodeURIComponent(taskId)}`),
      api(`/api/directors/${encodeURIComponent(directorId)}/tasks/${encodeURIComponent(taskId)}/trace`),
    ]);
    if (state.selectedId !== directorId || state.selection.id !== taskId) return;
    if (detailsResult.status === 'fulfilled') {
      state.taskDetail = detailsResult.value;
      state.taskError = null;
    } else state.taskError = detailsResult.reason;
    if (traceResult.status === 'fulfilled') {
      state.taskTrace = traceResult.value;
      state.taskTraceError = null;
    } else state.taskTraceError = traceResult.reason;
    state.taskLoadedAt = Date.now();
  } finally {
    state.taskLoading = false;
    renderInspector();
  }
}

async function performLoadConsole({ quiet = false } = {}) {
  state.refreshing = true;
  renderSyncBanner();
  try {
    const summary = await api('/api/directors');
    state.summary = summary;
    state.consoleError = null;
    if (!state.summary.directors.some(director => director.id === state.selectedId)) state.selectedId = state.summary.directors[0]?.id;
    await loadBoard();
    if (state.boardStatus?.error) state.staleSince ||= Date.now();
    else {
      state.lastSyncedAt = Date.now();
      state.staleSince = 0;
    }
    renderAll();
    $('connection-state').className = 'signal online';
    if ($('connection-state').lastElementChild.textContent !== '로컬 연결') $('connection-state').lastElementChild.textContent = '로컬 연결';
    if ($('connection-state').getAttribute('aria-label') !== 'Praetorium 로컬 서버 연결됨') $('connection-state').setAttribute('aria-label', 'Praetorium 로컬 서버 연결됨');
    void refreshSelectedGoalDetail();
    void refreshSelectedTask();
  } catch (error) {
    state.consoleError = error.message;
    state.staleSince ||= Date.now();
    $('connection-state').className = 'signal offline';
    if ($('connection-state').lastElementChild.textContent !== '연결 끊김') $('connection-state').lastElementChild.textContent = '연결 끊김';
    const connectionErrorLabel = `Praetorium 로컬 서버 연결 끊김: ${error.message}`;
    if ($('connection-state').getAttribute('aria-label') !== connectionErrorLabel) $('connection-state').setAttribute('aria-label', connectionErrorLabel);
    renderAll();
    if (!quiet) toast(error.message, 'error');
  } finally {
    state.refreshing = false;
    renderSyncBanner();
  }
}

async function loadConsole(options = {}) {
  if (state.loading) return state.loading;
  state.loading = performLoadConsole(options);
  try { return await state.loading; } finally { state.loading = null; }
}

async function selectDirector(id) {
  if (window.matchMedia(NARROW_VIEW_QUERY).matches) setInspectorOpen(false);
  state.selectedId = id;
  state.board = [];
  state.boardStatus = null;
  state.selection = { type: 'overview', id: null };
  state.taskDetail = null;
  state.taskTrace = null;
  state.taskError = null;
  state.taskTraceError = null;
  state.taskLoadedAt = 0;
  state.goalDetail = null;
  state.goalDetailId = null;
  state.goalDetailError = null;
  state.goalDetailErrorId = null;
  state.goalDetailLoadedAt = 0;
  state.interventionDraft = '';
  state.interventionReceipt = null;
  state.decisionDraft = '';
  state.decisionOption = '';
  state.decisionGoalId = null;
  state.decisionError = null;
  state.rawLogOpen = null;
  renderAll();
  await loadBoard();
  renderAll();
  void refreshSelectedGoalDetail({ force: true });
}

function selectTrace(type, id = null) {
  const opener = activeElementIdentity();
  state.selection = { type, id };
  renderTrace();
  renderInspector({ force: true });
  restoreActiveElement(opener);
  if (window.matchMedia(NARROW_VIEW_QUERY).matches) setInspectorOpen(true, opener);
}

async function selectTask(taskId) {
  const opener = activeElementIdentity();
  const changedTask = state.selection.type !== 'task' || state.selection.id !== taskId;
  state.selection = { type: 'task', id: taskId };
  state.taskDetail = null;
  state.taskTrace = null;
  state.taskError = null;
  state.taskTraceError = null;
  state.taskLoadedAt = 0;
  if (changedTask) {
    state.interventionDraft = '';
    state.interventionReceipt = null;
    state.rawLogOpen = null;
  }
  renderTrace();
  renderInspector({ force: true });
  restoreActiveElement(opener);
  if (window.matchMedia(NARROW_VIEW_QUERY).matches) setInspectorOpen(true, opener);
  await refreshSelectedTask({ force: true });
}

async function sendIntervention() {
  const input = $('worker-intervention-input');
  const message = input?.value.trim();
  if (!message || state.selection.type !== 'task') return;
  const taskId = state.selection.id;
  const button = $('owner-inspector').querySelector('[data-send-intervention]');
  if (!button || button.disabled || state.busyActions.has(`intervention:${taskId}`)) return;
  try {
    const result = await withBusy(button, '접수 중…', () => api(`/api/directors/${encodeURIComponent(state.selectedId)}/tasks/${encodeURIComponent(taskId)}/interventions`, {
      method: 'POST', body: JSON.stringify({ message }),
    }), `intervention:${taskId}`);
    input.value = '';
    state.interventionDraft = '';
    state.interventionReceipt = { taskId, at: result?.at || new Date().toISOString(), status: 'accepted/queued' };
    toast('Owner 지시가 accepted / queued 상태로 기록됐습니다. Worker 반영은 다음 동기화에서 확인하세요.', 'success');
    state.taskLoadedAt = 0;
    await refreshSelectedTask({ force: true });
  } catch (error) { toast(error.message, 'error'); }
  finally { renderInspector({ force: true }); }
}

async function controlWorker(action) {
  if (state.selection.type !== 'task') return;
  const taskId = state.selection.id;
  const button = $('owner-inspector').querySelector(`[data-worker-control="${action}"]`);
  if (!button || button.disabled || state.busyActions.has(`control:${taskId}`)) return;
  const label = action === 'pause' ? '일시정지' : '재개';
  try {
    await withBusy(button, '처리 중…', () => api(`/api/directors/${encodeURIComponent(state.selectedId)}/tasks/${encodeURIComponent(taskId)}/control`, {
      method: 'POST', body: JSON.stringify({ action, reason: `Owner가 Praetorium에서 ${label}했습니다.` }),
    }), `control:${taskId}`);
    toast(`Worker ${label} 요청을 적용했습니다.`, 'success');
    state.taskLoadedAt = 0;
    await loadConsole({ quiet: true });
    await refreshSelectedTask({ force: true });
  } catch (error) { toast(error.message, 'error'); }
  finally { renderInspector({ force: true }); }
}

async function sendMessage() {
  const input = $('owner-message-input');
  const prompt = input.value.trim();
  const button = $('owner-send-btn');
  if (!prompt || button.disabled || state.busyActions.has('send-message')) return;
  try {
    await withBusy(button, '전송 중…', () => api(`/api/directors/${encodeURIComponent(state.selectedId)}/messages`, {
      method: 'POST', body: JSON.stringify({ prompt, mode: $('owner-message-mode').value }),
    }), 'send-message');
    input.value = '';
    state.selection = { type: 'analysis', id: null };
    await loadConsole({ quiet: true });
  } catch (error) { toast(error.message, 'error'); }
  finally { renderMissionHeader(); }
}

async function dispatchNow() {
  const button = $('owner-dispatch-btn');
  if (button.disabled || state.busyActions.has('dispatch')) return;
  try {
    const result = await withBusy(button, 'Worker 시작 중…', () => api(`/api/directors/${encodeURIComponent(state.selectedId)}/dispatch`, { method: 'POST', body: '{}' }), 'dispatch');
    toast(`Worker ${result.spawned ?? 0}개를 시작했습니다.`, 'success');
    await loadConsole({ quiet: true });
  } catch (error) { toast(error.message, 'error'); }
  finally { renderMissionHeader(); }
}

function renderProjects() {
  $('project-capacity').textContent = state.projectsLoaded ? `${state.projects.length} / ${MAX_PROJECTS}` : `— / ${MAX_PROJECTS}`;
  if (state.projectsError) {
    $('project-list').innerHTML = panelErrorHtml('프로젝트 목록을 불러오지 못했습니다', state.projectsError, 'projects');
    $('add-project-btn').disabled = true;
    $('discover-projects-btn').disabled = true;
    return;
  }
  if (!state.projectsLoaded) {
    $('project-list').innerHTML = '<div class="panel-loading">프로젝트 배정을 불러오는 중입니다.</div>';
    $('add-project-btn').disabled = true;
    $('discover-projects-btn').disabled = true;
    return;
  }
  $('project-list').innerHTML = state.projects.length ? state.projects.map((project, index) => {
    const runtime = state.runtimes.find(item => item.id === (project.runtime === 'wsl' ? `wsl:${project.distro}` : 'windows'));
    const readiness = runtime ? (runtime.ready ? '실행 준비됨' : runtime.error || '런타임 확인 필요') : '런타임 진단 전';
    return `<article class="project-row"><span class="project-slot">${escapeHtml(project.slot || index + 1)}</span><span class="project-row-copy"><span><strong>${escapeHtml(project.name)}</strong><b class="runtime-badge ${project.runtime}">${escapeHtml(runtimeLabel(project))}</b></span><small>${escapeHtml(project.path)}</small><em class="readiness ${runtime?.ready ? 'ready' : 'warning'}">${escapeHtml(readiness)}</em></span><button type="button" data-remove-project="${escapeHtml(project.id)}" aria-label="${escapeHtml(project.name)} 배정 제거">배정 제거</button></article>`;
  }).join('') : '<div class="project-empty"><strong>아직 연결된 프로젝트가 없습니다.</strong><span>실행 환경과 절대 경로를 확인한 뒤 첫 Director에 연결하세요.</span><button type="button" class="secondary-button" data-focus-project-editor>첫 프로젝트 연결</button></div>';
  document.querySelectorAll('[data-remove-project]').forEach(button => button.addEventListener('click', () => removeProject(button.dataset.removeProject)));
  document.querySelector('[data-focus-project-editor]')?.addEventListener('click', () => {
    document.querySelector('.project-editor')?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' });
    $('project-runtime').focus();
  });
  $('add-project-btn').disabled = state.projects.length >= MAX_PROJECTS;
  $('discover-projects-btn').disabled = state.projects.length >= MAX_PROJECTS;
  syncProjectForm();
}

async function loadProjects() {
  state.projectsLoaded = false;
  state.projectsError = null;
  renderProjects();
  try {
    state.projects = await api('/api/projects');
    state.projectsLoaded = true;
  } catch (error) {
    state.projects = [];
    state.projectsError = error.message;
    throw error;
  } finally { renderProjects(); }
}

function usableWslTargets() {
  return state.runtimes.filter(target => target.kind === 'wsl' && !target.system);
}

function syncProjectForm({ resetValidation = false } = {}) {
  const runtime = $('project-runtime').value;
  const wsl = runtime === 'wsl';
  $('project-distro-field').hidden = !wsl;
  $('project-distro').disabled = !wsl;
  $('project-path').placeholder = wsl ? '/home/owner/projects/praetorium' : 'C:\\projects\\praetorium';
  if (resetValidation || $('project-path').getAttribute('aria-invalid') !== 'true') {
    $('project-path-help').textContent = wsl ? '선택한 배포판 안에서 존재하는 Linux 절대 경로를 입력하세요.' : 'Windows에서 존재하는 폴더를 입력하세요.';
  }
  if (resetValidation) $('project-path').removeAttribute('aria-invalid');
  const target = state.runtimes.find(item => item.id === (wsl ? `wsl:${$('project-distro').value}` : 'windows'));
  const fallbackRoot = wsl ? `${target?.home || '/home/owner'}/projects` : 'C:\\projects';
  $('discovery-root').placeholder = fallbackRoot;
  const selectedRoot = $('discovery-root').value || fallbackRoot;
  $('discovery-target').textContent = `검색 대상: ${wsl ? `WSL · ${$('project-distro').value || '배포판 선택 필요'}` : 'Windows'} · ${selectedRoot} · 발견 즉시 빈 슬롯에 연결`;
}

function projectPayload() {
  return {
    name: $('project-name').value.trim(),
    path: $('project-path').value,
    runtime: $('project-runtime').value,
    distro: $('project-runtime').value === 'wsl' ? $('project-distro').value : null,
  };
}

async function withBusy(button, label, action, key = button?.id || label) {
  if (!button || button.disabled || state.busyActions.has(key)) return;
  const previous = button.innerHTML;
  state.busyActions.add(key);
  button.disabled = true;
  button.textContent = label;
  try { return await action(); }
  finally {
    state.busyActions.delete(key);
    if (button.isConnected) {
      button.disabled = false;
      button.innerHTML = previous;
    }
  }
}

async function validateProject() {
  const payload = projectPayload();
  if (!payload.path || (payload.runtime === 'wsl' && !payload.distro)) return toast('실행 환경과 절대 경로를 입력하세요.', 'error');
  try {
    const result = await withBusy($('validate-project-btn'), '확인 중…', () => api('/api/projects/validate', {
      method: 'POST', body: JSON.stringify(payload), timeoutMs: 30000,
    }));
    $('project-path').value = result.path;
    $('project-path').removeAttribute('aria-invalid');
    if (!$('project-name').value && result.name) $('project-name').value = result.name;
    $('project-path-help').textContent = result.git ? '경로와 Git 저장소를 확인했습니다.' : '경로를 확인했습니다. Git 저장소는 아니지만 연결할 수 있습니다.';
    toast('프로젝트 경로를 확인했습니다.', 'success');
  } catch (error) {
    $('project-path').setAttribute('aria-invalid', 'true');
    $('project-path-help').textContent = error.message;
    toast(error.message, 'error');
  }
}

async function addProject() {
  const payload = projectPayload();
  if (!payload.name || !payload.path) return toast('이름과 절대 경로를 입력하세요.', 'error');
  if (payload.runtime === 'wsl' && !payload.distro) return toast('WSL 배포판을 선택하세요.', 'error');
  try {
    await withBusy($('add-project-btn'), '연결 중…', () => api('/api/projects', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 30000 }));
    $('project-name').value = '';
    $('project-path').value = '';
    await Promise.all([loadProjects(), loadConsole({ quiet: true })]);
    toast(`${runtimeLabel(payload)} 프로젝트를 Project Director에 연결했습니다.`, 'success');
  } catch (error) { toast(error.message, 'error'); }
}

async function removeProject(id) {
  const project = state.projects.find(item => item.id === id);
  if (!project || !window.confirm(`${project.name}의 Director 배정만 제거할까요? 프로젝트 파일과 Git 상태는 변경하지 않습니다.`)) return;
  try {
    await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await Promise.all([loadProjects(), loadConsole({ quiet: true })]);
    toast('프로젝트 배정을 제거했습니다.', 'success');
  } catch (error) { toast(error.message, 'error'); }
}

async function discoverProjects() {
  const runtime = $('project-runtime').value;
  const payload = {
    runtime,
    distro: runtime === 'wsl' ? $('project-distro').value : null,
    root: $('discovery-root').value || null,
  };
  if (runtime === 'wsl' && !payload.distro) return toast('검색할 WSL 배포판을 선택하세요.', 'error');
  try {
    const result = await withBusy($('discover-projects-btn'), '검색 중…', () => api('/api/projects/discover', {
      method: 'POST', body: JSON.stringify(payload), timeoutMs: 45000,
    }));
    await Promise.all([loadProjects(), loadConsole({ quiet: true })]);
    toast(result.added ? `${result.added}개 프로젝트를 자동 배정했습니다.` : '추가할 프로젝트를 찾지 못했습니다.', result.added ? 'success' : 'info');
  } catch (error) { toast(error.message, 'error'); }
}

function renderRuntimes() {
  $('runtime-count').textContent = state.runtimesLoaded ? String(state.runtimes.filter(target => !target.system).length) : '—';
  if (state.runtimesError) {
    $('runtime-list').innerHTML = panelErrorHtml('런타임 진단에 실패했습니다', state.runtimesError, 'runtimes');
    return;
  }
  if (!state.runtimesLoaded) {
    $('runtime-list').innerHTML = '<div class="panel-loading">Windows와 WSL 런타임을 진단하는 중입니다.</div>';
    return;
  }
  $('runtime-list').innerHTML = state.runtimes.length ? state.runtimes.map(target => {
    const profileTotal = state.profilesLoaded ? state.profiles.length : '—';
    const profileCount = state.profilesLoaded ? target.profiles?.filter(name => state.profiles.some(profile => profile.id === name)).length || 0 : '—';
    const system = target.system ? '<span class="runtime-system">시스템 배포판</span>' : '';
    const codex = target.codex?.version ? `${target.codex.version} · ${target.codex.authenticated ? '로그인됨' : '로그인 필요'}` : '설치되지 않음';
    return `<article class="runtime-row ${target.ready ? 'ready' : 'warning'}"><div class="runtime-state"><i></i><span>${target.ready ? '준비됨' : target.system ? '시스템' : '설정 필요'}</span></div><div class="runtime-copy"><header><h4>${escapeHtml(target.label)}</h4>${system}</header><p>${escapeHtml(target.error || 'Praetorium 실행 요구사항을 모두 충족합니다.')}</p><dl><div><dt>Hermes</dt><dd>${escapeHtml(target.hermes?.version || '설치되지 않음')}</dd></div><div><dt>Codex</dt><dd>${escapeHtml(codex)}</dd></div><div><dt>역할</dt><dd>${profileCount} / ${profileTotal}</dd></div></dl></div>${target.kind === 'wsl' && !target.ready && !target.system && target.setupCommand ? `<button type="button" class="secondary-button" data-runtime-setup="${escapeHtml(target.id)}">준비 방법</button>` : ''}</article>`;
  }).join('') : '<div class="project-empty"><strong>진단 가능한 런타임이 없습니다.</strong><span>Windows에서 WSL2 배포판이 설치되어 있는지 확인하세요.</span></div>';
  const guidedTarget = state.runtimes.find(target => target.id === state.runtimeGuideId);
  if (!guidedTarget || guidedTarget.ready || !guidedTarget.setupCommand) {
    state.runtimeGuideId = null;
    $('runtime-guide').hidden = true;
  }
  document.querySelectorAll('[data-runtime-setup]').forEach(button => button.addEventListener('click', () => showRuntimeGuide(button.dataset.runtimeSetup)));
  renderProjects();
  renderProfiles();
}

const PROFILE_KIND_LABELS = {
  orchestrate: '지휘', write: '구현·수정', review: '전문 검토', gate: '품질 판정',
};

function accessLabel(access) {
  return access === 'read-only' ? '읽기 전용' : access === 'workspace-write' ? '파일 변경 가능' : access;
}

function profileContract(profile) {
  if (profile.group === 'director') return {
    trigger: 'Owner가 목표나 질문을 보낼 때',
    responsibility: '요구 분석, 실행 플로우 선택, Worker 작업과 완료 기준 설계',
    next: '작업 보드에 실행 묶음을 만들고 Worker에 넘김',
  };
  if (profile.id === 'codex-implementer') return {
    trigger: 'Director가 범위와 완료 기준이 있는 구현 작업을 배정할 때',
    responsibility: '허용된 작업공간에서 구현하고 테스트·변경 근거 기록',
    next: '결과를 보드에 남겨 후속 리뷰가 이어받음',
  };
  if (profile.id === 'remediator') return {
    trigger: '전문 리뷰가 현재 리비전에 수정 지적을 남겼을 때',
    responsibility: '해당 지적 범위만 수정하고 회귀 근거 기록',
    next: '영향받은 리뷰와 품질 판정이 다시 확인',
  };
  if (profile.kind === 'gate') return {
    trigger: '구현과 필요한 리뷰 근거가 모였을 때',
    responsibility: '현재 후보 리비전의 근거만으로 진행 또는 중단 판정',
    next: '판정과 부족한 근거를 보드에 기록',
  };
  return {
    trigger: 'Director가 작업 위험에 맞춰 전문 검토를 배정할 때',
    responsibility: '파일을 바꾸지 않고 현재 리비전의 결함과 근거 검토',
    next: '통과 또는 수정 지적을 보드에 기록',
  };
}

function showRuntimeGuide(id) {
  const target = state.runtimes.find(item => item.id === id);
  if (!target?.setupCommand) return;
  state.runtimeGuideId = id;
  $('runtime-guide').hidden = false;
  $('runtime-guide-copy').textContent = `${target.label} 터미널에서 아래 두 명령을 순서대로 실행하면 고정 버전과 Praetorium 역할 프로필을 준비합니다.`;
  $('runtime-setup-command').textContent = target.setupCommand;
  $('runtime-guide').scrollIntoView({ behavior: preferredScrollBehavior(), block: 'nearest' });
}

async function loadRuntimes({ force = false } = {}) {
  const requestId = ++state.runtimeRequestId;
  state.runtimeGuideId = null;
  $('runtime-guide').hidden = true;
  state.runtimesLoaded = false;
  state.runtimesError = null;
  renderRuntimes();
  try {
    const result = await api(`/api/runtimes${force ? '?force=true' : ''}`, { timeoutMs: 60000 });
    if (requestId !== state.runtimeRequestId) return;
    state.runtimes = result.targets || [];
    state.runtimesLoaded = true;
    const distro = $('project-distro');
    const selected = distro.value;
    distro.innerHTML = usableWslTargets().map(target => `<option value="${escapeHtml(target.distro)}">${escapeHtml(target.distro)}${target.ready ? ' · 준비됨' : ' · 설정 필요'}</option>`).join('');
    if (usableWslTargets().some(target => target.distro === selected)) distro.value = selected;
    $('project-runtime').querySelector('option[value="wsl"]').disabled = !usableWslTargets().length;
    syncProjectForm();
  } catch (error) {
    if (requestId !== state.runtimeRequestId) return;
    state.runtimes = [];
    state.runtimesError = error.message;
    throw error;
  } finally {
    if (requestId === state.runtimeRequestId) renderRuntimes();
  }
}

function renderProfiles() {
  const activeElement = activeElementIdentity();
  $('profile-count').textContent = state.profilesLoaded ? String(state.profiles.length) : '—';
  if (state.profilesError) {
    $('profile-list').innerHTML = panelErrorHtml('역할 프로필을 불러오지 못했습니다', state.profilesError, 'profiles');
    $('profile-detail').innerHTML = '';
    return;
  }
  if (!state.profilesLoaded) {
    $('profile-list').innerHTML = '<div class="panel-loading">역할 프로필을 불러오는 중입니다.</div>';
    $('profile-detail').innerHTML = '';
    return;
  }
  if (!state.profiles.length) {
    $('profile-list').innerHTML = '<div class="project-empty"><strong>설치된 역할 프로필이 없습니다.</strong></div>';
    $('profile-detail').innerHTML = '';
    return;
  }
  if (!state.selectedProfileId || !state.profiles.some(profile => profile.id === state.selectedProfileId)) state.selectedProfileId = state.profiles[0].id;
  const groupNames = { director: '지휘', worker: '구현·수정', review: '검토·품질 판정' };
  $('profile-list').innerHTML = Object.entries(groupNames).map(([group, label]) => {
    const profiles = state.profiles.filter(profile => profile.group === group);
    return `<section><h4>${label}</h4>${profiles.map(profile => `<button type="button" class="profile-row ${profile.id === state.selectedProfileId ? 'active' : ''}" data-profile="${escapeHtml(profile.id)}" aria-pressed="${profile.id === state.selectedProfileId}"><span><strong>${escapeHtml(profile.label)}</strong><small>${escapeHtml(profile.id)}</small></span><b>${escapeHtml(accessLabel(profile.access))}</b></button>`).join('')}</section>`;
  }).join('');
  document.querySelectorAll('[data-profile]').forEach(button => button.addEventListener('click', () => {
    state.selectedProfileId = button.dataset.profile;
    renderProfiles();
    if (window.matchMedia(NARROW_VIEW_QUERY).matches) requestAnimationFrame(() => $('profile-detail').scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' }));
  }));
  const profile = state.profiles.find(item => item.id === state.selectedProfileId);
  const contract = profileContract(profile);
  const installations = state.runtimes.filter(target => !target.system).map(target => `<li><span>${escapeHtml(target.label)}</span><b class="readiness ${target.profiles?.includes(profile.id) ? 'ready' : 'warning'}">${target.profiles?.includes(profile.id) ? '설치됨' : '없음'}</b></li>`).join('');
  $('profile-detail').innerHTML = `<header><div><h3>${escapeHtml(profile.label)}</h3><code>${escapeHtml(profile.id)}</code></div><span class="access-badge ${profile.access === 'read-only' ? 'readonly' : 'write'}">${escapeHtml(accessLabel(profile.access))}</span></header><p>${escapeHtml(profile.description)}</p><section class="role-contract"><h4>실행 계약</h4><dl><div><dt>시작 시점</dt><dd>${escapeHtml(contract.trigger)}</dd></div><div><dt>책임</dt><dd>${escapeHtml(contract.responsibility)}</dd></div><div><dt>다음 단계</dt><dd>${escapeHtml(contract.next)}</dd></div></dl></section><dl class="profile-spec"><div><dt>모델</dt><dd>${escapeHtml(profile.model)}</dd></div><div><dt>추론 강도</dt><dd>${escapeHtml(profile.reasoning)}</dd></div><div><dt>기본 스킬</dt><dd>${escapeHtml(profile.skill || '작업에서 지정')}</dd></div><div><dt>역할 유형</dt><dd>${escapeHtml(PROFILE_KIND_LABELS[profile.kind] || profile.kind)}</dd></div></dl><section><h4>런타임 설치 상태</h4><ul>${installations || '<li><span>런타임 탭에서 진단할 수 있습니다.</span></li>'}</ul></section>`;
  restoreActiveElement(activeElement);
}

const SKILL_GROUPS = [
  ['지휘·인계', ['project-director', 'context-handoff', 'skill-director']],
  ['전문 검토', ['convention-review', 'security-review', 'adversarial-review', 'test-gap-review', 'architecture-review', 'performance-review']],
  ['수정·출시', ['remediate-findings', 'release-readiness', 'quality-gate']],
];

function skillUsers(skillId) {
  const workers = Object.entries(state.summary?.workerProfiles || {})
    .filter(([, profile]) => profile.skill === skillId)
    .map(([, profile]) => profile.label);
  if (skillId === 'project-director') workers.unshift('Project Director 1–3');
  if (skillId === 'skill-director') workers.unshift('Skill Director');
  return workers;
}

function renderSkills() {
  const activeElement = activeElementIdentity();
  const skills = state.summary?.skills || {};
  const ids = Object.keys(skills);
  $('skill-count').textContent = String(ids.length);
  if (!ids.length) {
    $('skill-list').innerHTML = '<div class="project-empty"><strong>등록된 운영 스킬이 없습니다.</strong></div>';
    $('skill-detail').innerHTML = '';
    return;
  }
  if (!state.selectedSkillId || !skills[state.selectedSkillId]) state.selectedSkillId = ids[0];
  $('skill-list').innerHTML = SKILL_GROUPS.map(([label, groupIds]) => {
    const available = groupIds.filter(id => skills[id]);
    if (!available.length) return '';
    return `<section><h4>${label}</h4>${available.map(id => `<button type="button" class="skill-row ${id === state.selectedSkillId ? 'active' : ''}" data-skill="${escapeHtml(id)}" aria-pressed="${id === state.selectedSkillId}"><span><strong>${escapeHtml(id)}</strong><small>${escapeHtml(skills[id])}</small></span><b>→</b></button>`).join('')}</section>`;
  }).join('');
  document.querySelectorAll('[data-skill]').forEach(button => button.addEventListener('click', () => {
    state.selectedSkillId = button.dataset.skill;
    renderSkills();
    if (window.matchMedia(NARROW_VIEW_QUERY).matches) requestAnimationFrame(() => $('skill-detail').scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' }));
  }));
  const users = skillUsers(state.selectedSkillId);
  $('skill-detail').innerHTML = `<header><div><h3>${escapeHtml(state.selectedSkillId)}</h3><code>운영 절차</code></div><span class="access-badge readonly">재사용</span></header><p>${escapeHtml(skills[state.selectedSkillId])}</p><section><h4>기본 사용 역할</h4>${users.length ? listHtml(users) : '<p class="detail-empty">고정 프로필 없이 Director가 필요한 작업에 지정합니다.</p>'}</section><section><h4>적용 방식</h4><p>프로필의 기본 스킬로 적용되거나, Director가 Worker 작업을 만들 때 필요한 스킬만 지정합니다.</p></section>`;
  restoreActiveElement(activeElement);
}

async function loadProfiles() {
  state.profilesLoaded = false;
  state.profilesError = null;
  renderProfiles();
  try {
    state.profiles = await api('/api/profiles');
    state.profilesLoaded = true;
  } catch (error) {
    state.profiles = [];
    state.profilesError = error.message;
    throw error;
  } finally {
    if (state.runtimesLoaded) renderRuntimes();
    else renderProfiles();
  }
}

function setManagementTab(tab) {
  state.managementTab = tab;
  setManagementFeedback();
  document.querySelectorAll('[data-management-tab]').forEach(button => {
    const active = button.dataset.managementTab === tab;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('[data-management-panel]').forEach(panel => {
    const active = panel.dataset.managementPanel === tab;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  const body = document.querySelector('.management-body');
  if (body) body.scrollTop = 0;
  if ($('project-dialog').open) void loadManagementTab(tab).catch(() => {});
}

async function loadManagementTab(tab, { force = false } = {}) {
  if (tab === 'skills') {
    renderSkills();
    return;
  }
  if (!force && ((tab === 'projects' && state.projectsLoaded && state.runtimesLoaded) || (tab === 'runtimes' && state.runtimesLoaded) || (tab === 'roles' && state.profilesLoaded))) return;
  if (state.managementLoads[tab]) return state.managementLoads[tab];
  const loaders = {
    projects: async () => {
      await loadProjects();
      if (!state.runtimesLoaded) await loadRuntimes();
    },
    runtimes: () => loadRuntimes({ force }),
    roles: loadProfiles,
  };
  const loader = loaders[tab];
  if (!loader) return;
  state.managementLoads[tab] = loader().catch(error => {
    if (state.managementTab === tab) setManagementFeedback(error.message, 'error');
    throw error;
  }).finally(() => { delete state.managementLoads[tab]; });
  return state.managementLoads[tab];
}

function openManagement(tab = 'projects') {
  setManagementFeedback();
  if (!$('project-dialog').open) $('project-dialog').showModal();
  setManagementTab(tab);
}

function initTheme() {
  const saved = localStorage.getItem('praetorium-theme') || 'dark';
  const apply = theme => {
    document.documentElement.dataset.theme = theme;
    const nextLabel = theme === 'light' ? '다크 테마로 전환' : '라이트 테마로 전환';
    $('theme-toggle').setAttribute('aria-label', nextLabel);
    $('theme-toggle').title = nextLabel;
  };
  apply(saved);
  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    apply(next);
    localStorage.setItem('praetorium-theme', next);
  });
}

function initScale() {
  let scale = Math.max(.9, Math.min(1.25, Number(localStorage.getItem('praetorium-scale')) || 1));
  const apply = () => {
    document.documentElement.style.setProperty('--ui-scale', scale);
    localStorage.setItem('praetorium-scale', String(scale));
    const percent = Math.round(scale * 100);
    $('text-scale-down').disabled = scale <= .9;
    $('text-scale-up').disabled = scale >= 1.25;
    $('text-scale-down').title = `현재 ${percent}% · 글자 작게`;
    $('text-scale-up').title = `현재 ${percent}% · 글자 크게`;
  };
  $('text-scale-down').addEventListener('click', () => { scale = Math.max(.9, +(scale - .05).toFixed(2)); apply(); });
  $('text-scale-up').addEventListener('click', () => { scale = Math.min(1.25, +(scale + .05).toFixed(2)); apply(); });
  apply();
}

function setInspectorOpen(open, opener = activeElementIdentity(), restoreFocus = true) {
  if (document.body.classList.contains('inspector-open') === open) return;
  if (open) state.inspectorOpener = opener;
  document.body.classList.toggle('inspector-open', open);
  $('inspector-toggle').setAttribute('aria-expanded', String(open));
  [document.querySelector('.topbar'), document.querySelector('.project-sidebar'), document.querySelector('.mission-pane')]
    .filter(Boolean).forEach(element => { element.inert = open; });
  if (open) requestAnimationFrame(() => $('inspector-close')?.focus?.());
  else if (restoreFocus) requestAnimationFrame(() => {
    const target = elementFromIdentity(state.inspectorOpener) || $('inspector-toggle');
    state.inspectorOpener = null;
    target?.focus?.({ preventScroll: true });
  });
  else state.inspectorOpener = null;
}

function activeScrollSurface() {
  if ($('project-dialog').open) return $('project-dialog').querySelector('.management-body');
  if ($('focus-dialog').open) return $('focus-dialog-content');
  if ($('workflow-dialog').open) return $('owner-workflow-list');
  if (document.activeElement?.closest('.command-pane') || document.body.classList.contains('inspector-open')) return document.querySelector('.inspector-scroll');
  return document.querySelector('.mission-pane');
}

function init() {
  initTheme();
  initScale();
  $('owner-send-btn').addEventListener('click', sendMessage);
  $('owner-message-mode').addEventListener('change', renderMissionHeader);
  $('owner-message-input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
  });
  $('owner-refresh-btn').addEventListener('click', () => loadConsole());
  $('owner-dispatch-btn').addEventListener('click', dispatchNow);
  document.querySelectorAll('[data-trace-filter]').forEach(button => button.addEventListener('click', () => {
    const category = button.dataset.traceFilter;
    if (state.traceFilters.has(category)) state.traceFilters.delete(category);
    else state.traceFilters.add(category);
    renderTrace();
  }));
  $('workflow-library-btn').addEventListener('click', () => $('workflow-dialog').showModal());
  $('project-settings-btn').addEventListener('click', () => openManagement('projects'));
  $('inspector-expand').addEventListener('click', () => openFocus($('inspector-title').textContent));
  $('inspector-toggle').addEventListener('click', () => setInspectorOpen(!document.body.classList.contains('inspector-open')));
  $('inspector-close').addEventListener('click', () => setInspectorOpen(false));
  $('add-project-btn').addEventListener('click', addProject);
  $('validate-project-btn').addEventListener('click', validateProject);
  $('discover-projects-btn').addEventListener('click', discoverProjects);
  $('project-runtime').addEventListener('change', () => syncProjectForm({ resetValidation: true }));
  $('project-distro').addEventListener('change', () => syncProjectForm({ resetValidation: true }));
  $('project-path').addEventListener('input', () => syncProjectForm({ resetValidation: true }));
  $('discovery-root').addEventListener('input', () => syncProjectForm());
  $('refresh-runtimes-btn').addEventListener('click', () => withBusy($('refresh-runtimes-btn'), '진단 중…', () => loadRuntimes({ force: true })).catch(error => toast(error.message, 'error')));
  $('copy-runtime-command').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('runtime-setup-command').textContent); toast('WSL 준비 명령을 복사했습니다.', 'success'); }
    catch { toast('클립보드에 복사하지 못했습니다. 명령을 직접 선택해 복사하세요.', 'error'); }
  });
  document.querySelectorAll('[data-management-tab]').forEach(button => button.addEventListener('click', () => setManagementTab(button.dataset.managementTab)));
  $('project-dialog').addEventListener('click', event => {
    const button = event.target.closest('[data-retry-management]');
    if (!button) return;
    const tab = button.dataset.retryManagement === 'profiles' ? 'roles' : button.dataset.retryManagement;
    void withBusy(button, '다시 시도 중…', () => loadManagementTab(tab, { force: true }), `management:${tab}`).catch(error => setManagementFeedback(error.message, 'error'));
  });
  $('project-dialog').addEventListener('close', () => setManagementFeedback());
  $('project-dialog').querySelector('.management-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const tabs = [...document.querySelectorAll('[data-management-tab]')];
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const next = tabs[(current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    setManagementTab(next.dataset.managementTab);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.querySelector('dialog[open]')) return;
    if (event.altKey && (event.key === 'End' || event.key === 'Home')) {
      event.preventDefault();
      const surface = activeScrollSurface();
      surface?.scrollTo({ top: event.key === 'End' ? surface.scrollHeight : 0, behavior: preferredScrollBehavior() });
    } else if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
      event.preventDefault(); $('owner-message-input').focus();
    } else if (event.key.toLowerCase() === 'r' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
      void loadConsole();
    } else if (event.key === 'Escape' && document.body.classList.contains('inspector-open')) {
      setInspectorOpen(false);
    } else if (event.key === 'Escape' && state.selection.type !== 'overview' && !$('focus-dialog').open) {
      state.selection = { type: 'overview', id: null }; renderTrace(); renderInspector({ force: true });
    }
  });
  document.addEventListener('click', event => {
    if (event.target.closest('[data-open-projects]')) openManagement('projects');
    if (event.target.closest('[data-retry-board]')) void loadConsole();
  });
  window.matchMedia(NARROW_VIEW_QUERY).addEventListener('change', event => {
    if (!event.matches && document.body.classList.contains('inspector-open')) setInspectorOpen(false, null, false);
  });
  void loadConsole();
  state.timer = setInterval(() => loadConsole({ quiet: true }), POLL_INTERVAL_MS);
}

init();

export const _test = { statusLabel, traceStatus, sectionFromBody };
