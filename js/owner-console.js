const MAX_PROJECTS = 3;
const POLL_INTERVAL_MS = 3000;
const TASK_POLL_INTERVAL_MS = 2800;

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
  managementTab: 'projects',
  selectedId: 'project-director-1',
  board: [],
  boardStatus: null,
  selection: { type: 'overview', id: null },
  taskDetail: null,
  taskTrace: null,
  taskLoading: false,
  taskLoadedAt: 0,
  inspectorRenderKey: null,
  inspectorOpener: null,
  interventionDraft: '',
  rawLogOpen: null,
  consoleError: null,
  loading: null,
  timer: null,
};

const $ = id => document.getElementById(id);

const FOCUS_KEYS = [
  'data-director', 'data-select-trace', 'data-select-task', 'data-attention-task', 'data-profile',
  'data-worker-control', 'data-send-intervention', 'data-raw-worker-log-summary', 'data-retry-board',
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
  return `<div class="project-empty" role="alert"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span><button type="button" class="secondary-button" data-retry-management="${escapeHtml(target)}">다시 시도</button></div>`;
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
    delegated: 'Worker 실행', completed: '완료', failed: '실패',
  })[phase] || phase || '대기';
}

function statusLabel(status) {
  return ({
    idle: '대기', running: '실행 중', unassigned: '미배정', error: '확인 필요',
    ready: '실행 대기', todo: '선행 작업 대기', review: '리뷰 중', blocked: 'Owner 판단',
    done: '완료', archived: '보관', scheduled: '일시정지', failed: '실패', queued: '대기',
  })[status] || status || '대기';
}

function runtimeLabel(value) {
  return value?.runtime === 'wsl' || value?.kind === 'wsl'
    ? `WSL · ${value.distro || '배포판 미지정'}`
    : 'Windows';
}

function traceStatus(status) {
  if (['done', 'completed', 'archived', 'delegated'].includes(status)) return 'done';
  if (['running', 'analyzing', 'directing', 'materializing', 'dispatching'].includes(status)) return 'running';
  if (['blocked', 'review', 'failed', 'error'].includes(status)) return status === 'failed' || status === 'error' ? 'failed' : 'blocked';
  if (['ready', 'todo', 'scheduled'].includes(status)) return status === 'scheduled' ? 'blocked' : 'ready';
  return 'queued';
}

