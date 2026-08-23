import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { adaptiveWorkerLimit } from './hermes-runtime.js';
import {
  extractDirectorAnalysis, extractDirectorControl, inferRequestMode,
  validateDirectorAnalysis, validateDirectorControl,
} from './director-actions.js';
import { catalogPrompt, PRAETORIUM_SKILLS, WORKER_PROFILES, WORKFLOWS, workflowById } from './workflow-catalog.js';

const PROJECT_DIRECTOR_COUNT = 3;
const TERMINAL_TASK_STATES = new Set(['done', 'blocked', 'archived']);
const DIRECTOR_HANDOFF_TURNS = 8;
const DIRECTOR_HANDOFF_CHARS = 24000;
const BOARD_REFRESH_INTERVAL_MS = 8000;

function slug(value, fallback) {
  const clean = String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return clean || fallback;
}

function now() { return new Date().toISOString(); }

function createdTaskId(result) {
  const payload = result?.json;
  const candidates = [payload?.id, payload?.task_id, payload?.task?.id, payload?.created?.id];
  const direct = candidates.find(value => typeof value === 'string' && value.trim());
  if (direct) return direct.trim();
  const match = String(result?.stdout || '').match(/\bt_[a-z0-9_-]+\b/i);
  return match?.[0] || null;
}

function taskBody(run, plan, action) {
  const lines = [
    '[PRAETORIUM OBJECTIVE]',
    run.prompt,
    '',
    `[WORKFLOW] ${plan.workflowId}`,
    `[ACTION] ${action.id}`,
    action.task,
  ];
  if (plan.requirements.length) lines.push('', '[REQUIREMENTS]', ...plan.requirements.map(item => `- ${item}`));
  if (action.writeScope.length) lines.push('', '[WRITE SCOPE]', ...action.writeScope.map(item => `- ${item}`));
  if (action.acceptance.length) lines.push('', '[ACCEPTANCE]', ...action.acceptance.map(item => `- ${item}`));
  lines.push(
    '',
    '[PUBLIC TRACE]',
    'Keep the Owner informed while you work. Add concise kanban comments on this task at meaningful checkpoints using these prefixes:',
    '- PLAN: the next bounded action and why it is needed.',
    '- OBSERVED: the concrete result of a command, inspection, or test.',
    '- DECISION: a changed direction or tradeoff based on evidence.',
    '- VERIFY: the acceptance criterion currently being checked.',
    'Do not publish private chain-of-thought, secrets, or repetitive narration. These comments are the live public reasoning trace and may receive Owner steering mid-run.',
    '',
    '[LIFECYCLE]',
    'Finish the durable board task with kanban_complete and concrete evidence, or kanban_block with the blocker. Plain text alone is not completion.',
  );
  return lines.join('\n');
}

function defaultState(projects = []) {
  const directors = [];
  for (let i = 0; i < PROJECT_DIRECTOR_COUNT; i++) {
    const project = projects[i] || null;
    const n = i + 1;
    directors.push({
      id: `project-director-${n}`,
      profile: `project-director-${n}`,
      kind: 'project',
      name: project ? `${project.name || project.id} Director` : `Project Director ${n}`,
      projectId: project?.id || null,
      cwd: project?.path ? resolve(project.path) : null,
      board: slug(project?.id, `project-${n}`),
      session: `owner-project-${n}`,
      sessionId: null,
      lastSessionId: null,
      status: project ? 'idle' : 'unassigned',
      lastRunId: null,
      lastSummary: '',
    });
  }
  directors.push({
    id: 'skill-director', profile: 'skill-director', kind: 'skill', name: 'Skill Director',
    projectId: null, cwd: null, board: 'skill-governance', session: 'owner-skill-director',
    sessionId: null,
    lastSessionId: null,
    status: 'idle', lastRunId: null, lastSummary: '',
  });
  return { schema: 1, directors, runs: [], updatedAt: now() };
}

