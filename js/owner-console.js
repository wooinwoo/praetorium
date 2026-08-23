const MAX_PROJECTS = 3;
const POLL_INTERVAL_MS = 3000;
const TASK_POLL_INTERVAL_MS = 2800;

const state = {
  summary: null,
  projects: [],
  selectedId: 'project-director-1',
  board: [],
  boardStatus: null,
  selection: { type: 'overview', id: null },
  taskDetail: null,
  taskTrace: null,
  taskLoading: false,
  taskLoadedAt: 0,
  loading: null,
  timer: null,
};

const $ = id => document.getElementById(id);

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
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(path, {
      ...options,
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
  return (state.summary?.recentRuns || []).filter(run => run.directorId === state.selectedId);
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

function openFocus(title, content = $('owner-inspector').innerHTML) {
  $('focus-dialog-title').textContent = title;
  $('focus-dialog-content').innerHTML = content;
  $('focus-dialog').showModal();
}

function renderTopbar() {
  const director = selectedDirector();
  const sessions = state.summary?.sessions || { total: 0 };
  $('active-project-name').textContent = director?.kind === 'skill' ? 'Skill governance' : (director?.name || 'Project').replace(/ Director$/, '');
  $('active-project-path').textContent = director?.cwd || '프로젝트 미배정';
  $('session-count').lastElementChild.textContent = `${sessions.total || 0} sessions`;
  $('director-count').textContent = state.summary?.directors?.length || 0;
}

function renderDirectors() {
  const directors = state.summary?.directors || [];
  $('owner-director-list').innerHTML = directors.map(director => {
    const index = director.kind === 'skill' ? 'S' : director.id.split('-').at(-1);
    const subtitle = director.kind === 'skill' ? '공용 역량·워크플로' : (director.projectId || '프로젝트 미배정');
    return `<button class="director-row ${director.id === state.selectedId ? 'active' : ''}" data-director="${escapeHtml(director.id)}" type="button">
      <span class="director-index">${escapeHtml(index)}</span>
      <span class="director-copy"><strong>${escapeHtml(director.name)}</strong><small>${escapeHtml(subtitle)}</small></span>
      <i class="status-dot ${traceStatus(director.status)}" title="${escapeHtml(statusLabel(director.status))}"></i>
    </button>`;
  }).join('');
  document.querySelectorAll('[data-director]').forEach(button => {
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
  if (task) {
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
  $('current-focus').innerHTML = `<i class="focus-pulse ${status}"></i><div class="focus-copy"><span>${escapeHtml(kicker)}</span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(description)}</small></div><div class="focus-meta"><b>${escapeHtml(meta)}</b></div>`;
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
    <div class="trace-body"><button class="trace-button" type="button" ${data}>
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
  return `<div class="inspector-hero"><span class="overline">${escapeHtml(director?.kind === 'skill' ? 'SKILL DIRECTOR' : 'PROJECT DIRECTOR')}</span><h3>${escapeHtml(director?.name || 'Director')}</h3><p>${escapeHtml(director?.cwd || '프로젝트가 배정되지 않았습니다.')}</p><div class="inspector-meta"><span>${escapeHtml(statusLabel(director?.status))}</span><code>${escapeHtml(director?.board || '')}</code></div></div>
    ${detailGroup('현재 목표', run ? `<p>${formatText(run.prompt)}</p>` : '<p class="detail-empty">새 목표를 기다리는 중입니다.</p>')}
    ${run ? detailGroup('현재 운영 상태', `<p>${escapeHtml(phaseLabel(run.phase))} · ${run.taskIds?.length || 0} tasks · ${elapsedLabel(run.startedAt, run.completedAt || Date.now())}</p>`) : ''}
    ${detailGroup('Owner 개입', '<p>Director 분석·계획과 모든 Worker 실행을 같은 trace에서 선택할 수 있습니다. 실행 중 Worker를 열면 추가 지시와 일시정지 제어가 나타납니다.</p>')}`;
}

function renderObjectiveInspector(run) {
  $('inspector-title').textContent = 'Owner 목표';
  return `<div class="inspector-hero"><span class="overline">OWNER OBJECTIVE</span><h3>${escapeHtml(run?.prompt || '목표 없음')}</h3><p>Director가 이 목표를 성공 조건과 Worker 작업으로 변환합니다.</p><div class="inspector-meta"><code>${escapeHtml(run?.id || '')}</code><span>${escapeHtml(clockLabel(run?.createdAt))}</span></div></div>`;
}

function renderAnalysisInspector(run) {
  $('inspector-title').textContent = 'Director 분석';
  const analysis = run?.analysis;
  if (!analysis) return `<div class="inspector-hero"><span class="overline">DIRECTOR ANALYSIS</span><h3>판단 근거를 구성하는 중</h3><p>요구, 성공 조건, 확인된 근거, 위험과 대안을 공개 체크포인트로 정리합니다.</p></div><div class="inspector-loading">${escapeHtml(run?.progressEvents?.at(-1)?.message || '대기 중…')}</div>`;
  const candidates = (analysis.workflowCandidates || []).map(candidate => `<div class="candidate-row ${candidate.id === analysis.recommendedWorkflow ? 'recommended' : ''}"><b>${escapeHtml(workflowFor(candidate.id)?.name || candidate.id)}</b><span>${escapeHtml(candidate.fit)}<small>${escapeHtml(candidate.tradeoff)}</small></span></div>`).join('');
  return `<div class="inspector-hero"><span class="overline">PUBLIC DECISION JOURNAL</span><h3>${escapeHtml(analysis.requestSummary)}</h3><p>내부 사고문장이 아닌 검증 가능한 판단 근거와 운영 결정을 공개합니다.</p><div class="inspector-meta"><span>${escapeHtml(workflowFor(analysis.recommendedWorkflow)?.name || analysis.recommendedWorkflow)}</span><code>analysis.v1</code></div></div>
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
  if (!run?.workflowId && !run?.actions?.length) return `<div class="inspector-hero"><span class="overline">DIRECTOR PLAN</span><h3>Worker 구성과 의존성을 설계하는 중</h3><p>${escapeHtml(run?.progressEvents?.at(-1)?.message || '분석 결과를 실행 가능한 작업 그래프로 변환합니다.')}</p></div>`;
  const workflow = workflowFor(run.workflowId);
  const actions = (run.actions || []).map((action, index) => `<article class="plan-action"><span>${index + 1}</span><div><strong>${escapeHtml(action.title)}</strong><p>${escapeHtml(action.task)}</p><small>${escapeHtml(action.target)}${action.parentTaskIds?.length ? ` · 선행 ${escapeHtml(action.parentTaskIds.join(', '))}` : ' · 즉시 실행 가능'}</small></div></article>`).join('');
  return `<div class="inspector-hero"><span class="overline">EXECUTION PLAN</span><h3>${escapeHtml(workflow?.name || run.workflowId || '대화')}</h3><p>${escapeHtml(workflow?.description || 'Director 응답')}</p><div class="inspector-meta"><span>${run.actions?.length || 0} tasks</span><code>${escapeHtml(run.workflowId || 'conversation')}</code></div></div>
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
  return `<div class="live-trace-head"><span class="live-indicator ${task.status === 'running' ? 'active' : ''}"><i></i>${task.status === 'running' ? 'LIVE' : statusLabel(task.status)}</span><small>${state.taskTrace?.observedAt ? `마지막 동기화 ${clockLabel(state.taskTrace.observedAt)}` : '로그 동기화 중'}</small></div>
    <div class="reasoning-feed">${commentsHtml || '<div class="trace-placeholder">이전 작업에는 공개 체크포인트가 없습니다. 새 작업부터 PLAN · OBSERVED · DECISION · VERIFY가 실시간으로 쌓입니다.</div>'}</div>
    ${observedSteps.length ? `<div class="observed-commands"><header><strong>관찰된 실행 단계</strong><span>${observedSteps.length}</span></header><ol>${observedSteps.map(step => `<li><i></i><code>${escapeHtml(step)}</code></li>`).join('')}</ol></div>` : ''}
    ${logText ? `<details class="raw-worker-log" ${task.status === 'running' ? 'open' : ''}><summary>실행 로그 원문 <span>${logText.split(/\r?\n/).length} lines</span></summary><pre>${escapeHtml(logText)}</pre></details>` : '<div class="trace-placeholder">Worker 로그가 아직 생성되지 않았습니다.</div>'}
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
  const intervention = canIntervene ? `<section class="worker-control"><header><div><span>OWNER STEERING</span><strong>실행 중 방향을 바꿀 수 있습니다</strong></div>${control}</header><textarea id="worker-intervention-input" rows="3" placeholder="예: 그 파일은 건드리지 말고 API 계약부터 확인해. 이 지시는 실행 중 Worker에 바로 전달됩니다."></textarea><div><small>실행 중에는 약 6초 이내 현재 Worker 세션에 주입됩니다.</small><button type="button" data-send-intervention>지시 추가</button></div></section>` : '';
  return `<div class="inspector-hero"><span class="overline">LIVE WORKER TRACE</span><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(taskAction)}</p><div class="inspector-meta"><code>${escapeHtml(task.id)}</code><span>${escapeHtml(task.assignee || '미배정')}</span><span>${escapeHtml(statusLabel(task.status))}</span>${task.started_at ? `<span>${escapeHtml(elapsedLabel(task.started_at, task.completed_at || Date.now()))}</span>` : ''}</div></div>
    ${intervention}
    ${detailGroup('공개 추론·실행 trace', renderPublicTrace(details, state.taskTrace?.log), 'public-trace-group')}
    ${detailGroup('완료 기준', listHtml(acceptance))}
    ${summary ? detailGroup('최근 결과 요약', `<p>${formatText(summary)}</p>`) : ''}
    ${lastRun?.metadata?.verification ? detailGroup('검증', `<p>${formatText(lastRun.metadata.verification)}</p>`) : ''}`;
}

function bindInspectorActions() {
  $('owner-inspector').querySelector('[data-send-intervention]')?.addEventListener('click', sendIntervention);
  $('owner-inspector').querySelectorAll('[data-worker-control]').forEach(button => button.addEventListener('click', () => controlWorker(button.dataset.workerControl)));
}

function renderInspector({ force = false } = {}) {
  if (!force && document.activeElement?.id === 'worker-intervention-input') return;
  const run = latestRun();
  let html;
  if (state.selection.type === 'objective') html = renderObjectiveInspector(run);
  else if (state.selection.type === 'analysis') html = renderAnalysisInspector(run);
  else if (state.selection.type === 'plan') html = renderPlanInspector(run);
  else if (state.selection.type === 'task') html = renderTaskInspector();
  else html = renderOverviewInspector();
  $('owner-inspector').innerHTML = html;
  bindInspectorActions();
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
  renderTopbar();
  renderDirectors();
  renderMissionHeader();
  renderCurrentFocus();
  renderOwnerGate();
  renderTrace();
  renderInspector();
  renderConversation();
  renderWorkflowCatalog();
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
    state.summary = await api('/api/directors');
    if (!state.summary.directors.some(director => director.id === state.selectedId)) state.selectedId = state.summary.directors[0]?.id;
    await loadBoard();
    renderAll();
    $('connection-state').className = 'signal online';
    $('connection-state').lastElementChild.textContent = '로컬 연결';
    void refreshSelectedTask();
  } catch (error) {
    $('connection-state').className = 'signal offline';
    $('connection-state').lastElementChild.textContent = '연결 끊김';
    if (!quiet) toast(error.message, 'error');
  }
}

async function loadConsole(options = {}) {
  if (state.loading) return state.loading;
  state.loading = performLoadConsole(options);
  try { return await state.loading; } finally { state.loading = null; }
}

async function selectDirector(id) {
  state.selectedId = id;
  state.selection = { type: 'overview', id: null };
  state.taskDetail = null;
  state.taskTrace = null;
  state.taskLoadedAt = 0;
  renderAll();
  await loadBoard();
  renderAll();
}

function selectTrace(type) {
  state.selection = { type, id: null };
  renderTrace();
  renderInspector({ force: true });
}

async function selectTask(taskId) {
  state.selection = { type: 'task', id: taskId };
  state.taskDetail = null;
  state.taskTrace = null;
  state.taskLoadedAt = 0;
  renderTrace();
  renderInspector({ force: true });
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
  $('project-capacity').textContent = `${state.projects.length} / ${MAX_PROJECTS}`;
  $('project-list').innerHTML = state.projects.length ? state.projects.map((project, index) => `<article class="project-row"><span class="project-slot">${index + 1}</span><span><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.path)}</small></span><button type="button" data-remove-project="${escapeHtml(project.id)}">제거</button></article>`).join('') : '<div class="project-empty">배정된 프로젝트가 없습니다.</div>';
  document.querySelectorAll('[data-remove-project]').forEach(button => button.addEventListener('click', () => removeProject(button.dataset.removeProject)));
  $('add-project-btn').disabled = state.projects.length >= MAX_PROJECTS;
  $('discover-projects-btn').disabled = state.projects.length >= MAX_PROJECTS;
}

async function loadProjects() {
  state.projects = await api('/api/projects');
  renderProjects();
}

async function addProject() {
  const name = $('project-name').value.trim();
  const path = $('project-path').value.trim();
  if (!name || !path) return toast('이름과 절대 경로를 입력하세요.', 'error');
  try {
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, path }) });
    $('project-name').value = '';
    $('project-path').value = '';
    await Promise.all([loadProjects(), loadConsole({ quiet: true })]);
    toast('Project Director에 배정했습니다.', 'success');
  } catch (error) { toast(error.message, 'error'); }
}

async function removeProject(id) {
  try {
    await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await Promise.all([loadProjects(), loadConsole({ quiet: true })]);
    toast('프로젝트 배정을 제거했습니다.', 'success');
  } catch (error) { toast(error.message, 'error'); }
}

async function discoverProjects() {
  try {
    const result = await api('/api/projects/discover', { method: 'POST', body: '{}' });
    await Promise.all([loadProjects(), loadConsole({ quiet: true })]);
    toast(result.added ? `${result.added}개 프로젝트를 자동 배정했습니다.` : '추가할 프로젝트를 찾지 못했습니다.', result.added ? 'success' : 'info');
  } catch (error) { toast(error.message, 'error'); }
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
  $('project-settings-btn').addEventListener('click', async () => { await loadProjects(); $('project-dialog').showModal(); });
  $('inspector-expand').addEventListener('click', () => openFocus($('inspector-title').textContent));
  $('add-project-btn').addEventListener('click', addProject);
  $('discover-projects-btn').addEventListener('click', discoverProjects);
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
      event.preventDefault(); $('owner-message-input').focus();
    } else if (event.key.toLowerCase() === 'r' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
      void loadConsole();
    } else if (event.key === 'Escape' && state.selection.type !== 'overview' && !$('focus-dialog').open) {
      state.selection = { type: 'overview', id: null }; renderTrace(); renderInspector({ force: true });
    }
  });
  void loadConsole();
  state.timer = setInterval(() => loadConsole({ quiet: true }), POLL_INTERVAL_MS);
}

init();

export const _test = { statusLabel, traceStatus, sectionFromBody };