function toast(message, kind = 'info') {
  const root = $('toast');
  root.textContent = message;
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

function latestRun() {
  return selectedRuns()[0] || null;
}

function workflowFor(id) {
  return (state.summary?.workflows || []).find(workflow => workflow.id === id) || null;
}

function actionForTask(taskId) {
  for (const run of selectedRuns()) {
    const action = (run.actions || []).find(item => item.taskId === taskId);
    if (action) return action;
  }
  return null;
}

function taskForAction(action) {
  return state.board.find(task => task.id === action.taskId) || null;
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

function openFocus(title) {
  $('focus-dialog-title').textContent = title;
  const copy = $('owner-inspector').cloneNode(true);
  copy.querySelectorAll('.worker-control').forEach(element => element.remove());
  copy.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
  $('focus-dialog-content').replaceChildren(...copy.childNodes);
  $('focus-dialog').showModal();
}

function renderTopbar() {
  const director = selectedDirector();
  const sessions = state.summary?.sessions || { total: 0 };
  $('active-project-name').textContent = director?.kind === 'skill' ? 'Skill governance' : (director?.name || 'Project').replace(/ Director$/, '');
  $('active-project-path').textContent = director?.cwd || '프로젝트 미배정';
  const runtimeBadge = $('mission-runtime-badge');
  runtimeBadge.textContent = runtimeLabel(director).toUpperCase();
  runtimeBadge.className = `runtime-badge ${director?.runtime === 'wsl' ? 'wsl' : 'windows'}`;
  const sessionSignal = $('session-count');
  sessionSignal.className = `signal ${sessions.total ? 'active' : 'idle'}`;
  const sessionLabel = sessions.total
    ? `${sessions.total} 실행 중 · D${sessions.directors || 0} W${sessions.workers || 0}`
    : '실행 대기';
  if (sessionSignal.lastElementChild.textContent !== sessionLabel) sessionSignal.lastElementChild.textContent = sessionLabel;
  const accessibleSessionLabel = sessions.total ? sessionLabel : '실행 중인 세션 없음';
  if (sessionSignal.getAttribute('aria-label') !== accessibleSessionLabel) sessionSignal.setAttribute('aria-label', accessibleSessionLabel);
  $('director-count').textContent = state.summary?.directors?.length || 0;
}

function renderDirectors() {
  const directors = state.summary?.directors || [];
  $('owner-director-list').innerHTML = directors.map(director => {
    const index = director.kind === 'skill' ? 'S' : director.id.split('-').at(-1);
    const subtitle = director.kind === 'skill' ? '공용 역량·워크플로' : (director.projectId ? `${director.projectId} · ${runtimeLabel(director)}` : '프로젝트 미배정');
    const accessibleName = `${director.name}, ${subtitle}, ${statusLabel(director.status)}`;
    return `<button class="director-row ${director.id === state.selectedId ? 'active' : ''}" data-director="${escapeHtml(director.id)}" type="button" aria-label="${escapeHtml(accessibleName)}" data-tooltip="${escapeHtml(accessibleName)}">
      <span class="director-index">${escapeHtml(index)}</span>
      <span class="director-copy"><strong>${escapeHtml(director.name)}</strong><small>${escapeHtml(subtitle)}</small></span>
      <i class="status-dot ${traceStatus(director.status)}" title="${escapeHtml(statusLabel(director.status))}"></i>
    </button>`;
  }).join('');
  document.querySelectorAll('[data-director]').forEach(button => {
    if (button.dataset.director === state.selectedId) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => selectDirector(button.dataset.director));
  });
}

function renderMissionHeader() {
  const director = selectedDirector();
  const run = latestRun();
  const workflow = workflowFor(run?.workflowId);
  const activeTasks = state.board.filter(task => task.status === 'running').length;
  $('mission-board-name').textContent = director?.board || 'BOARD';
  $('mission-run-time').textContent = run ? (run.status === 'running' ? `실행 ${elapsedLabel(run.startedAt)}` : clockLabel(run.completedAt || run.createdAt)) : '대기';
  $('mission-title').textContent = run?.prompt || (director?.cwd ? '새 목표를 기다리고 있습니다' : '프로젝트를 먼저 배정하세요');
  $('mission-subtitle').textContent = run
    ? `${workflow?.name || phaseLabel(run.phase)} · ${run.taskIds?.length || 0}개 작업 · ${activeTasks}개 Worker 실행 중`
    : 'Owner 목표를 보내면 Director 분석부터 Worker 검증까지 이 화면에 실행 흐름이 생깁니다.';
  const canMessage = Boolean(director?.cwd) && director?.status !== 'running';
  $('owner-message-input').disabled = !canMessage;
  $('owner-message-input').placeholder = director?.cwd
    ? (director.status === 'running' ? 'Director가 현재 목표를 분석하고 있습니다…' : '목표, 제약, 완료 기준을 입력하세요…')
    : '먼저 프로젝트를 배정하세요.';
  $('owner-send-btn').disabled = !canMessage;
  $('owner-dispatch-btn').disabled = !director?.cwd || director.kind !== 'project';
}

function currentOperationalTask() {
  const currentIds = new Set(latestRun()?.taskIds || []);
  const tasks = currentIds.size ? state.board.filter(task => currentIds.has(task.id)) : state.board;
  return tasks.find(task => task.status === 'running')
    || tasks.find(task => ['blocked', 'review', 'scheduled'].includes(task.status))
    || tasks.find(task => ['ready', 'todo'].includes(task.status))
    || null;
}

function renderCurrentFocus() {
  const run = latestRun();
  const task = currentOperationalTask();
  let status = 'queued';
  let kicker = 'READY';
  let title = 'Owner의 다음 목표를 기다리는 중';
  let description = '목표를 보내면 Director가 작업 플로우와 Worker 구성을 먼저 공개합니다.';
  let meta = '개입 없음';
  if (state.consoleError) {
    status = 'failed';
    kicker = 'CONNECTION';
    title = '로컬 Praetorium 연결이 끊겼습니다';
    description = state.consoleError;
    meta = '새로고침으로 재시도';
  } else if (task) {
    const action = actionForTask(task.id);
    status = traceStatus(task.status);
    kicker = statusLabel(task.status).toUpperCase();
    title = task.status === 'running'
      ? `${task.assignee || 'Worker'}가 “${task.title}” 수행 중`
      : task.status === 'blocked' || task.status === 'scheduled'
        ? `“${task.title}”에 Owner 판단이 필요함`
        : task.status === 'review' ? `“${task.title}” 리뷰 결과 확인 중` : `“${task.title}” 실행 대기`;
    description = action?.task || sectionFromBody(task.body, 'ACTION') || task.result || '작업 세부 정보를 열어 실행 근거를 확인하세요.';
    meta = `${task.assignee || '미배정'}${task.started_at ? ` · ${elapsedLabel(task.started_at, task.completed_at || Date.now())}` : ''}`;
  } else if (run?.status === 'running') {
    status = 'running';
    kicker = phaseLabel(run.phase).toUpperCase();
    title = run.progressEvents?.at(-1)?.message || 'Director가 목표를 분석하는 중';
    description = run.analysis?.requestSummary || '요구, 위험, 플로우 후보와 Worker 분할을 판단하고 있습니다.';
    meta = `Director · ${elapsedLabel(run.startedAt)}`;
  } else if (run?.taskIds?.length && run.taskIds.every(id => ['done', 'archived'].includes(state.board.find(taskItem => taskItem.id === id)?.status))) {
    status = 'done';
    kicker = 'WAVE COMPLETE';
    title = `${run.taskIds.length}개 작업이 모두 완료됨`;
    description = '실행 trace에서 각 Worker의 결과와 검증 근거를 확인할 수 있습니다.';
    meta = clockLabel(run.completedAt);
  }
  updateHtml($('current-focus'), `<i class="focus-pulse ${status}"></i><div class="focus-copy"><span>${escapeHtml(kicker)}</span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(description)}</small></div><div class="focus-meta"><b>${escapeHtml(meta)}</b></div>`);
  const announcement = `${statusLabel(status)}. ${title}`;
  if ($('status-announcer') && $('status-announcer').textContent !== announcement) $('status-announcer').textContent = announcement;
}

function ownerAttentionTasks() {
  return state.board.filter(task => ['blocked', 'review', 'scheduled'].includes(task.status));
}

function renderOwnerGate() {
  const tasks = ownerAttentionTasks();
  const gate = $('owner-gate');
  gate.hidden = !tasks.length;
  if (!tasks.length) {
    $('attention-section').hidden = true;
    return;
  }
  gate.querySelector('strong').textContent = tasks.length === 1 ? tasks[0].title : `${tasks.length}개 작업에 판단이 필요합니다`;
  $('owner-gate-open').onclick = () => selectTask(tasks[0].id);
  $('attention-section').hidden = false;
  $('owner-attention-list').innerHTML = tasks.map(task => `<button type="button" class="attention-row" data-attention-task="${escapeHtml(task.id)}"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(statusLabel(task.status))} · ${escapeHtml(task.assignee || '미배정')}</span></button>`).join('');
  document.querySelectorAll('[data-attention-task]').forEach(button => button.addEventListener('click', () => selectTask(button.dataset.attentionTask)));
}

function traceNode({ key, kind, title, description, status = 'queued', side = '', tags = [], marker = '·', depth = 0 }) {
  const selected = state.selection.type === key || (key === 'task' && state.selection.type === 'task' && state.selection.id === marker);
  const data = key === 'task' ? `data-select-task="${escapeHtml(marker)}"` : `data-select-trace="${escapeHtml(key)}"`;
  return `<article class="trace-node ${traceStatus(status)} depth-${Math.min(2, depth)} ${selected ? 'selected' : ''}">
    <span class="trace-marker">${key === 'task' ? 'W' : escapeHtml(marker)}</span>
    <div class="trace-body"><button class="trace-button" type="button" ${data} ${selected ? 'aria-current="step"' : ''}>
      <span class="trace-title-row"><strong class="trace-title">${escapeHtml(title)}</strong><small class="trace-kind">${escapeHtml(kind)}</small></span>
      <span class="trace-description">${escapeHtml(description || '세부 정보를 준비하는 중입니다.')}</span>
      ${tags.length ? `<span class="trace-tags">${tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</span>` : ''}
    </button></div>
    <span class="trace-side"><b>${escapeHtml(statusLabel(status))}</b><small>${escapeHtml(side)}</small></span>
  </article>`;
}

function renderTrace() {
  const run = latestRun();
  const root = $('owner-trace-list');
  if (state.boardStatus?.error) {
    root.innerHTML = `<div class="trace-empty" role="alert"><strong>작업 보드를 불러오지 못했습니다</strong><span>${escapeHtml(state.boardStatus.error)}</span><button class="secondary-button" type="button" data-retry-board>다시 시도</button></div>`;
    root.querySelector('[data-retry-board]')?.addEventListener('click', () => loadConsole());
    $('trace-summary').innerHTML = '<span class="blocked"><i></i>보드 오류</span>';
    return;
  }
  if (!run) {
    root.innerHTML = '<div class="trace-empty"><strong>실행 trace가 아직 없습니다</strong><span>아래 입력창에 목표를 보내면 Director의 분석, 계획, Worker 실행과 검증이 시간순으로 표시됩니다.</span></div>';
    $('trace-summary').innerHTML = '<span><i></i>0 nodes</span>';
    return;
  }
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
    status: planStatus, side: `${run.actions?.length || 0} tasks`, tags: run.publicDecisions?.slice(0, 2) || [],
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
  root.querySelectorAll('[data-select-trace]').forEach(button => button.addEventListener('click', () => selectTrace(button.dataset.selectTrace)));
  root.querySelectorAll('[data-select-task]').forEach(button => button.addEventListener('click', () => selectTask(button.dataset.selectTask)));
  const statuses = (run.actions || []).map(action => taskForAction(action)?.status || action.status || 'queued');
  const running = statuses.filter(status => status === 'running').length;
  const blocked = statuses.filter(status => ['blocked', 'review', 'scheduled', 'failed'].includes(status)).length;
  const done = statuses.filter(status => ['done', 'archived'].includes(status)).length;
  $('trace-summary').innerHTML = `<span class="running"><i></i>${running} 실행</span><span><i></i>${done} 완료</span><span class="blocked"><i></i>${blocked} 판단</span>`;
}

function renderOverviewInspector() {
  const director = selectedDirector();
  const run = latestRun();
  $('inspector-title').textContent = 'Director 개요';
  return `<div class="inspector-hero"><h3>${escapeHtml(director?.name || 'Director')}</h3><p>${escapeHtml(director?.cwd || '프로젝트가 배정되지 않았습니다.')}</p><div class="inspector-meta"><span>${escapeHtml(director?.kind === 'skill' ? 'Skill Director' : 'Project Director')}</span><span>${escapeHtml(runtimeLabel(director))}</span><span>${escapeHtml(statusLabel(director?.status))}</span><code>${escapeHtml(director?.board || '')}</code></div></div>
    ${detailGroup('현재 목표', run ? `<p>${formatText(run.prompt)}</p>` : '<p class="detail-empty">새 목표를 기다리는 중입니다.</p>')}
    ${run ? detailGroup('현재 운영 상태', `<p>${escapeHtml(phaseLabel(run.phase))} · ${run.taskIds?.length || 0} tasks · ${elapsedLabel(run.startedAt, run.completedAt || Date.now())}</p>`) : ''}
    ${detailGroup('Owner 개입', '<p>Director 분석·계획과 모든 Worker 실행을 같은 trace에서 선택할 수 있습니다. 실행 중 Worker를 열면 추가 지시와 일시정지 제어가 나타납니다.</p>')}`;
}

function renderObjectiveInspector(run) {
  $('inspector-title').textContent = 'Owner 목표';
  return `<div class="inspector-hero"><h3>${escapeHtml(run?.prompt || '목표 없음')}</h3><p>Director가 이 목표를 성공 조건과 Worker 작업으로 변환합니다.</p><div class="inspector-meta"><span>Owner 목표</span><code>${escapeHtml(run?.id || '')}</code><span>${escapeHtml(clockLabel(run?.createdAt))}</span></div></div>`;
}

function renderAnalysisInspector(run) {
  $('inspector-title').textContent = 'Director 분석';
  const analysis = run?.analysis;
  if (!analysis) return `<div class="inspector-hero"><h3>판단 근거를 구성하는 중</h3><p>요구, 성공 조건, 확인된 근거, 위험과 대안을 공개 체크포인트로 정리합니다.</p><div class="inspector-meta"><span>Director 분석</span></div></div><div class="inspector-loading">${escapeHtml(run?.progressEvents?.at(-1)?.message || '대기 중…')}</div>`;
  const candidates = (analysis.workflowCandidates || []).map(candidate => `<div class="candidate-row ${candidate.id === analysis.recommendedWorkflow ? 'recommended' : ''}"><b>${escapeHtml(workflowFor(candidate.id)?.name || candidate.id)}</b><span>${escapeHtml(candidate.fit)}<small>${escapeHtml(candidate.tradeoff)}</small></span></div>`).join('');
  return `<div class="inspector-hero"><h3>${escapeHtml(analysis.requestSummary)}</h3><p>내부 사고문장이 아닌 검증 가능한 판단 근거와 운영 결정을 공개합니다.</p><div class="inspector-meta"><span>공개 판단 기록</span><span>${escapeHtml(workflowFor(analysis.recommendedWorkflow)?.name || analysis.recommendedWorkflow)}</span><code>analysis.v1</code></div></div>
    ${detailGroup('성공 조건', listHtml(analysis.successCriteria))}
    ${detailGroup('확인된 근거', listHtml(analysis.evidence))}
    ${detailGroup('제약', listHtml(analysis.constraints))}
    ${detailGroup('위험', listHtml(analysis.risks))}
    ${detailGroup('불확실성', listHtml(analysis.unknowns))}
    ${detailGroup('플로우 후보', `<div class="candidate-list">${candidates || '<p class="detail-empty">후보 없음</p>'}</div>`)}
    ${detailGroup('Worker 분할 판단', listHtml(analysis.workerStrategy))}
    ${detailGroup('리뷰 전략', listHtml(analysis.reviewStrategy))}
    ${detailGroup('중단·Owner 호출 조건', listHtml(analysis.stopConditions))}`;
}

function renderPlanInspector(run) {
  $('inspector-title').textContent = '실행 계획';
  if (!run?.workflowId && !run?.actions?.length) return `<div class="inspector-hero"><h3>Worker 구성과 의존성을 설계하는 중</h3><p>${escapeHtml(run?.progressEvents?.at(-1)?.message || '분석 결과를 실행 가능한 작업 그래프로 변환합니다.')}</p><div class="inspector-meta"><span>Director 계획</span></div></div>`;
  const workflow = workflowFor(run.workflowId);
  const actions = (run.actions || []).map((action, index) => `<article class="plan-action"><span>${index + 1}</span><div><strong>${escapeHtml(action.title)}</strong><p>${escapeHtml(action.task)}</p><small>${escapeHtml(action.target)}${action.parentTaskIds?.length ? ` · 선행 ${escapeHtml(action.parentTaskIds.join(', '))}` : ' · 즉시 실행 가능'}</small></div></article>`).join('');
  return `<div class="inspector-hero"><h3>${escapeHtml(workflow?.name || run.workflowId || '대화')}</h3><p>${escapeHtml(workflow?.description || 'Director 응답')}</p><div class="inspector-meta"><span>실행 계획</span><span>${run.actions?.length || 0} tasks</span><code>${escapeHtml(run.workflowId || 'conversation')}</code></div></div>
    ${detailGroup('운영 판단', listHtml(run.publicDecisions))}
    ${detailGroup('작업 그래프', `<div class="plan-actions">${actions || '<p class="detail-empty">Worker 작업 없음</p>'}</div>`)}`;
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
  return `<div class="live-trace-head"><span class="live-indicator ${task.status === 'running' ? 'active' : ''}"><i></i>${task.status === 'running' ? 'LIVE' : statusLabel(task.status)}</span><small>${state.taskTrace?.observedAt ? `마지막 동기화 ${clockLabel(state.taskTrace.observedAt)}` : '로그 동기화 중'}</small></div>
    <div class="reasoning-feed">${commentsHtml || '<div class="trace-placeholder">이전 작업에는 공개 체크포인트가 없습니다. 새 작업부터 PLAN · OBSERVED · DECISION · VERIFY가 실시간으로 쌓입니다.</div>'}</div>
    ${observedSteps.length ? `<div class="observed-commands"><header><strong>관찰된 실행 단계</strong><span>${observedSteps.length}</span></header><ol>${observedSteps.map(step => `<li><i></i><code>${escapeHtml(step)}</code></li>`).join('')}</ol></div>` : ''}
    ${logText ? `<details class="raw-worker-log" ${rawLogOpen ? 'open' : ''}><summary data-raw-worker-log-summary>실행 로그 원문 <span>${logText.split(/\r?\n/).length} lines</span></summary><pre>${escapeHtml(logText)}</pre></details>` : '<div class="trace-placeholder">Worker 로그가 아직 생성되지 않았습니다.</div>'}
    <ol class="event-list worker-lifecycle">${eventsHtml}</ol>`;
}

function renderTaskInspector() {
  $('inspector-title').textContent = 'Worker 실시간 추적';
  if (state.taskLoading && !state.taskDetail) return '<div class="inspector-loading">Worker 실행 trace를 불러오는 중…</div>';
  const details = state.taskDetail;
  if (!details?.task) return '<div class="inspector-loading">Worker 상세 정보를 불러오지 못했습니다.</div>';
  const { task, latest_summary: summary, runs = [] } = details;
  const action = actionForTask(task.id);
  const lastRun = runs.at(-1);
  const taskAction = action?.task || sectionFromBody(task.body, 'ACTION') || task.body;
  const acceptance = action?.acceptance || sectionFromBody(task.body, 'ACCEPTANCE').split(/\r?\n/).map(line => line.replace(/^[-*]\s*/, '')).filter(Boolean);
  const canIntervene = ['running', 'ready', 'todo', 'blocked', 'scheduled', 'review'].includes(task.status);
  const control = task.status === 'running'
    ? '<button class="danger-button" type="button" data-worker-control="pause">즉시 일시정지</button>'
    : ['blocked', 'scheduled'].includes(task.status)
      ? '<button class="resume-button" type="button" data-worker-control="resume">재개</button>' : '';
  const intervention = canIntervene ? `<section class="worker-control"><header><div><span>OWNER STEERING</span><strong>실행 중 방향을 바꿀 수 있습니다</strong></div>${control}</header><textarea id="worker-intervention-input" rows="3" aria-label="Worker에게 전달할 추가 지시" placeholder="예: 그 파일은 건드리지 말고 API 계약부터 확인해. 이 지시는 실행 중 Worker에 바로 전달됩니다.">${escapeHtml(state.interventionDraft)}</textarea><div><small>실행 중에는 약 6초 이내 현재 Worker 세션에 주입됩니다.</small><button type="button" data-send-intervention>지시 추가</button></div></section>` : '';
  return `<div class="inspector-hero"><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(taskAction)}</p><div class="inspector-meta"><span>Worker 실행</span><code>${escapeHtml(task.id)}</code><span>${escapeHtml(task.assignee || '미배정')}</span><span>${escapeHtml(statusLabel(task.status))}</span>${task.started_at ? `<span>${escapeHtml(elapsedLabel(task.started_at, task.completed_at || Date.now()))}</span>` : ''}</div></div>
    ${intervention}
    ${detailGroup('공개 추론·실행 trace', renderPublicTrace(details, state.taskTrace?.log), 'public-trace-group')}
    ${detailGroup('완료 기준', listHtml(acceptance))}
    ${summary ? detailGroup('최근 결과 요약', `<p>${formatText(summary)}</p>`) : ''}
    ${lastRun?.metadata?.verification ? detailGroup('검증', `<p>${formatText(lastRun.metadata.verification)}</p>`) : ''}`;
}

function bindInspectorActions() {
  $('worker-intervention-input')?.addEventListener('input', event => { state.interventionDraft = event.currentTarget.value; });
  $('owner-inspector').querySelector('.raw-worker-log')?.addEventListener('toggle', event => { state.rawLogOpen = event.currentTarget.open; });
  $('owner-inspector').querySelector('[data-send-intervention]')?.addEventListener('click', sendIntervention);
  $('owner-inspector').querySelectorAll('[data-worker-control]').forEach(button => button.addEventListener('click', () => controlWorker(button.dataset.workerControl)));
}

function renderInspector({ force = false } = {}) {
  if (!force && document.activeElement?.id === 'worker-intervention-input') return;
  const activeElement = activeElementIdentity();
  const scroller = document.querySelector('.inspector-scroll');
  const renderKey = `${state.selectedId}:${state.selection.type}:${state.selection.id || ''}`;
  const preserve = state.inspectorRenderKey === renderKey;
  const previousTop = scroller?.scrollTop || 0;
  const stickToBottom = Boolean(scroller && scroller.scrollHeight - scroller.clientHeight - previousTop < 32);
  const run = latestRun();
  let html;
  if (state.selection.type === 'objective') html = renderObjectiveInspector(run);
  else if (state.selection.type === 'analysis') html = renderAnalysisInspector(run);
  else if (state.selection.type === 'plan') html = renderPlanInspector(run);
  else if (state.selection.type === 'task') html = renderTaskInspector();
  else html = renderOverviewInspector();
  $('owner-inspector').innerHTML = html;
  bindInspectorActions();
  restoreActiveElement(activeElement);
  state.inspectorRenderKey = renderKey;
  if (scroller) requestAnimationFrame(() => {
    scroller.scrollTop = preserve ? (stickToBottom ? scroller.scrollHeight : previousTop) : 0;
  });
}

function renderConversation() {
  const runs = selectedRuns().slice(0, 6).reverse();
  $('conversation-count').textContent = `${runs.length * 2} messages`;
  $('owner-chat-stream').innerHTML = runs.length ? runs.map(run => `<article class="chat-message owner"><div class="chat-label">OWNER</div>${formatText(run.prompt)}</article><article class="chat-message director ${run.status === 'failed' ? 'failed' : ''}"><div class="chat-label">DIRECTOR · ${escapeHtml(phaseLabel(run.phase || run.status))}</div>${run.output ? formatText(run.output) : run.error ? formatText(run.error) : '<span class="thinking">판단 중…</span>'}</article>`).join('') : '<div class="chat-empty">아직 대화가 없습니다.</div>';
}

function renderWorkflowCatalog() {
  $('owner-workflow-list').innerHTML = (state.summary?.workflows || []).map(workflow => `<article class="workflow-card"><header><h3>${escapeHtml(workflow.name)}</h3><code>${escapeHtml(workflow.id)}</code></header><p>${escapeHtml(workflow.description)}</p><div class="workflow-steps">${(workflow.graph || []).map(step => `<span>${escapeHtml(step)}</span>`).join('')}</div></article>`).join('');
}

function renderAll() {
  const activeElement = activeElementIdentity();
  renderTopbar();
  renderDirectors();
  renderMissionHeader();
  renderCurrentFocus();
  renderOwnerGate();
  renderTrace();
  renderInspector();
  renderConversation();
  renderWorkflowCatalog();
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
    state.board = [];
    state.boardStatus = { error: error.message };
  }
}

async function refreshSelectedTask({ force = false } = {}) {
  const taskId = state.selection.type === 'task' ? state.selection.id : null;
  if (!taskId || state.taskLoading || (!force && Date.now() - state.taskLoadedAt < TASK_POLL_INTERVAL_MS)) return;
  const directorId = state.selectedId;
  state.taskLoading = true;
  if (force) renderInspector({ force: true });
  try {
    const [detailsResult, traceResult] = await Promise.allSettled([
      api(`/api/directors/${encodeURIComponent(directorId)}/tasks/${encodeURIComponent(taskId)}`),
      api(`/api/directors/${encodeURIComponent(directorId)}/tasks/${encodeURIComponent(taskId)}/trace`),
    ]);
    if (state.selectedId !== directorId || state.selection.id !== taskId) return;
    if (detailsResult.status === 'fulfilled') state.taskDetail = detailsResult.value;
    else throw detailsResult.reason;
    if (traceResult.status === 'fulfilled') state.taskTrace = traceResult.value;
    state.taskLoadedAt = Date.now();
  } catch (error) {
    if (force) toast(error.message, 'error');
  } finally {
    state.taskLoading = false;
    renderInspector();
  }
}

async function performLoadConsole({ quiet = false } = {}) {
  try {
    state.consoleError = null;
    state.summary = await api('/api/directors');
    if (!state.summary.directors.some(director => director.id === state.selectedId)) state.selectedId = state.summary.directors[0]?.id;
    await loadBoard();
    renderAll();
    $('connection-state').className = 'signal online';
    if ($('connection-state').lastElementChild.textContent !== '로컬 연결') $('connection-state').lastElementChild.textContent = '로컬 연결';
    if ($('connection-state').getAttribute('aria-label') !== 'Praetorium 로컬 서버 연결됨') $('connection-state').setAttribute('aria-label', 'Praetorium 로컬 서버 연결됨');
    void refreshSelectedTask();
  } catch (error) {
    state.consoleError = error.message;
    $('connection-state').className = 'signal offline';
    if ($('connection-state').lastElementChild.textContent !== '연결 끊김') $('connection-state').lastElementChild.textContent = '연결 끊김';
    const connectionErrorLabel = `Praetorium 로컬 서버 연결 끊김: ${error.message}`;
    if ($('connection-state').getAttribute('aria-label') !== connectionErrorLabel) $('connection-state').setAttribute('aria-label', connectionErrorLabel);
    renderCurrentFocus();
    if (!quiet) toast(error.message, 'error');
  }
}

async function loadConsole(options = {}) {
  if (state.loading) return state.loading;
  state.loading = performLoadConsole(options);
  try { return await state.loading; } finally { state.loading = null; }
}

async function selectDirector(id) {
  if (window.matchMedia('(max-width: 820px)').matches) setInspectorOpen(false);
  state.selectedId = id;
  state.board = [];
  state.boardStatus = null;
  state.selection = { type: 'overview', id: null };
  state.taskDetail = null;
  state.taskTrace = null;
  state.taskLoadedAt = 0;
  state.interventionDraft = '';
  state.rawLogOpen = null;
  renderAll();
  await loadBoard();
  renderAll();
}

function selectTrace(type) {
  const opener = activeElementIdentity();
  state.selection = { type, id: null };
  renderTrace();
  renderInspector({ force: true });
  restoreActiveElement(opener);
  if (window.matchMedia('(max-width: 820px)').matches) setInspectorOpen(true, opener);
}

async function selectTask(taskId) {
  const opener = activeElementIdentity();
  const changedTask = state.selection.type !== 'task' || state.selection.id !== taskId;
  state.selection = { type: 'task', id: taskId };
  state.taskDetail = null;
  state.taskTrace = null;
  state.taskLoadedAt = 0;
  if (changedTask) {
    state.interventionDraft = '';
    state.rawLogOpen = null;
  }
  renderTrace();
  renderInspector({ force: true });
  restoreActiveElement(opener);
  if (window.matchMedia('(max-width: 820px)').matches) setInspectorOpen(true, opener);
  await refreshSelectedTask({ force: true });
}

async function sendIntervention() {
  const input = $('worker-intervention-input');
  const message = input?.value.trim();
  if (!message || state.selection.type !== 'task') return;
  try {
    await api(`/api/directors/${encodeURIComponent(state.selectedId)}/tasks/${encodeURIComponent(state.selection.id)}/interventions`, {
      method: 'POST', body: JSON.stringify({ message }),
    });
    input.value = '';
    state.interventionDraft = '';
    toast('Owner 지시를 Worker 실행에 전달했습니다.', 'success');
    state.taskLoadedAt = 0;
    await refreshSelectedTask({ force: true });
  } catch (error) { toast(error.message, 'error'); }
}

async function controlWorker(action) {
  if (state.selection.type !== 'task') return;
  const label = action === 'pause' ? '일시정지' : '재개';
  try {
    await api(`/api/directors/${encodeURIComponent(state.selectedId)}/tasks/${encodeURIComponent(state.selection.id)}/control`, {
      method: 'POST', body: JSON.stringify({ action, reason: `Owner가 Praetorium에서 ${label}했습니다.` }),
    });
    toast(`Worker ${label} 요청을 적용했습니다.`, 'success');
    state.taskLoadedAt = 0;
    await loadConsole({ quiet: true });
    await refreshSelectedTask({ force: true });
  } catch (error) { toast(error.message, 'error'); }
}

async function sendMessage() {
  const input = $('owner-message-input');
  const prompt = input.value.trim();
  if (!prompt) return;
  try {
    await api(`/api/directors/${encodeURIComponent(state.selectedId)}/messages`, {
      method: 'POST', body: JSON.stringify({ prompt, mode: $('owner-message-mode').value }),
    });
    input.value = '';
    state.selection = { type: 'analysis', id: null };
    await loadConsole({ quiet: true });
  } catch (error) { toast(error.message, 'error'); }
}

async function dispatchNow() {
  try {
    const result = await api(`/api/directors/${encodeURIComponent(state.selectedId)}/dispatch`, { method: 'POST', body: '{}' });
    toast(`배치 완료 · ${result.spawned ?? 0}개 Worker 시작`, 'success');
    await loadConsole({ quiet: true });
  } catch (error) { toast(error.message, 'error'); }
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
  $('discovery-root').placeholder = wsl ? `${target?.home || '/home/owner'}/projects` : 'C:\\projects';
}

function projectPayload() {
  return {
    name: $('project-name').value.trim(),
    path: $('project-path').value,
    runtime: $('project-runtime').value,
    distro: $('project-runtime').value === 'wsl' ? $('project-distro').value : null,
  };
}

async function withBusy(button, label, action) {
  if (button.disabled) return;
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try { return await action(); }
  finally { button.disabled = false; button.textContent = previous; }
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
    return `<article class="runtime-row ${target.ready ? 'ready' : 'warning'}"><div class="runtime-state"><i></i><span>${target.ready ? 'READY' : target.system ? 'SYSTEM' : 'SETUP'}</span></div><div class="runtime-copy"><header><h4>${escapeHtml(target.label)}</h4>${system}</header><p>${escapeHtml(target.error || 'Praetorium 실행 요구사항을 모두 충족합니다.')}</p><dl><div><dt>Hermes</dt><dd>${escapeHtml(target.hermes?.version || '설치되지 않음')}</dd></div><div><dt>Codex</dt><dd>${escapeHtml(codex)}</dd></div><div><dt>역할</dt><dd>${profileCount} / ${profileTotal}</dd></div></dl></div>${target.kind === 'wsl' && !target.ready && !target.system && target.setupCommand ? `<button type="button" class="secondary-button" data-runtime-setup="${escapeHtml(target.id)}">준비 방법</button>` : ''}</article>`;
  }).join('') : '<div class="project-empty"><strong>진단 가능한 런타임이 없습니다.</strong><span>Windows에서 WSL2 배포판이 설치되어 있는지 확인하세요.</span></div>';
  document.querySelectorAll('[data-runtime-setup]').forEach(button => button.addEventListener('click', () => showRuntimeGuide(button.dataset.runtimeSetup)));
  renderProjects();
  renderProfiles();
}