export class DirectorService extends EventEmitter {
  constructor({ runtime, stateFile, projectsRoot, getProjects = () => [] } = {}) {
    super();
    if (!runtime) throw new Error('DirectorService requires a runtime');
    if (!stateFile) throw new Error('DirectorService requires a stateFile');
    this.runtime = runtime;
    this.stateFile = stateFile;
    this.projectsRoot = resolve(projectsRoot || process.cwd());
    this.getProjects = getProjects;
    this.boardLocks = new Set();
    this.boardCache = new Map();
    this.boardRefreshes = new Map();
    this.boardInitializers = new Map();
    this.initializedBoards = new Set();
    this.timer = null;
    this.state = this._load();
    const skillDirector = this.state.directors.find(d => d.id === 'skill-director');
    if (skillDirector && !skillDirector.cwd) skillDirector.cwd = this.projectsRoot;
    this._recoverInterruptedRuns();
    this.syncProjects();
  }

  _load() {
    try {
      if (existsSync(this.stateFile)) {
        const data = JSON.parse(readFileSync(this.stateFile, 'utf8'));
        if (data?.schema === 1 && Array.isArray(data.directors) && Array.isArray(data.runs)) return data;
      }
    } catch { /* recover from a partial/corrupt file with a fresh registry */ }
    return defaultState(this.getProjects());
  }

  _save() {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    this.state.updatedAt = now();
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    renameSync(tmp, this.stateFile);
  }

  _recoverInterruptedRuns() {
    const interruptedAt = now();
    let changed = false;
    for (const run of this.state.runs) {
      if (!['queued', 'running'].includes(run.status)) continue;
      run.status = 'failed';
      run.phase = 'failed';
      run.error = 'Interrupted by a previous Praetorium shutdown; submit again to start a fresh Director turn.';
      run.completedAt = interruptedAt;
      run.progressEvents ||= [];
      run.progressEvents.push({ at: interruptedAt, phase: 'failed', message: '앱 재시작으로 이전 Director 실행을 종료했습니다.' });
      changed = true;
    }
    for (const director of this.state.directors) {
      if (director.status !== 'running') continue;
      director.status = director.kind === 'project' && !director.projectId ? 'unassigned' : 'idle';
      changed = true;
    }
    if (changed) this._save();
  }

  syncProjects() {
    const projects = this.getProjects().filter(p => p?.path && isAbsolute(resolve(p.path)));
    const desired = defaultState(projects).directors;
    const previous = new Map(this.state.directors.map(d => [d.id, d]));
    this.state.directors = desired.map(d => ({ ...d, ...(previous.get(d.id) || {}), ...(
      d.kind === 'project' ? { name: d.name, projectId: d.projectId, cwd: d.cwd, board: d.board, status: d.projectId ? (previous.get(d.id)?.status === 'running' ? 'running' : 'idle') : 'unassigned' } : {}
    ) }));
    const skillDirector = this.state.directors.find(d => d.id === 'skill-director');
    if (skillDirector && !skillDirector.cwd) skillDirector.cwd = this.projectsRoot;
    this._save();
    return this.listDirectors();
  }

  listDirectors() {
    return this.state.directors.map(d => ({ ...d }));
  }

  getDirector(id) {
    return this.state.directors.find(d => d.id === id) || null;
  }

  listRuns({ directorId, limit = 50 } = {}) {
    return this.state.runs.filter(r => !directorId || r.directorId === directorId).slice(-Math.max(1, Math.min(200, limit))).reverse();
  }

  getRun(id) { return this.state.runs.find(r => r.id === id) || null; }

  _boardKey(director) {
    return `${director.profile}\n${director.board}\n${resolve(director.cwd).toLowerCase()}`;
  }

  _boardEntry(director) {
    const key = this._boardKey(director);
    let entry = this.boardCache.get(director.id);
    if (!entry || entry.key !== key) {
      entry = {
        key, tasks: [], refreshing: false, refreshedAt: null,
        lastAttemptAt: null, failedAt: null, error: null,
      };
      this.boardCache.set(director.id, entry);
    }
    return entry;
  }

  async _ensureBoard(director) {
    const key = this._boardKey(director);
    if (this.initializedBoards.has(key)) return;
    if (this.boardInitializers.has(key)) return this.boardInitializers.get(key);

    let initializing;
    initializing = Promise.resolve(this.runtime.ensureBoard?.({
      profile: director.profile, board: director.board, cwd: director.cwd, name: director.name,
    })).then(() => {
      this.initializedBoards.add(key);
    }).finally(() => {
      if (this.boardInitializers.get(key) === initializing) this.boardInitializers.delete(key);
    });
    this.boardInitializers.set(key, initializing);
    return initializing;
  }