function showRuntimeGuide(id) {
  const target = state.runtimes.find(item => item.id === id);
  if (!target?.setupCommand) return;
  $('runtime-guide').hidden = false;
  $('runtime-guide-copy').textContent = `${target.label} 터미널에서 아래 두 명령을 순서대로 실행하면 고정 버전과 Praetorium 역할 프로필을 준비합니다.`;
  $('runtime-setup-command').textContent = target.setupCommand;
  $('runtime-guide').scrollIntoView({ behavior: preferredScrollBehavior(), block: 'nearest' });
}

async function loadRuntimes({ force = false } = {}) {
  const requestId = ++state.runtimeRequestId;
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
  const groupNames = { director: 'Directors', worker: 'Implementation', review: 'Review & gate' };
  $('profile-list').innerHTML = Object.entries(groupNames).map(([group, label]) => {
    const profiles = state.profiles.filter(profile => profile.group === group);
    return `<section><h4>${label}</h4>${profiles.map(profile => `<button type="button" class="profile-row ${profile.id === state.selectedProfileId ? 'active' : ''}" data-profile="${escapeHtml(profile.id)}" aria-pressed="${profile.id === state.selectedProfileId}"><span><strong>${escapeHtml(profile.label)}</strong><small>${escapeHtml(profile.id)}</small></span><b>${escapeHtml(profile.access)}</b></button>`).join('')}</section>`;
  }).join('');
  document.querySelectorAll('[data-profile]').forEach(button => button.addEventListener('click', () => { state.selectedProfileId = button.dataset.profile; renderProfiles(); }));
  const profile = state.profiles.find(item => item.id === state.selectedProfileId);
  const installations = state.runtimes.filter(target => !target.system).map(target => `<li><span>${escapeHtml(target.label)}</span><b class="readiness ${target.profiles?.includes(profile.id) ? 'ready' : 'warning'}">${target.profiles?.includes(profile.id) ? '설치됨' : '없음'}</b></li>`).join('');
  $('profile-detail').innerHTML = `<header><div><h3>${escapeHtml(profile.label)}</h3><code>${escapeHtml(profile.id)}</code></div><span class="access-badge ${profile.access === 'read-only' ? 'readonly' : 'write'}">${escapeHtml(profile.access)}</span></header><p>${escapeHtml(profile.description)}</p><dl><div><dt>모델</dt><dd>${escapeHtml(profile.model)}</dd></div><div><dt>추론 강도</dt><dd>${escapeHtml(profile.reasoning)}</dd></div><div><dt>기본 스킬</dt><dd>${escapeHtml(profile.skill || '작업에서 지정')}</dd></div><div><dt>역할 유형</dt><dd>${escapeHtml(profile.kind)}</dd></div></dl><section><h4>런타임 설치 상태</h4><ul>${installations || '<li><span>진단 전</span></li>'}</ul></section>`;
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
}