  async _refreshBoard(director, { force = false } = {}) {
    const entry = this._boardEntry(director);
    const refreshedAt = entry.refreshedAt ? Date.parse(entry.refreshedAt) : 0;
    if (!force && refreshedAt && Date.now() - refreshedAt < BOARD_REFRESH_INTERVAL_MS) return entry.tasks;
    if (this.boardRefreshes.has(entry.key)) return this.boardRefreshes.get(entry.key);

    entry.refreshing = true;
    entry.lastAttemptAt = now();
    let refreshing;
    refreshing = (async () => {
      await this._ensureBoard(director);
      const tasks = await this.runtime.listTasks({ profile: director.profile, board: director.board, cwd: director.cwd });
      entry.tasks = Array.isArray(tasks) ? tasks : [];
      entry.refreshedAt = now();
      entry.failedAt = null;
      entry.error = null;
      return entry.tasks;
    })().catch(error => {
      entry.failedAt = now();
      entry.error = error.message;
      throw error;
    }).finally(() => {
      entry.refreshing = false;
      if (this.boardRefreshes.get(entry.key) === refreshing) this.boardRefreshes.delete(entry.key);
    });
    this.boardRefreshes.set(entry.key, refreshing);
    return refreshing;
  }

  submitMessage(directorId, prompt, { mode = 'auto' } = {}) {
    const director = this.getDirector(directorId);
    if (!director) throw new Error('Director not found');
    if (!director.cwd) throw new Error('Director has no assigned project directory');
    if (!String(prompt || '').trim()) throw new Error('Prompt is required');
    if (director.status === 'running') throw new Error('Director is already running');

    const run = {
      id: randomUUID(), directorId, kind: 'chat', status: 'queued', prompt: String(prompt),
      output: '', error: null, createdAt: now(), startedAt: null, completedAt: null,
      requestedMode: ['auto', 'conversation', 'delegate'].includes(mode) ? mode : 'auto',
      resolvedMode: null, phase: 'queued', attempt: 0, analysisAttempt: 0, planAttempt: 0, maxAttempts: 2,
      analysis: null,
      workflowId: null, taskIds: [], actions: [], publicDecisions: [],
      progressEvents: [{ at: now(), phase: 'queued', message: 'Owner 요청이 Director 대기열에 들어갔습니다.' }],
    };
    this.state.runs.push(run);
    director.lastRunId = run.id;
    director.status = 'running';
    this._save();
    queueMicrotask(() => this._executeChat(run.id));
    return { ...run };
  }

  _progress(run, phase, message, details = null) {
    run.phase = phase;
    run.progressEvents ||= [];
    run.progressEvents.push({ at: now(), phase, message, ...(details ? { details } : {}) });
    run.progressEvents = run.progressEvents.slice(-80);
    this._save();
    this.emit('run', { ...run });
  }

  _contextualPrompt(run, recoveryNote = '', { stage = 'plan', analysis = null } = {}) {
    const live = this.summary().sessions;
    const requiredMode = inferRequestMode(run.prompt, run.requestedMode);
    const liveStatus = [
      '[PRAETORIUM LIVE STATUS AT TURN START]',
      `Open sessions: ${live.total} total (${live.directors} Director, ${live.workers} worker).`,
      'Use these counts for operational-status questions. Do not estimate session counts.',
    ].join('\n');
    const controlContract = [
      '[PRAETORIUM CONTROL CONTRACT]',
      `Required request mode: ${requiredMode}.`,
      'You are structurally read-only. For delegated work, inspect only enough to decompose it; do not execute, research the final answer, edit, or create artifacts yourself.',
      'Choose one workflow from the catalog. Return a short public decision summary followed by exactly one hidden-from-owner control envelope:',
      '<PRAETORIUM_CONTROL>',
      '{"schema":"director-action.v1","mode":"conversation|delegate","workflow_id":"workflow-id-or-null","state":"planning|executing|awaiting_owner|complete|blocked","requirements":["..."],"decisions":["public operational reason"],"actions":[{"id":"a1","title":"short title","target":"approved-worker-profile","task":"bounded worker outcome","skills":["approved-skill"],"dependencies":[],"write_scope":["path or read-only"],"acceptance":["observable evidence"],"wake_on":["completion|finding|failure"]}],"owner_decision":{"required":false,"question":null,"options":[],"evidence":[]}}',
      '</PRAETORIUM_CONTROL>',
      'Conversation mode uses no workflow and no actions. Delegate mode requires a known workflow and at least one action. Dependencies may reference only earlier action IDs.',
      'When asked about skills, distinguish Praetorium operating skills below from generic Codex tools and answer from this catalog.',
      recoveryNote ? `[RECOVERY] ${recoveryNote}` : '',
    ].filter(Boolean).join('\n');
    const analysisContract = [
      '[PRAETORIUM ANALYSIS CHECKPOINT]',
      'You are the first, structurally read-only Director checkpoint. Do not create tasks and do not perform the requested final work.',
      'Inspect only enough current evidence to expose the operational judgment the Owner needs before delegation.',
      'Return no private chain-of-thought. Return concise, factual public decision artifacts in exactly one envelope:',
      '<PRAETORIUM_ANALYSIS>',
      '{"schema":"director-analysis.v1","request_summary":"...","success_criteria":["..."],"constraints":["..."],"evidence":["path/fact/source checked"],"risks":["..."],"unknowns":["..."],"workflow_candidates":[{"id":"known-workflow","fit":"why it fits","tradeoff":"cost or limitation"}],"recommended_workflow":"known-workflow","worker_strategy":["independent scope and collision reasoning"],"review_strategy":["risk-based reviewer reason"],"stop_conditions":["when to stop or ask Owner"]}',
      '</PRAETORIUM_ANALYSIS>',
      recoveryNote ? `[RECOVERY] ${recoveryNote}` : '',
    ].filter(Boolean).join('\n');
    const stageContract = stage === 'analysis' ? analysisContract : controlContract;
    const analysisContext = analysis ? `[VALIDATED DIRECTOR ANALYSIS]\n${JSON.stringify(analysis)}` : '';
    const history = this.state.runs
      .filter(item => item.id !== run.id && item.directorId === run.directorId && item.status === 'completed')
      .slice(-DIRECTOR_HANDOFF_TURNS)
      .map(item => `OWNER:\n${item.prompt}\n\nDIRECTOR:\n${item.output || '(no textual response)'}`);
    if (!history.length) return [liveStatus, catalogPrompt(), stageContract, analysisContext, '[CURRENT OWNER MESSAGE]', run.prompt].filter(Boolean).join('\n\n');

    let handoff = history.join('\n\n---\n\n');
    if (handoff.length > DIRECTOR_HANDOFF_CHARS) handoff = handoff.slice(-DIRECTOR_HANDOFF_CHARS);
    return [
      '[PRAETORIUM FRESH-SESSION HANDOFF]',
      'The following is bounded prior owner/director context. Preserve durable decisions, but re-check live repository and board state before acting.',
      liveStatus,
      catalogPrompt(),
      stageContract,
      analysisContext,
      handoff,
      '[CURRENT OWNER MESSAGE]',
      run.prompt,
    ].join('\n\n');
  }