async function openManagement(tab = 'projects') {
  setManagementTab(tab);
  $('project-dialog').showModal();
  const results = await Promise.allSettled([loadProjects(), loadProfiles(), loadRuntimes()]);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) toast(failed.reason.message, 'error');
}

function initTheme() {
  const saved = localStorage.getItem('praetorium-theme') || 'dark';
  document.documentElement.dataset.theme = saved;
  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('praetorium-theme', next);
  });
}

function initScale() {
  let scale = Math.max(.9, Math.min(1.25, Number(localStorage.getItem('praetorium-scale')) || 1));
  const apply = () => {
    document.documentElement.style.setProperty('--ui-scale', scale);
    localStorage.setItem('praetorium-scale', String(scale));
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
  $('owner-message-input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
  });
  $('owner-refresh-btn').addEventListener('click', () => loadConsole());
  $('owner-dispatch-btn').addEventListener('click', dispatchNow);
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
  $('refresh-runtimes-btn').addEventListener('click', () => withBusy($('refresh-runtimes-btn'), '진단 중…', () => loadRuntimes({ force: true })).catch(error => toast(error.message, 'error')));
  $('copy-runtime-command').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('runtime-setup-command').textContent); toast('WSL 준비 명령을 복사했습니다.', 'success'); }
    catch { toast('클립보드에 복사하지 못했습니다. 명령을 직접 선택해 복사하세요.', 'error'); }
  });
  document.querySelectorAll('[data-management-tab]').forEach(button => button.addEventListener('click', () => setManagementTab(button.dataset.managementTab)));
  $('project-dialog').addEventListener('click', event => {
    const button = event.target.closest('[data-retry-management]');
    if (!button) return;
    const loaders = { projects: loadProjects, runtimes: () => loadRuntimes({ force: true }), profiles: loadProfiles };
    const loader = loaders[button.dataset.retryManagement];
    if (loader) void withBusy(button, '다시 시도 중…', loader).catch(error => toast(error.message, 'error'));
  });
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
  window.matchMedia('(max-width: 820px)').addEventListener('change', event => {
    if (!event.matches && document.body.classList.contains('inspector-open')) setInspectorOpen(false, null, false);
  });
  void loadConsole();
  state.timer = setInterval(() => loadConsole({ quiet: true }), POLL_INTERVAL_MS);
}

init();

export const _test = { statusLabel, traceStatus, sectionFromBody };