  async _executeChat(runId) {
    const run = this.getRun(runId);
    const director = run && this.getDirector(run.directorId);
    if (!run || !director) return;
    run.status = 'running';
    run.startedAt = now();
    run.resolvedMode = inferRequestMode(run.prompt, run.requestedMode);
    this._progress(run, 'preparing', `요청을 ${run.resolvedMode === 'delegate' ? '위임 작업' : '대화'}으로 분류하고 보드를 준비합니다.`);
    try {
      await this._ensureBoard(director);
      if (run.resolvedMode === 'delegate') {
        this._progress(run, 'analyzing', 'Director 분석 체크포인트가 요구·성공조건·근거·위험·대안을 정리합니다.');
        let lastAnalysisError = null;
        for (let attempt = 1; attempt <= run.maxAttempts; attempt += 1) {
          run.analysisAttempt = attempt;
          run.attempt = attempt;
          this._save();
          try {
            const analysisResult = await this.runtime.chat({
              profile: director.profile, session: null, cwd: director.cwd,
              board: director.board,
              prompt: this._contextualPrompt(run, attempt > 1 ? `Attempt ${attempt}: the previous analysis checkpoint failed (${lastAnalysisError}). Return a fresh valid analysis envelope.` : '', { stage: 'analysis' }),
              onOutput: ({ channel, text }) => this.emit('output', { runId, directorId: director.id, channel, text }),
            });
            run.analysis = validateDirectorAnalysis(extractDirectorAnalysis(analysisResult.stdout));
            if (analysisResult.sessionId) director.lastSessionId = analysisResult.sessionId;
            break;
          } catch (error) {
            lastAnalysisError = error.message;
            const retryable = error.code === 'HERMES_TIMEOUT' || /Director (?:analysis|did not return)/i.test(error.message);
            if (!retryable || attempt >= run.maxAttempts) throw error;
            director.sessionId = null;
            this._progress(run, 'retrying', `분석 체크포인트 ${attempt}회차가 실패해 새 세션으로 재시도합니다.`, { reason: error.message, checkpoint: 'analysis' });
          }
        }
        this._progress(run, 'analyzed', `${workflowById(run.analysis.recommendedWorkflow).name} 플로우를 우선안으로 분석했습니다.`, {
          recommendedWorkflow: run.analysis.recommendedWorkflow,
          risks: run.analysis.risks,
          workerStrategy: run.analysis.workerStrategy,
        });
      }
      this._progress(run, 'directing', 'Director가 플로우를 선택하고 작업 경계·의존성·검증 기준을 설계합니다.');
      let result;
      let parsed;
      let plan;
      let lastPlanningError = null;
      for (let attempt = 1; attempt <= run.maxAttempts; attempt += 1) {
        run.planAttempt = attempt;
        run.attempt = attempt;
        this._save();
        try {
          result = await this.runtime.chat({
            profile: director.profile, session: null, cwd: director.cwd,
            board: director.board,
            prompt: this._contextualPrompt(
              run,
              attempt > 1 ? `Attempt ${attempt}: the previous attempt failed (${lastPlanningError}). Return a fresh, valid control envelope without doing the workers' work.` : '',
              { stage: 'plan', analysis: run.analysis },
            ),
            onOutput: ({ channel, text }) => this.emit('output', { runId, directorId: director.id, channel, text }),
          });
          parsed = extractDirectorControl(result.stdout);
          plan = validateDirectorControl(parsed.control, { requiredMode: run.resolvedMode });
          break;
        } catch (error) {
          lastPlanningError = error.message;
          const retryable = error.code === 'HERMES_TIMEOUT' || /Director (?:control|did not return)|Execution requests must be delegated/i.test(error.message);
          if (!retryable || attempt >= run.maxAttempts) throw error;
          director.sessionId = null;
          this._progress(run, 'retrying', `계획 체크포인트 ${attempt}회차가 실패해 새 세션으로 재시도합니다.`, { reason: error.message, checkpoint: 'plan' });
        }
      }
      // Hermes v0.20.5 can stall before inference when resuming a Codex
      // app-server session. Every Director turn is intentionally fresh; the
      // bounded handoff above retains decisions without unbounded model context.
      director.sessionId = null;
      if (result.sessionId) director.lastSessionId = result.sessionId;
      run.resolvedMode = plan.mode;
      run.publicDecisions = plan.decisions;
      run.workflowId = plan.workflowId;

      if (plan.mode === 'delegate') {
        const workflow = workflowById(plan.workflowId);
        this._progress(run, 'materializing', `${workflow.name} 플로우를 선택했습니다. ${plan.actions.length}개 작업을 보드에 생성합니다.`, {
          workflowId: plan.workflowId, decisions: plan.decisions,
        });
        const taskByAction = new Map();
        for (const action of plan.actions) {
          const parents = action.dependencies.map(id => taskByAction.get(id)).filter(Boolean);
          const created = await this.runtime.createTask({
            profile: director.profile,
            board: director.board,
            cwd: director.cwd,
            title: action.title,
            body: taskBody(run, plan, action),
            assignee: action.target,
            skills: action.skills,
            parents,
            idempotencyKey: `praetorium-${run.id}-${action.id}`,
          });
          const taskId = createdTaskId(created);
          if (!taskId) throw new Error(`Hermes created action ${action.id} without returning a task ID.`);
          taskByAction.set(action.id, taskId);
          run.taskIds.push(taskId);
          run.actions.push({ ...action, taskId, parentTaskIds: parents, status: 'queued' });
          this._progress(run, 'materializing', `${taskId} · ${WORKER_PROFILES[action.target].label} · ${action.title}`, {
            taskId, actionId: action.id, worker: action.target, dependencies: parents,
          });
        }
        run.output = `${workflow.name} 플로우로 ${run.taskIds.length}개 작업을 위임했습니다. 작업 진행·리뷰·수정 상태는 같은 화면의 타임라인과 Worker board에서 계속 갱신됩니다.`;
        this._progress(run, 'dispatching', `작업 ${run.taskIds.length}개 생성 완료. 실행 가능한 워커를 자동 배치합니다.`, { taskIds: run.taskIds });
        void this.tickDirector(director.id).catch(error => {
          if (this.listenerCount('error')) this.emit('error', error);
        });
      } else {
        run.output = parsed.publicOutput || '대화 요청을 처리했습니다.';
      }
      run.status = 'completed';
      director.lastSummary = run.output.slice(-2000);
      director.status = 'idle';
      this._progress(run, plan.mode === 'delegate' ? 'delegated' : 'completed', plan.mode === 'delegate'
        ? 'Director 계획이 검증됐고 실행 책임이 워커로 넘어갔습니다.'
        : 'Director가 대화 응답을 완료했습니다.');
    } catch (err) {
      run.status = 'failed';
      run.phase = 'failed';
      run.error = err.message;
      run.output = '';
      director.status = 'error';
      run.progressEvents ||= [];
      run.progressEvents.push({ at: now(), phase: 'failed', message: `실행 중단: ${err.message}` });
    } finally {
      run.completedAt = now();
      this._save();
      this.emit('run', { ...run });
    }
  }

  async createObjective(directorId, { title, body }) {
    const director = this.getDirector(directorId);
    if (!director || director.kind !== 'project') throw new Error('Project Director not found');
    if (!director.cwd) throw new Error('Director has no assigned project directory');
    await this._ensureBoard(director);
    const result = await this.runtime.createObjective({
      profile: director.profile, board: director.board, cwd: director.cwd, title, body,
    });
    await this.tickDirector(directorId);
    return result.json || { output: result.stdout };
  }

  getBoard(directorId) {
    const director = this.getDirector(directorId);
    if (!director || !director.cwd) return [];
    const entry = this._boardEntry(director);
    // HTTP reads are cache-only. Hermes refreshes in the background, with one
    // in-flight refresh per board, so a slow CLI can never freeze the console.
    void this._refreshBoard(director).catch(() => {});
    return entry.tasks.map(task => ({ ...task }));
  }

  getBoardStatus(directorId) {
    const director = this.getDirector(directorId);
    if (!director || !director.cwd) return { refreshing: false, refreshedAt: null, failedAt: null, error: null };
    const entry = this._boardEntry(director);
    return {
      refreshing: entry.refreshing,
      refreshedAt: entry.refreshedAt,
      failedAt: entry.failedAt,
      error: entry.error,
    };
  }

  async getTaskDetails(directorId, taskId) {
    const director = this.getDirector(directorId);
    if (!director || director.kind !== 'project' || !director.cwd) throw new Error('Project Director not found');
    await this._ensureBoard(director);
    const details = await this.runtime.taskDetails({
      profile: director.profile, board: director.board, cwd: director.cwd, taskId,
    });
    if (!details?.task) throw new Error('Task not found');
    return details;
  }

  async getTaskTrace(directorId, taskId) {
    const director = this.getDirector(directorId);
    if (!director || director.kind !== 'project' || !director.cwd) throw new Error('Project Director not found');
    await this._ensureBoard(director);
    const log = await this.runtime.taskLog({
      profile: director.profile, board: director.board, cwd: director.cwd, taskId,
    });
    return { taskId, log, observedAt: now() };
  }

  async interveneTask(directorId, taskId, message) {
    const director = this.getDirector(directorId);
    if (!director || director.kind !== 'project' || !director.cwd) throw new Error('Project Director not found');
    await this._ensureBoard(director);
    await this.runtime.commentTask({
      profile: director.profile, board: director.board, cwd: director.cwd,
      taskId, message, author: 'Owner',
    });
    return { taskId, delivered: true, message: String(message).trim(), at: now() };
  }

  async controlTask(directorId, taskId, action, reason = '') {
    const director = this.getDirector(directorId);
    if (!director || director.kind !== 'project' || !director.cwd) throw new Error('Project Director not found');
    await this._ensureBoard(director);
    const details = await this.runtime.taskDetails({
      profile: director.profile, board: director.board, cwd: director.cwd, taskId,
    });
    if (!details?.task) throw new Error('Task not found');
    const status = details.task.status;
    if (action === 'pause') {
      const note = String(reason || 'Owner가 실행을 일시정지했습니다.').slice(0, 2000);
      if (status === 'running') {
        await this.runtime.reclaimTask({
          profile: director.profile, board: director.board, cwd: director.cwd, taskId, reason: note,
        });
      }
      if (!['blocked', 'done', 'archived'].includes(status)) {
        await this.runtime.blockTask({
          profile: director.profile, board: director.board, cwd: director.cwd, taskId, reason: note,
        });
      }
    } else if (action === 'resume') {
      if (!['blocked', 'scheduled'].includes(status)) throw new Error('Only a paused task can be resumed');
      await this.runtime.unblockTask({
        profile: director.profile, board: director.board, cwd: director.cwd, taskId,
      });
      void this.tickDirector(directorId).catch(error => {
        if (this.listenerCount('error')) this.emit('error', error);
      });
    } else {
      throw new Error('Unsupported task control action');
    }
    await this._refreshBoard(director, { force: true }).catch(() => {});
    return { taskId, action, previousStatus: status, accepted: true, at: now() };
  }

  async tickDirector(directorId, requestedMax = null) {
    const director = this.getDirector(directorId);
    if (!director || !director.cwd || this.boardLocks.has(director.board)) return { skipped: true };
    this.boardLocks.add(director.board);
    try {
      const tasks = await this._refreshBoard(director, { force: true });
      const ready = tasks.filter(t => ['ready', 'todo'].includes(t.status)).length;
      const running = tasks.filter(t => t.status === 'running').length;
      const max = requestedMax == null ? adaptiveWorkerLimit({ ready, running }) : Math.max(0, Math.min(12, Number(requestedMax) || 0));
      // Hermes performs dead-PID/orphan reconciliation inside every dispatch
      // pass, including --max 0. Skipping dispatch when no task is ready leaves
      // a worker that exited without a terminal board tool stuck as running.
      const result = await this.runtime.dispatch({ profile: director.profile, board: director.board, cwd: director.cwd, max });
      void this._refreshBoard(director, { force: true }).catch(() => {});
      return { ready, running, spawned: result.json?.spawned ?? null, dispatch: result.json, tasks };
    } finally {
      this.boardLocks.delete(director.board);
    }
  }

  async tick() {
    // Boards are independent failure domains. A missing/slow repository in
    // slot 1 must never stall dispatch for slots 2 and 3.
    const eligible = this.state.directors.filter(director => director.kind === 'project' && director.cwd);
    const results = await Promise.all(eligible.map(async director => {
      try { return { directorId: director.id, ...(await this.tickDirector(director.id)) }; }
      catch (err) { return { directorId: director.id, error: err.message }; }
    }));
    this.emit('tick', results);
    return results;
  }

  startScheduler(intervalMs = 10000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(err => this.emit('error', err)), Math.max(5000, intervalMs));
    this.timer.unref?.();
    queueMicrotask(() => this.tick().catch(err => this.emit('error', err)));
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  summary() {
    const runs = this.state.runs;
    const workerTasks = [...this.boardCache.values()].flatMap(entry => entry.tasks);
    const activeDirectorRuns = runs.filter(r => ['queued', 'running'].includes(r.status)).length;
    const activeWorkers = workerTasks.filter(task => task.status === 'running').length;
    return {
      localOnly: true,
      directors: this.listDirectors(),
      activeRuns: activeDirectorRuns,
      sessions: {
        directors: activeDirectorRuns,
        workers: activeWorkers,
        total: activeDirectorRuns + activeWorkers,
      },
      recentRuns: this.listRuns({ limit: 20 }),
      workflows: WORKFLOWS,
      skills: PRAETORIUM_SKILLS,
      workerProfiles: WORKER_PROFILES,
      terminalTaskStates: [...TERMINAL_TASK_STATES],
    };
  }
}

export const _test = { defaultState, slug, createdTaskId, taskBody };
