import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, posix, resolve, win32 } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { adaptiveWorkerLimit } from './hermes-runtime.js';
import { stableBoardIdentity } from './project-identity.js';
import {
  extractDirectorAnalysis, extractDirectorControl, inferRequestMode,
  validateDirectorAnalysis, validateDirectorControl,
} from './director-actions.js';
import {
  catalogPrompt, evaluateWorkflowGates, PRAETORIUM_SKILLS, WORKER_PROFILES,
  WORKFLOWS, isStructuredEvidenceApproved, workflowById, workflowPolicyById,
} from './workflow-catalog.js';
import {
  ACTIVE_GOAL_STATES, TERMINAL_GOAL_STATES, TERMINAL_TASK_STATES,
  addGoalEvent, buildSupervisionPrompt, classifyWave, currentWave,
  compactReport, evaluateGoalAcceptance, goalReadyForEvaluation, goalTaskEvidence, isActiveGoal, isTerminalTask,
  normalizeGoalRecord, syncGoalTasks,
} from './goal-supervisor.js';

const PROJECT_DIRECTOR_COUNT = 3;
const DIRECTOR_HANDOFF_TURNS = 8;
const DIRECTOR_HANDOFF_CHARS = 24000;
const BOARD_REFRESH_INTERVAL_MS = 8000;
const DEFAULT_MAX_GOAL_CYCLES = 12;
const DEFAULT_MAX_EVALUATION_FAILURES = 3;

function now() { return new Date().toISOString(); }

function projectCwd(project) {
  if (!project?.path) return null;
  if (project.runtime === 'wsl') return posix.normalize(project.path);
  return win32.isAbsolute(project.path) ? win32.normalize(project.path) : resolve(project.path);
}

function validProject(project) {
  if (!project?.path) return false;
  return project.runtime === 'wsl' ? posix.isAbsolute(project.path) : (isAbsolute(project.path) || win32.isAbsolute(project.path));
}

function directorTarget(director) {
  return director?.runtime === 'wsl'
    ? { kind: 'wsl', distro: director.distro }
    : { kind: 'windows', distro: null };
}

function createdTaskId(result) {
  const payload = result?.json;
  const candidates = [payload?.id, payload?.task_id, payload?.task?.id, payload?.created?.id];
  const direct = candidates.find(value => typeof value === 'string' && value.trim());
  if (direct) return direct.trim();
  const match = String(result?.stdout || '').match(/\bt_[a-z0-9_-]+\b/i);
  return match?.[0] || null;
}

function dependencySafeActions(actions) {
  const rank = action => ({ write: 0, review: 1, gate: 2 }[WORKER_PROFILES[action.target]?.kind] ?? 1);
  const ranks = new Set(actions.map(rank));
  if (ranks.has(0) && (ranks.has(1) || ranks.has(2))) {
    throw new Error('Write and review/gate actions must use separate waves so the host can bind an immutable candidate digest.');
  }
  let highestRank = 0;
  const priorWrites = [];
  const priorChecks = [];
  const preparedById = new Map();
  const normalizedScopes = action => (action.writeScope || []).map(value => String(value || '')
    .trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()).filter(Boolean);
  const scopesOverlap = (left, right) => normalizedScopes(left).some(a => normalizedScopes(right).some(b => (
    ['.', '*', '**', 'repo', 'repository', 'workspace'].includes(a)
      || ['.', '*', '**', 'repo', 'repository', 'workspace'].includes(b)
      || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
  )));
  const prepared = actions.map(action => {
    const currentRank = rank(action);
    if (currentRank < highestRank) {
      throw new Error('Worker actions must be ordered as write → review → quality gate within a wave.');
    }
    highestRank = Math.max(highestRank, currentRank);
    const dependencies = new Set(action.dependencies || []);
    // All writers share one project cwd. Until a host-managed worktree merge
    // primitive exists, serialize write actions even when scopes look disjoint;
    // review-only profiles still run in parallel after the write wave settles.
    if (currentRank === 0 && priorWrites.length) dependencies.add(priorWrites.at(-1));
    if (currentRank >= 1) for (const id of priorWrites) dependencies.add(id);
    if (currentRank >= 2) for (const id of priorChecks) dependencies.add(id);
    const prepared = { ...action, dependencies: [...dependencies] };
    const ancestors = new Set(prepared.dependencies);
    for (const dependency of [...ancestors]) {
      for (const ancestor of preparedById.get(dependency)?.dependencies || []) ancestors.add(ancestor);
    }
    if (currentRank === 0 && action.effect === 'workspace_write') {
      const collision = priorWrites
        .map(id => preparedById.get(id))
        .find(previous => previous?.effect === 'workspace_write'
          && !ancestors.has(previous.id) && scopesOverlap(previous, prepared));
      if (collision) {
        throw new Error(`Parallel write scopes overlap (${collision.id} and ${action.id}); add a dependency or split the scopes.`);
      }
    }
    if (currentRank === 0) priorWrites.push(action.id);
    if (currentRank < 2) priorChecks.push(action.id);
    preparedById.set(action.id, prepared);
    return prepared;
  });
  return prepared;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function actionPlanDigest(actions) {
  const canonical = actions.map(action => ({
    id: action.id,
    title: action.title,
    target: action.target,
    task: action.task,
    skills: [...(action.skills || [])].sort(),
    dependencies: [...(action.dependencies || [])].sort(),
    writeScope: [...(action.writeScope || [])].sort(),
    acceptance: [...(action.acceptance || [])].sort(),
    wakeOn: [...(action.wakeOn || [])].sort(),
    effect: action.effect,
  }));
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

function persistedAuthorityPlanDigest(pending) {
  if (!pending?.plan || pending.plan.mode !== 'delegate') return null;
  if (pending.kind === 'actions') {
    if (pending.plan.state !== 'executing' || !Array.isArray(pending.plan.actions)
      || pending.plan.actions.length === 0) return null;
    return actionPlanDigest(pending.plan.actions);
  }
  if (pending.kind === 'completion') {
    if (pending.plan.state !== 'complete' || !pending.candidateDigest
      || pending.throughWave === null || pending.throughWave === undefined || pending.throughWave === ''
      || !Number.isFinite(Number(pending.throughWave))) return null;
    return `completion:${pending.candidateDigest}:${Number(pending.throughWave)}`;
  }
  return null;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stateDocument(state) {
  const document = cloneJson(state);
  delete document.integrity;
  const canonical = JSON.stringify(document);
  document.integrity = {
    algorithm: 'sha256',
    digest: createHash('sha256').update(canonical).digest('hex'),
  };
  return document;
}

function parseStateDocument(source, label = 'state') {
  const data = JSON.parse(source);
  if (![1, 2].includes(data?.schema) || !Array.isArray(data.directors) || !Array.isArray(data.runs)) {
    throw new Error(`${label} has an unsupported or incomplete schema.`);
  }
  if (data.integrity) {
    if (data.integrity.algorithm !== 'sha256' || typeof data.integrity.digest !== 'string') {
      throw new Error(`${label} has invalid integrity metadata.`);
    }
    const expected = data.integrity.digest;
    delete data.integrity;
    const observed = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    if (observed !== expected) throw new Error(`${label} checksum mismatch.`);
  }
  return data;
}

function taskBody(goal, run, plan, action, waveIndex) {
  const lines = [
    '[PRAETORIUM OBJECTIVE]',
    goal?.objective || run.prompt,
    '',
    ...(goal ? [`[GOAL] ${goal.id}`, `[WAVE] ${waveIndex}`] : []),
    `[WORKFLOW] ${plan.workflowId}`,
    `[ACTION] ${action.id}`,
    `[EFFECT] ${action.effect}`,
    action.task,
  ];
  if (goal?.successCriteria?.length) lines.push('', '[GOAL SUCCESS CRITERIA]', ...goal.successCriteria.map(item => `- ${item}`));
  if (goal?.currentCandidate?.digest) lines.push(
    '',
    '[HOST-BOUND CANDIDATE]',
    `revision: ${goal.currentCandidate.revision || 'none'}`,
    `artifact_digest: ${goal.currentCandidate.digest}`,
    'Bind every review.v1 scope and quality-gate.v1 candidate to this exact host-observed candidate. If files change, stop and report stale evidence.',
  );
  if (goal?.ownerAnswers?.length) lines.push('', '[OWNER DECISIONS]', ...goal.ownerAnswers.slice(-6).map(item => `- ${item.answer}`));
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
  const assigned = new Map();
  const usedSlots = new Set();
  for (const project of projects.slice(0, PROJECT_DIRECTOR_COUNT)) {
    let slot = Number(project.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > PROJECT_DIRECTOR_COUNT || usedSlots.has(slot)) {
      slot = Array.from({ length: PROJECT_DIRECTOR_COUNT }, (_, index) => index + 1).find(candidate => !usedSlots.has(candidate));
    }
    usedSlots.add(slot);
    assigned.set(slot, project);
  }
  const directors = [];
  for (let i = 0; i < PROJECT_DIRECTOR_COUNT; i++) {
    const n = i + 1;
    const project = assigned.get(n) || null;
    directors.push({
      id: `project-director-${n}`,
      profile: `project-director-${n}`,
      kind: 'project',
      name: project ? `${project.name || project.id} Director` : `Project Director ${n}`,
      projectId: project?.id || null,
      cwd: projectCwd(project),
      runtime: project?.runtime === 'wsl' ? 'wsl' : 'windows',
      distro: project?.runtime === 'wsl' ? project.distro : null,
      board: stableBoardIdentity(project?.id, `project-${n}`),
      session: `owner-project-${n}`,
      sessionId: null,
      lastSessionId: null,
      status: project ? 'idle' : 'unassigned',
      lastRunId: null,
      lastSummary: '',
      activeGoalId: null,
    });
  }
  directors.push({
    id: 'skill-director', profile: 'skill-director', kind: 'skill', name: 'Skill Director',
    projectId: null, cwd: null, runtime: 'windows', distro: null, board: 'skill-governance', session: 'owner-skill-director',
    sessionId: null,
    lastSessionId: null,
    status: 'idle', lastRunId: null, lastSummary: '', activeGoalId: null,
  });
  return { schema: 2, directors, runs: [], goals: [], updatedAt: now() };
}

export class DirectorService extends EventEmitter {
  constructor({ runtime, stateFile, projectsRoot, skillWorkspace = null, getProjects = () => [] } = {}) {
    super();
    if (!runtime) throw new Error('DirectorService requires a runtime');
    if (!stateFile) throw new Error('DirectorService requires a stateFile');
    this.runtime = runtime;
    this.stateFile = stateFile;
    this.projectsRoot = resolve(projectsRoot || process.cwd());
    this.skillWorkspace = skillWorkspace ? resolve(skillWorkspace) : resolve(dirname(stateFile), 'skill-workspace');
    mkdirSync(this.skillWorkspace, { recursive: true });
    this.getProjects = getProjects;
    this.boardLocks = new Set();
    this.boardCache = new Map();
    this.boardRefreshes = new Map();
    this.boardInitializers = new Map();
    this.initializedBoards = new Set();
    this.goalLocks = new Set();
    this.taskControlLocks = new Set();
    this.dispatchReservations = 0;
    this.detachingProjects = new Set();
    this.shutdownPending = false;
    this.timer = null;
    this.stateRecovery = null;
    this.state = this._load();
    const skillDirector = this.state.directors.find(d => d.id === 'skill-director');
    if (skillDirector) skillDirector.cwd = this.skillWorkspace;
    this._recoverInterruptedRuns();
    this.syncProjects();
  }

  _load() {
    const backupFile = `${this.stateFile}.bak`;
    const candidates = [this.stateFile, backupFile].filter(path => existsSync(path));
    if (!candidates.length) return defaultState(this.getProjects());
    const failures = [];
    for (const path of candidates) {
      try {
        const data = parseStateDocument(readFileSync(path, 'utf8'), path === this.stateFile ? 'primary state' : 'backup state');
        const projectByDirector = new Map(data.directors.map(director => [director.id, director.projectId || null]));
        data.runs = data.runs.map(run => ({ ...run, projectId: run.projectId ?? projectByDirector.get(run.directorId) ?? null }));
        data.goals = Array.isArray(data.goals) ? data.goals.map(normalizeGoalRecord) : [];
        for (const director of data.directors) {
          director.activeGoalId ||= data.goals.find(goal => goal.directorId === director.id && isActiveGoal(goal))?.id || null;
        }
        data.schema = 2;
        if (path === backupFile) {
          this.stateRecovery = { at: now(), source: 'backup', failures: [...failures] };
        }
        return data;
      } catch (error) {
        failures.push({ path, error: error.message });
      }
    }
    throw new Error(`Praetorium durable state is unreadable; refusing to discard Goals. ${failures.map(item => `${item.path}: ${item.error}`).join(' | ')}`);
  }

  _save() {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    this.state.updatedAt = now();
    const tmp = `${this.stateFile}.tmp`;
    const backupFile = `${this.stateFile}.bak`;
    if (existsSync(this.stateFile)) {
      try {
        parseStateDocument(readFileSync(this.stateFile, 'utf8'), 'primary state');
        copyFileSync(this.stateFile, backupFile);
      } catch { /* never replace a known-good backup with corrupt primary bytes */ }
    }
    writeFileSync(tmp, JSON.stringify(stateDocument(this.state), null, 2), 'utf8');
    renameSync(tmp, this.stateFile);
  }

  _recoverInterruptedRuns() {
    const interruptedAt = now();
    let changed = false;
    for (const run of this.state.runs) {
      if (!['queued', 'running'].includes(run.status)) continue;
      run.status = 'failed';
      run.phase = 'failed';
      run.error = 'Interrupted by a previous Praetorium shutdown. The durable Goal will resume from persisted evidence.';
      run.completedAt = interruptedAt;
      run.progressEvents ||= [];
      run.progressEvents.push({ at: interruptedAt, phase: 'failed', message: '이전 Director 추론 턴이 앱 종료로 중단되었습니다.' });
      changed = true;
    }
    for (const goal of this.state.goals || []) {
      if (TERMINAL_GOAL_STATES.has(goal.status) || goal.status === 'awaiting_owner') continue;
      if (['planning', 'evaluating', 'clarifying'].includes(goal.status)) {
        goal.status = goal.waves?.length ? 'evaluating' : 'planning';
        goal.phase = 'recovering';
        goal.nextEvaluationAt = null;
        addGoalEvent(goal, 'recovery', 'recovering', '앱 재시작 후 영속 Goal 감독을 재개합니다.', { interruptedAt }, interruptedAt);
        changed = true;
      }
    }
    for (const director of this.state.directors) {
      if (director.status !== 'running') continue;
      director.status = director.kind === 'project' && !director.projectId ? 'unassigned' : 'idle';
      changed = true;
    }
    if (changed) this._save();
  }

  syncProjects() {
    const projects = this.getProjects().filter(validProject);
    const desired = defaultState(projects).directors;
    const previousById = new Map(this.state.directors.map(d => [d.id, d]));
    const previousByProject = new Map(this.state.directors.filter(d => d.projectId).map(d => [d.projectId, d]));
    this.state.directors = desired.map(d => {
      if (d.kind !== 'project') return { ...d, ...(previousById.get(d.id) || {}) };
      const previous = d.projectId ? previousByProject.get(d.projectId) : null;
      return {
        ...d,
        ...(previous || {}),
        id: d.id,
        profile: d.profile,
        session: d.session,
        name: d.name,
        projectId: d.projectId,
        cwd: d.cwd,
        runtime: d.runtime,
        distro: d.distro,
        board: d.board,
        status: d.projectId ? (previous?.status === 'running' ? 'running' : 'idle') : 'unassigned',
        ...(!d.projectId ? { sessionId: null, lastSessionId: null, lastRunId: null, lastSummary: '', activeGoalId: null } : {}),
      };
    });
    for (const director of this.state.directors.filter(item => item.kind === 'project' && item.projectId)) {
      let goal = director.activeGoalId ? this.getGoal(director.activeGoalId) : null;
      if (!goal || goal.projectId !== director.projectId || !isActiveGoal(goal)) {
        goal = (this.state.goals || []).findLast(item => item.projectId === director.projectId && isActiveGoal(item)) || null;
      }
      director.activeGoalId = goal?.id || null;
      if (goal && goal.directorId !== director.id) {
        const previousDirectorId = goal.directorId;
        goal.directorId = director.id;
        for (const run of this.state.runs.filter(item => item.goalId === goal.id)) run.directorId = director.id;
        addGoalEvent(goal, 'recovery', 'director_slot_migrated', '프로젝트 슬롯 변경에 맞춰 활성 Goal 소유권을 같은 프로젝트 Director로 이전했습니다.', {
          previousDirectorId, directorId: director.id, projectId: director.projectId,
        });
      }
    }
    const skillDirector = this.state.directors.find(d => d.id === 'skill-director');
    if (skillDirector) skillDirector.cwd = this.skillWorkspace;
    this._save();
    return this.listDirectors();
  }

  listDirectors() {
    return this.state.directors.map(d => ({ ...d }));
  }

  getDirector(id) {
    return this.state.directors.find(d => d.id === id) || null;
  }

  listRuns({ directorId, projectId, limit = 50 } = {}) {
    return this.state.runs.filter(r => (!directorId || r.directorId === directorId) && (projectId === undefined || r.projectId === projectId)).slice(-Math.max(1, Math.min(200, limit))).reverse();
  }

  getRun(id) { return this.state.runs.find(r => r.id === id) || null; }

  listGoals({ directorId, projectId, activeOnly = false, limit = 50 } = {}) {
    return (this.state.goals || [])
      .filter(goal => (!directorId || goal.directorId === directorId)
        && (projectId === undefined || goal.projectId === projectId)
        && (!activeOnly || isActiveGoal(goal)))
      .slice(-Math.max(1, Math.min(200, limit)))
      .reverse();
  }

  getGoal(id) { return (this.state.goals || []).find(goal => goal.id === id) || null; }

  _activeGoal(directorId) {
    const director = this.getDirector(directorId);
    const pinned = director?.activeGoalId ? this.getGoal(director.activeGoalId) : null;
    if (isActiveGoal(pinned) && pinned.directorId === directorId) return pinned;
    const goal = (this.state.goals || []).findLast(item => item.directorId === directorId && isActiveGoal(item)) || null;
    if (director) director.activeGoalId = goal?.id || null;
    return goal;
  }

  _goalEvent(goal, kind, phase, message, details = null) {
    const event = addGoalEvent(goal, kind, phase, message, details, now());
    this._save();
    this.emit('goal', { ...goal });
    return event;
  }

  _boardKey(director) {
    const cwd = director.runtime === 'wsl' ? posix.normalize(director.cwd) : projectCwd({ path: director.cwd });
    return `${director.profile}\n${director.board}\n${director.runtime || 'windows'}\n${director.distro || ''}\n${cwd.toLowerCase()}`;
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
      target: directorTarget(director),
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
      const tasks = await this.runtime.listTasks({ profile: director.profile, board: director.board, cwd: director.cwd, target: directorTarget(director) });
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

  _createGoal(director, run, objective) {
    const createdAt = now();
    const goal = normalizeGoalRecord({
      id: `goal_${randomUUID()}`,
      directorId: director.id,
      projectId: director.projectId,
      objective,
      status: 'planning',
      phase: 'queued',
      workflowId: null,
      analysis: null,
      successCriteria: [],
      constraints: [],
      requirements: [],
      taskIds: [],
      currentWaveTaskIds: [],
      taskRecords: [],
      waves: [],
      ownerDecision: null,
      ownerAnswers: [],
      ownerApprovals: [],
      publicDecisions: [],
      evidence: [],
      currentCandidate: null,
      candidateSnapshots: [],
      finalReport: null,
      error: null,
      cycleCount: 0,
      maxCycles: DEFAULT_MAX_GOAL_CYCLES,
      remediationCount: 0,
      maxRemediationLoops: 3,
      evaluationFailures: 0,
      nextEvaluationAt: null,
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      lastRunId: run.id,
      events: [{ at: createdAt, kind: 'owner', phase: 'queued', message: 'Owner가 지속형 Goal을 생성했습니다.' }],
    });
    this.state.goals ||= [];
    this.state.goals.push(goal);
    director.activeGoalId = goal.id;
    run.goalId = goal.id;
    return goal;
  }

  submitMessage(directorId, prompt, { mode = 'auto' } = {}) {
    const director = this.getDirector(directorId);
    if (!director) throw new Error('Director not found');
    if (!director.cwd) throw new Error('Director has no assigned project directory');
    this._assertAcceptingWork(director);
    const objective = String(prompt || '').trim();
    if (!objective) throw new Error('Prompt is required');
    if (director.status === 'running') throw new Error('Director is already running');
    const requestedMode = ['auto', 'conversation', 'delegate'].includes(mode) ? mode : 'auto';
    const resolvedMode = inferRequestMode(objective, requestedMode);
    if (resolvedMode === 'delegate') {
      const activeGoal = this._activeGoal(directorId);
      if (activeGoal) throw new Error(`Director already supervises active Goal ${activeGoal.id}. Complete it or answer its Owner decision first.`);
    }

    const run = {
      id: randomUUID(), directorId, projectId: director.projectId, kind: 'chat', status: 'queued', prompt: objective,
      output: '', error: null, createdAt: now(), startedAt: null, completedAt: null,
      requestedMode, resolvedMode, phase: 'queued', attempt: 0, analysisAttempt: 0, planAttempt: 0, maxAttempts: 2,
      analysis: null,
      workflowId: null, taskIds: [], actions: [], publicDecisions: [],
      progressEvents: [{ at: now(), phase: 'queued', message: 'Owner 요청이 Director 대기열에 들어갔습니다.' }],
    };
    this.state.runs.push(run);
    if (resolvedMode === 'delegate') this._createGoal(director, run, objective);
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
      '{"schema":"director-action.v1","mode":"conversation|delegate","workflow_id":"workflow-id-or-null","state":"executing|awaiting_owner|complete|blocked","requirements":["..."],"decisions":["public operational reason"],"actions":[{"id":"a1","title":"short title","target":"approved-worker-profile","effect":"read_only|workspace_write|external_mutation|skill_activation","task":"bounded worker outcome","skills":["approved-skill"],"dependencies":[],"write_scope":["path or read-only"],"acceptance":["observable evidence"],"wake_on":["completion|finding|failure"]}],"owner_decision":{"required":false,"question":null,"options":[],"evidence":[]}}',
      '</PRAETORIUM_CONTROL>',
      'Conversation mode uses no workflow and no actions. Delegate mode requires a known workflow. executing requires actions; awaiting_owner, complete, and blocked require zero actions. Dependencies may reference only earlier action IDs.',
      'Use awaiting_owner only for a material decision that cannot be inferred safely. Otherwise create the first bounded worker wave and let the durable Goal supervisor continue.',
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
      .filter(item => item.id !== run.id && item.kind === 'chat'
        && item.projectId === run.projectId && item.status === 'completed')
      .slice(-DIRECTOR_HANDOFF_TURNS)
      .map(item => `OWNER:\n${item.prompt}\n\nDIRECTOR:\n${item.output || '(no textual response)'}`);
    const goal = run.goalId ? this.getGoal(run.goalId) : null;
    const ownerAnswers = goal?.ownerAnswers?.length
      ? `[DURABLE GOAL OWNER ANSWERS]\n${JSON.stringify(goal.ownerAnswers.slice(-8))}` : '';
    if (!history.length) return [liveStatus, catalogPrompt(), stageContract, analysisContext, ownerAnswers, '[CURRENT OWNER MESSAGE]', run.prompt].filter(Boolean).join('\n\n');

    let handoff = history.join('\n\n---\n\n');
    if (handoff.length > DIRECTOR_HANDOFF_CHARS) handoff = handoff.slice(-DIRECTOR_HANDOFF_CHARS);
    return [
      '[PRAETORIUM FRESH-SESSION HANDOFF]',
      'The following is bounded prior owner/director context. Preserve durable decisions, but re-check live repository and board state before acting.',
      liveStatus,
      catalogPrompt(),
      stageContract,
      analysisContext,
      ownerAnswers,
      handoff,
      '[CURRENT OWNER MESSAGE]',
      run.prompt,
    ].join('\n\n');
  }

  _updateGoalFromAnalysis(goal, analysis) {
    if (!goal || !analysis) return;
    if (goal.specFrozen && goal.workflowId && goal.workflowId !== analysis.recommendedWorkflow) {
      throw new Error(`Goal workflow is immutable (${goal.workflowId}); Director returned ${analysis.recommendedWorkflow}.`);
    }
    goal.analysis = analysis;
    goal.reanalysisRequired = false;
    goal.successCriteria = [...analysis.successCriteria];
    goal.constraints = [...analysis.constraints];
    goal.workflowId = analysis.recommendedWorkflow;
    const policy = workflowPolicyById(goal.workflowId);
    if (policy?.maxRemediationLoops) goal.maxRemediationLoops = policy.maxRemediationLoops;
    goal.status = 'planning';
    goal.phase = 'analyzed';
    goal.updatedAt = now();
    addGoalEvent(goal, 'director', 'analyzed', `워크플로 ${goal.workflowId}와 성공 조건을 확정했습니다.`, {
      workflowId: goal.workflowId,
      successCriteria: goal.successCriteria,
      risks: analysis.risks,
    }, goal.updatedAt);
  }

  _parkGoalForOwner(goal, decision, message = null) {
    const askedAt = now();
    goal.status = 'awaiting_owner';
    goal.phase = 'awaiting_owner';
    goal.ownerDecision = {
      required: true,
      question: String(decision?.question || 'Owner 판단이 필요합니다.'),
      options: Array.isArray(decision?.options) ? decision.options : [],
      optionActions: decision?.optionActions && typeof decision.optionActions === 'object' ? decision.optionActions : {},
      evidence: Array.isArray(decision?.evidence) ? decision.evidence : [],
      kind: decision?.kind || 'material_decision',
      approvalKind: decision?.approvalKind || null,
      throughWave: Number.isFinite(Number(decision?.throughWave)) ? Number(decision.throughWave) : null,
      plannedActions: Array.isArray(decision?.plannedActions) ? decision.plannedActions : [],
      planDigest: decision?.planDigest || null,
      askedAt,
    };
    addGoalEvent(goal, 'owner_decision', 'awaiting_owner', message || goal.ownerDecision.question, {
      options: goal.ownerDecision.options,
      evidence: goal.ownerDecision.evidence,
    }, askedAt);
  }

  _finishGoal(goal, status, report, details = null) {
    const finishedAt = now();
    goal.status = status;
    goal.phase = status;
    goal.finalReport = status === 'completed' ? String(report || 'Goal completed.') : null;
    goal.error = status === 'completed' ? null : String(report || 'Goal blocked.');
    goal.ownerDecision = null;
    goal.pendingAuthorityPlan = null;
    goal.completedAt = finishedAt;
    goal.updatedAt = finishedAt;
    const director = this.getDirector(goal.directorId);
    if (director?.activeGoalId === goal.id) director.activeGoalId = null;
    addGoalEvent(goal, 'terminal', status, status === 'completed' ? '성공 조건과 검증 게이트를 충족해 Goal을 완료했습니다.' : goal.error, details, finishedAt);
  }

  _latestWriteWave(goal) {
    return (goal.taskRecords || [])
      .filter(record => WORKER_PROFILES[record.profile]?.kind === 'write' && ['done', 'completed', 'succeeded', 'success'].includes(record.status))
      .reduce((latest, record) => Math.max(latest, Number(record.waveIndex) || 0), 0);
  }

  _workflowApprovalRequirement(goal, { actions = [], completion = false } = {}) {
    const policy = workflowPolicyById(goal.workflowId);
    const explicitKinds = new Set(actions
      .map(action => action.effect === 'skill_activation' ? 'skill_activation'
        : action.effect === 'external_mutation' ? 'external_action' : null)
      .filter(Boolean));
    if (explicitKinds.size > 1) throw new Error('External mutation and skill activation authority must use separate Owner-approved waves.');
    let approvalKind = [...explicitKinds][0] || (completion
      ? policy?.ownerApprovalBeforeActivation ? 'skill_activation'
        : policy?.ownerApprovalBeforeExternalAction ? 'external_action' : null
      : null);
    if (!completion && !explicitKinds.size) {
      const actionText = actions
        .filter(action => WORKER_PROFILES[action.target]?.kind === 'write')
        .map(action => `${action.title}\n${action.task}\n${(action.writeScope || []).join('\n')}`)
        .join('\n');
      if (/(?:activate|enable|install\s+(?:the\s+)?skill|publish\s+(?:the\s+)?skill|스킬\s*(?:활성화|설치|등록|배포))/i.test(actionText)) {
        approvalKind = 'skill_activation';
      } else if (/(?:deploy|publish|release|ship|tag|upload|external|배포|게시|릴리스|출시|태그|외부)/i.test(actionText)) {
        approvalKind = 'external_action';
      }
    }
    if (!approvalKind) return null;
    const throughWave = completion ? this._latestWriteWave(goal) : goal.waves.length + 1;
    const planDigest = completion
      ? `completion:${goal.currentCandidate?.digest || 'missing'}:${throughWave}`
      : actionPlanDigest(actions);
    const approved = (goal.ownerApprovals || []).some(item => item.kind === approvalKind
      && item.planDigest === planDigest && item.throughWave >= throughWave);
    if (approved) return null;
    return {
      kind: 'workflow_approval',
      approvalKind,
      throughWave,
      planDigest,
      question: approvalKind === 'skill_activation'
        ? '스킬 활성화 또는 설치 단계로 진행할까요?'
        : completion ? '검증된 결과를 승인하고 이 고위험/릴리스 Goal을 완료할까요?'
          : '외부 배포·출시·태그 등 되돌리기 어려운 실행 단계로 진행할까요?',
      options: ['승인하고 계속', '추가 검증 요청', '차단하고 종료'],
      optionActions: { '승인하고 계속': 'approve', '추가 검증 요청': 'reevaluate', '차단하고 종료': 'stop' },
      evidence: actions.map(action => `${action.target}: ${action.title}`),
      plannedActions: actions.map(action => ({
        id: action.id, title: action.title, target: action.target, effect: action.effect,
        task: action.task, writeScope: action.writeScope,
      })),
    };
  }

  _assertFreshOwnerRequestedVerification(goal) {
    const barrier = goal.verificationBarrier;
    if (!barrier) return;
    const freshGate = (goal.taskRecords || []).findLast(record => record.profile === 'quality-gate-reviewer'
      && ['done', 'completed', 'succeeded', 'success'].includes(record.status)
      && Number(record.waveIndex) > Number(barrier.afterWave));
    if (!freshGate) {
      throw new Error(`Owner-requested fresh verification is required after wave ${barrier.afterWave}; create a new review and quality-gate wave first.`);
    }
  }

  async _materializeGoalWave({ director, goal, run, plan, existingWave = null }) {
    let wave = existingWave;
    let preparedActions;
    let remediation;
    if (!wave) {
      preparedActions = dependencySafeActions(plan.actions);
      remediation = preparedActions.some(action => action.target === 'remediator');
      if (goal.cycleCount >= goal.maxCycles || (remediation && goal.remediationCount >= goal.maxRemediationLoops)) {
        const limit = remediation ? `수정 루프 ${goal.maxRemediationLoops}회` : `감독 wave ${goal.maxCycles}회`;
        this._parkGoalForOwner(goal, {
          kind: 'loop_limit',
          required: true,
          question: `${limit} 제한에 도달했습니다. 추가 루프를 허용할지 결정해 주세요.`,
          options: ['4개 wave 추가 후 계속', '현재 증거를 다시 평가', '차단하고 종료'],
          optionActions: { '4개 wave 추가 후 계속': 'extend', '현재 증거를 다시 평가': 'reevaluate', '차단하고 종료': 'stop' },
          evidence: plan.decisions,
        });
        return { state: 'awaiting_owner', taskIds: [] };
      }

      const waveIndex = goal.waves.length + 1;
      wave = {
        id: `wave_${randomUUID()}`,
        index: waveIndex,
        kind: classifyWave(preparedActions, waveIndex),
        status: 'materializing',
        workflowId: plan.workflowId,
        requirements: [...plan.requirements],
        decisions: [...plan.decisions],
        taskIds: [],
        actionIds: preparedActions.map(action => action.id),
        actions: preparedActions.map(action => ({
          ...action, taskId: null, parentTaskIds: [], materializationStatus: 'pending',
        })),
        materializationFailures: 0,
        startedAt: now(),
        completedAt: null,
        assessment: null,
      };
      goal.waves.push(wave);
      goal.specFrozen = true;
      goal.currentWaveTaskIds = wave.taskIds;
      goal.cycleCount += 1;
      if (remediation) goal.remediationCount += 1;
      goal.status = wave.kind === 'remediation' ? 'remediating'
        : ['review', 'verification'].includes(wave.kind) ? 'verifying' : 'executing';
      goal.phase = 'materializing';
      goal.requirements = [...new Set([...(goal.requirements || []), ...plan.requirements])];
      addGoalEvent(goal, 'wave', 'materializing', `${workflowById(plan.workflowId).name}의 ${waveIndex}번째 wave를 생성합니다.`, {
        waveId: wave.id, kind: wave.kind, actions: preparedActions.length,
      });
      // Persist the complete action journal before the first external mutation.
      // A restart can safely replay only pending entries with the same idempotency key.
      this._save();
    } else {
      preparedActions = wave.actions || [];
      remediation = preparedActions.some(action => action.target === 'remediator');
      plan = {
        ...plan,
        workflowId: wave.workflowId || goal.workflowId,
        requirements: wave.requirements || [],
        decisions: wave.decisions || [],
        actions: preparedActions,
      };
      wave.status = 'materializing';
      goal.status = wave.kind === 'remediation' ? 'remediating'
        : ['review', 'verification'].includes(wave.kind) ? 'verifying' : 'executing';
      goal.phase = 'materialization_recovery';
    }

    const taskByAction = new Map((wave.actions || [])
      .filter(action => action.taskId)
      .map(action => [action.id, action.taskId]));
    const newTaskIds = [];
    try {
      for (const action of wave.actions || []) {
        if (action.taskId) continue;
        const parents = action.dependencies.map(id => taskByAction.get(id)).filter(Boolean);
        if (parents.length !== action.dependencies.length) {
          throw new Error(`Action ${action.id} cannot materialize before all dependency task IDs exist.`);
        }
        const created = await this.runtime.createTask({
          profile: director.profile,
          board: director.board,
          cwd: director.cwd,
          target: directorTarget(director),
          title: action.title,
          body: taskBody(goal, run, plan, action, wave.index),
          assignee: action.target,
          skills: action.skills,
          parents,
          goalMode: WORKER_PROFILES[action.target]?.kind === 'write',
          goalMaxTurns: action.target === 'remediator' ? 10 : 16,
          idempotencyKey: `praetorium-${goal.id}-${wave.index}-${action.id}`,
        });
        const taskId = createdTaskId(created);
        if (!taskId) throw new Error(`Hermes created action ${action.id} without returning a task ID.`);
        action.taskId = taskId;
        action.parentTaskIds = parents;
        action.materializationStatus = 'created';
        taskByAction.set(action.id, taskId);
        if (!wave.taskIds.includes(taskId)) wave.taskIds.push(taskId);
        if (!goal.taskIds.includes(taskId)) goal.taskIds.push(taskId);
        newTaskIds.push(taskId);
        run.taskIds.push(taskId);
        run.actions.push({ ...action, status: 'queued', waveIndex: wave.index });
        if (!goal.taskRecords.some(record => record.taskId === taskId)) {
          goal.taskRecords.push({
            taskId,
            waveId: wave.id,
            waveIndex: wave.index,
            actionId: action.id,
            title: action.title,
            profile: action.target,
            kind: WORKER_PROFILES[action.target]?.kind || null,
            writeScope: action.writeScope,
            acceptance: action.acceptance,
            wakeOn: action.wakeOn,
            parentTaskIds: parents,
            status: 'queued',
            pausedByOwner: false,
            createdAt: now(),
            startedAt: null,
            completedAt: null,
          });
        }
        addGoalEvent(goal, 'task', 'materializing', `${WORKER_PROFILES[action.target].label}에게 “${action.title}” 작업을 배정했습니다.`, {
          taskId, actionId: action.id, profile: action.target, parents,
        });
        this._progress(run, 'materializing', `${taskId} · ${WORKER_PROFILES[action.target].label} · ${action.title}`, {
          goalId: goal.id, waveId: wave.id, taskId, actionId: action.id, worker: action.target, dependencies: parents,
        });
      }
    } catch (error) {
      wave.status = 'materializing';
      wave.materializationFailures = (wave.materializationFailures || 0) + 1;
      goal.currentWaveTaskIds = [...wave.taskIds];
      goal.phase = 'materialization_retry';
      addGoalEvent(goal, 'error', 'materialization_retry', 'Worker wave 생성이 중단되어 action journal에서 자동 재개합니다.', {
        waveId: wave.id,
        createdTaskIds: wave.taskIds,
        pendingActionIds: wave.actions.filter(action => !action.taskId).map(action => action.id),
        error: error.message,
      });
      this._save();
      throw error;
    }
    wave.status = 'queued';
    wave.materializationFailures = 0;
    goal.phase = goal.status;
    goal.currentWaveTaskIds = [...wave.taskIds];
    goal.nextEvaluationAt = null;
    goal.evaluationFailures = 0;
    addGoalEvent(goal, 'wave', goal.phase, `${wave.taskIds.length}개 작업을 배치하고 완료 감시를 시작했습니다.`, {
      waveId: wave.id, taskIds: wave.taskIds,
    });
    this._save();
    return { state: goal.status, taskIds: newTaskIds, wave };
  }

  async _applyGoalControl({ director, goal, run, plan, publicOutput = '', gateAudit = null }) {
    if (!goal) throw new Error('Delegated Director turn has no durable Goal.');
    if (goal.workflowId && plan.workflowId !== goal.workflowId) {
      throw new Error(`Goal workflow is immutable (${goal.workflowId}); Director returned ${plan.workflowId}.`);
    }
    goal.workflowId ||= plan.workflowId;
    run.workflowId = goal.workflowId;
    goal.publicDecisions.push(...plan.decisions.map(decision => ({ at: now(), waveIndex: goal.waves.length, decision })));

    if (plan.state === 'executing') {
      if (plan.actions.some(action => ['external_mutation', 'skill_activation'].includes(action.effect))) {
        this._assertFreshOwnerRequestedVerification(goal);
      }
      const approval = this._workflowApprovalRequirement(goal, { actions: plan.actions });
      if (approval) {
        goal.pendingAuthorityPlan = {
          kind: 'actions', approvalKind: approval.approvalKind, planDigest: approval.planDigest,
          throughWave: approval.throughWave, plan: cloneJson(plan), publicOutput,
          createdAt: now(),
        };
        this._parkGoalForOwner(goal, approval, approval.question);
        run.output = publicOutput || approval.question;
        return { state: 'awaiting_owner', taskIds: [] };
      }
      const materialized = await this._materializeGoalWave({ director, goal, run, plan });
      run.output = publicOutput || (materialized.state === 'awaiting_owner'
        ? goal.ownerDecision.question
        : `${workflowById(goal.workflowId).name} ${goal.cycleCount}번째 wave에 ${materialized.taskIds.length}개 작업을 배정했습니다.`);
      return materialized;
    }
    if (plan.state === 'awaiting_owner') {
      const decision = !goal.specFrozen && !goal.waves.length
        ? { ...plan.ownerDecision, kind: 'initial_clarification' }
        : plan.ownerDecision;
      this._parkGoalForOwner(goal, decision);
      run.output = publicOutput || goal.ownerDecision.question;
      return { state: 'awaiting_owner', taskIds: [] };
    }
    if (plan.state === 'blocked') {
      const report = publicOutput || plan.decisions.join('\n') || 'Director가 해결 불가능한 blocker를 확인했습니다.';
      this._finishGoal(goal, 'blocked', report, { decisions: plan.decisions });
      run.output = report;
      return { state: 'blocked', taskIds: [] };
    }
    if (plan.state === 'complete') {
      this._assertFreshOwnerRequestedVerification(goal);
      const fallbackEvidence = gateAudit ? null : goalTaskEvidence(goal);
      const workflowAudit = gateAudit || evaluateWorkflowGates(goal.workflowId, fallbackEvidence);
      const acceptance = gateAudit?.acceptance || evaluateGoalAcceptance(goal, fallbackEvidence, {
        gateTaskId: workflowAudit.approvedGateTaskId,
      });
      const audit = { ...workflowAudit, acceptance, satisfied: workflowAudit.satisfied && acceptance.satisfied };
      if (!audit.satisfied) {
        const gaps = [
          ...(audit.missingProfiles || []),
          ...(audit.rejectedProfiles || []).map(profile => `${profile}:non-passing-verdict`),
          ...(audit.acceptance?.missingCriteria || []).map(criterion => `criterion:${criterion}`),
        ];
        throw new Error(`Goal completion rejected; missing, stale, or non-passing evidence: ${gaps.join(', ') || 'unknown'}.`);
      }
      const wave = currentWave(goal);
      if (wave && !wave.taskIds.every(taskId => isTerminalTask(goal.taskRecords.find(record => record.taskId === taskId)?.status))) {
        throw new Error('Goal completion rejected while the current worker wave is still active.');
      }
      const auditedDigest = audit.hostCandidate?.digest || goal.currentCandidate?.digest || null;
      const finalCandidate = await this._captureGoalCandidate(director, goal);
      if (!auditedDigest || !finalCandidate?.digest || finalCandidate.digest !== auditedDigest) {
        throw new Error(`Goal completion rejected; candidate changed after evidence evaluation (${auditedDigest || 'missing'} -> ${finalCandidate?.digest || 'missing'}).`);
      }
      const approval = this._workflowApprovalRequirement(goal, { completion: true });
      if (approval) {
        goal.pendingAuthorityPlan = {
          kind: 'completion', approvalKind: approval.approvalKind, planDigest: approval.planDigest,
          throughWave: approval.throughWave, candidateDigest: goal.currentCandidate?.digest || null,
          plan: cloneJson(plan), publicOutput, gateAudit: cloneJson(audit), createdAt: now(),
        };
        this._parkGoalForOwner(goal, approval, approval.question);
        run.output = publicOutput || approval.question;
        return { state: 'awaiting_owner', taskIds: [] };
      }
      const report = publicOutput || plan.decisions.join('\n') || '모든 성공 조건과 검증 게이트를 충족했습니다.';
      this._finishGoal(goal, 'completed', report, { gateAudit: audit });
      goal.verificationBarrier = null;
      run.output = report;
      return { state: 'completed', taskIds: [] };
    }
    throw new Error(`Unsupported Goal control state: ${plan.state}`);
  }

  async _executeChat(runId) {
    const run = this.getRun(runId);
    const director = run && this.getDirector(run.directorId);
    if (!run || !director) return;
    const goal = run.goalId ? this.getGoal(run.goalId) : null;
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
              target: directorTarget(director),
              prompt: this._contextualPrompt(run, attempt > 1 ? `Attempt ${attempt}: the previous analysis checkpoint failed (${lastAnalysisError}). Return a fresh valid analysis envelope.` : '', { stage: 'analysis' }),
              onOutput: ({ channel, text }) => this.emit('output', { runId, directorId: director.id, channel, text }),
            });
            run.analysis = validateDirectorAnalysis(extractDirectorAnalysis(analysisResult.stdout));
            this._updateGoalFromAnalysis(goal, run.analysis);
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
            target: directorTarget(director),
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
        const outcome = await this._applyGoalControl({ director, goal, run, plan, publicOutput: parsed.publicOutput });
        if (outcome.taskIds.length) {
          this._progress(run, 'dispatching', `Goal ${goal.id}의 ${goal.cycleCount}번째 wave를 자동 배치합니다.`, {
            goalId: goal.id, taskIds: outcome.taskIds,
          });
          void this.tickDirector(director.id).catch(error => {
            if (this.listenerCount('error')) this.emit('error', error);
          });
        }
      } else {
        run.output = parsed.publicOutput || '대화 요청을 처리했습니다.';
      }
      run.status = 'completed';
      director.lastSummary = run.output.slice(-2000);
      director.status = 'idle';
      const goalPhase = goal?.status === 'awaiting_owner' ? 'awaiting_owner'
        : goal?.status === 'completed' ? 'goal_completed'
          : goal?.status === 'blocked' ? 'goal_blocked' : 'delegated';
      this._progress(run, plan.mode === 'delegate' ? goalPhase : 'completed', plan.mode === 'delegate'
        ? `Director 추론 턴은 끝났지만 Goal은 ${goal.status} 상태로 계속 감독됩니다.`
        : 'Director가 대화 응답을 완료했습니다.');
    } catch (err) {
      run.status = 'failed';
      run.phase = 'failed';
      run.error = err.message;
      run.output = '';
      director.status = 'error';
      run.progressEvents ||= [];
      run.progressEvents.push({ at: now(), phase: 'failed', message: `실행 중단: ${err.message}` });
      if (goal && !TERMINAL_GOAL_STATES.has(goal.status) && goal.status !== 'awaiting_owner') {
        goal.status = goal.waves.length ? 'evaluating' : 'planning';
        goal.phase = 'retry_scheduled';
        goal.evaluationFailures += 1;
        if (goal.evaluationFailures >= DEFAULT_MAX_EVALUATION_FAILURES && !goal.waves.length) {
          this._parkGoalForOwner(goal, {
            kind: 'evaluation_failure',
            required: true,
            question: `초기 Goal 분석·계획이 ${goal.evaluationFailures}회 연속 실패했습니다. 환경 확인 후 다시 시도할까요?`,
            options: ['다시 시도', '차단하고 종료'],
            optionActions: { '다시 시도': 'retry_evaluation', '차단하고 종료': 'stop' },
            evidence: [err.message],
          });
        } else {
          goal.nextEvaluationAt = new Date(Date.now() + Math.min(60000, goal.evaluationFailures * 15000)).toISOString();
          addGoalEvent(goal, 'error', 'retry_scheduled', 'Director 턴이 실패해 영속 Goal에서 자동 재시도합니다.', {
            error: err.message, retryAt: goal.nextEvaluationAt,
          });
        }
      }
    } finally {
      run.completedAt = now();
      this._save();
      this.emit('run', { ...run });
    }
  }

  async _captureGoalCandidate(director, goal) {
    if (typeof this.runtime.candidateSnapshot !== 'function') return null;
    const snapshot = await this.runtime.candidateSnapshot({ cwd: director.cwd, target: directorTarget(director) });
    if (!snapshot?.digest) throw new Error('Host candidate snapshot did not return a digest.');
    const previous = goal.currentCandidate;
    goal.currentCandidate = snapshot;
    goal.candidateSnapshots ||= [];
    if (!previous || previous.digest !== snapshot.digest) {
      goal.candidateSnapshots.push({ ...snapshot, waveIndex: currentWave(goal)?.index || 0 });
      goal.candidateSnapshots = goal.candidateSnapshots.slice(-40);
      addGoalEvent(goal, 'evidence', 'candidate_snapshot', 'Host가 현재 작업 트리의 불변 후보 digest를 캡처했습니다.', {
        revision: snapshot.revision, digest: snapshot.digest, dirty: snapshot.dirty,
      });
    }
    return snapshot;
  }

  async _collectGoalEvidence(director, goal) {
    const allRecords = goal.taskRecords || [];
    const currentIds = new Set(currentWave(goal)?.taskIds || []);
    const selectedIds = new Set(currentIds);
    const perProfile = new Map();
    for (const record of [...allRecords].reverse()) {
      const count = perProfile.get(record.profile) || 0;
      if (count < 2) {
        selectedIds.add(record.taskId);
        perProfile.set(record.profile, count + 1);
      }
    }
    const records = allRecords.filter(record => selectedIds.has(record.taskId)).slice(-48);
    const detailsByTaskId = new Map();
    if (typeof this.runtime.taskDetails === 'function') {
      const loaded = await mapWithConcurrency(records, 4, async record => {
        try {
          const details = await this.runtime.taskDetails({
            profile: director.profile,
            board: director.board,
            cwd: director.cwd,
            taskId: record.taskId,
            target: directorTarget(director),
          });
          return [record.taskId, details || {}];
        } catch (error) {
          return [record.taskId, { task: { id: record.taskId, status: record.status }, latest_summary: `Evidence read failed: ${error.message}` }];
        }
      });
      for (const [taskId, details] of loaded) detailsByTaskId.set(taskId, details);
    }
    for (const record of goal.taskRecords || []) {
      const task = detailsByTaskId.get(record.taskId)?.task;
      if (!task) continue;
      const observedStatus = String(task.status || record.status || 'queued').toLowerCase();
      record.status = record.pausedByOwner && observedStatus === 'blocked' ? 'paused' : observedStatus;
      if (isTerminalTask(record.status)) {
        record.completedAt ||= task.completed_at || task.completedAt || task.updated_at || task.updatedAt || now();
      } else if (record.status === 'paused') {
        record.completedAt = null;
      }
    }
    const evidence = goalTaskEvidence(goal, detailsByTaskId);
    for (const item of evidence) {
      if (!detailsByTaskId.has(item.taskId)) continue;
      const record = goal.taskRecords.find(candidate => candidate.taskId === item.taskId);
      if (!record) continue;
      record.summary = item.summary;
      record.report = compactReport(item.report);
      record.reportApproved = item.persistedReportApproved === null
        ? isStructuredEvidenceApproved(item) : item.persistedReportApproved;
    }
    return evidence;
  }

  _createSupervisionRun(director, goal, reason) {
    const createdAt = now();
    const run = {
      id: randomUUID(),
      directorId: director.id,
      projectId: director.projectId,
      goalId: goal.id,
      kind: 'supervision',
      status: 'queued',
      prompt: goal.objective,
      output: '',
      error: null,
      createdAt,
      startedAt: null,
      completedAt: null,
      requestedMode: 'delegate',
      resolvedMode: 'delegate',
      phase: 'queued',
      attempt: 0,
      analysisAttempt: 0,
      planAttempt: 0,
      maxAttempts: 2,
      analysis: goal.analysis,
      workflowId: goal.workflowId,
      taskIds: [],
      actions: [],
      publicDecisions: [],
      wakeReason: reason,
      progressEvents: [{ at: createdAt, phase: 'queued', message: 'Worker 증거를 평가할 새 Director 감독 턴을 열었습니다.' }],
    };
    this.state.runs.push(run);
    goal.lastRunId = run.id;
    director.lastRunId = run.id;
    return run;
  }

  async _evaluateGoal(goalId, { reason = 'wave_completed' } = {}) {
    const goal = this.getGoal(goalId);
    const director = goal && this.getDirector(goal.directorId);
    if (!goal || !director || TERMINAL_GOAL_STATES.has(goal.status) || goal.status === 'awaiting_owner') return { skipped: true };
    if (this.goalLocks.has(goal.id) || this.shutdownPending || this.detachingProjects.has(goal.projectId)) return { skipped: true };
    if (goal.nextEvaluationAt && Date.parse(goal.nextEvaluationAt) > Date.now()) return { skipped: true, retryAt: goal.nextEvaluationAt };
    if (this.state.runs.some(run => run.goalId === goal.id && ['queued', 'running'].includes(run.status))) return { skipped: true };

    this.goalLocks.add(goal.id);
    const run = this._createSupervisionRun(director, goal, reason);
    director.status = 'running';
    goal.status = 'evaluating';
    goal.phase = 'assessing_evidence';
    goal.ownerDecision = null;
    goal.nextEvaluationAt = null;
    addGoalEvent(goal, 'director', 'assessing_evidence', '새 Director 턴이 Worker 결과와 워크플로 게이트를 평가합니다.', { runId: run.id, reason });
    run.status = 'running';
    run.startedAt = now();
    this._progress(run, 'assessing_evidence', '완료된 Worker 카드의 결과·검증·공개 근거를 읽고 있습니다.', { goalId: goal.id });

    try {
      await this._ensureBoard(director);
      let candidate = null;
      let candidateError = null;
      try { candidate = await this._captureGoalCandidate(director, goal); }
      catch (error) { candidateError = error.message; }
      const evidence = await this._collectGoalEvidence(director, goal);
      const workflowGateAudit = evaluateWorkflowGates(goal.workflowId, evidence, { expectedCandidate: candidate });
      const acceptanceAudit = evaluateGoalAcceptance(goal, evidence, {
        gateTaskId: workflowGateAudit.approvedGateTaskId,
      });
      const gateAudit = {
        ...workflowGateAudit,
        satisfied: Boolean(candidate) && workflowGateAudit.satisfied && acceptanceAudit.satisfied,
        acceptance: acceptanceAudit,
        hostCandidate: candidate,
        hostCandidateError: candidateError,
      };
      goal.evidence.push({
        at: now(),
        kind: 'workflow_gate_audit',
        waveIndex: currentWave(goal)?.index || 0,
        satisfied: gateAudit.satisfied,
        missingProfiles: gateAudit.missingProfiles,
        staleProfiles: gateAudit.staleProfiles,
      });
      goal.evidence = goal.evidence.slice(-120);
      const evaluatedWave = currentWave(goal);
      this._progress(run, 'directing', gateAudit.satisfied
        ? '필수 워크플로 게이트가 모두 최신입니다. 성공 조건 최종 판정을 요청합니다.'
        : `누락·무효 게이트 ${gateAudit.missingProfiles.length}개를 포함해 다음 wave를 판단합니다.`, { gateAudit });

      let parsed = null;
      let plan = null;
      let result = null;
      let outcome = null;
      let recoveryNote = '';
      for (let attempt = 1; attempt <= run.maxAttempts; attempt += 1) {
        run.attempt = attempt;
        run.planAttempt = attempt;
        this._save();
        try {
          const prompt = buildSupervisionPrompt({
            goal,
            evidence,
            gateAudit,
            catalog: catalogPrompt(),
            reason,
          }) + (recoveryNote ? `\n\n[HOST REJECTION]\n${recoveryNote}` : '');
          result = await this.runtime.chat({
            profile: director.profile,
            session: null,
            cwd: director.cwd,
            board: director.board,
            target: directorTarget(director),
            prompt,
            onOutput: ({ channel, text }) => this.emit('output', { runId: run.id, directorId: director.id, goalId: goal.id, channel, text }),
          });
          parsed = extractDirectorControl(result.stdout);
          plan = validateDirectorControl(parsed.control, { requiredMode: 'delegate' });
          outcome = await this._applyGoalControl({ director, goal, run, plan, publicOutput: parsed.publicOutput, gateAudit });
          break;
        } catch (error) {
          if (run.taskIds.length) throw error;
          recoveryNote = error.message;
          const retryable = error.code === 'HERMES_TIMEOUT'
            || /Director (?:control|did not return)|Goal completion rejected|workflow is immutable|Execution requests must be delegated/i.test(error.message);
          if (!retryable || attempt >= run.maxAttempts) throw error;
          this._progress(run, 'retrying', '감독 판정이 호스트 정책과 맞지 않아 새 추론 턴으로 다시 판정합니다.', {
            reason: error.message, checkpoint: 'goal_evaluation',
          });
        }
      }
      if (!outcome) throw new Error('Director supervision produced no actionable Goal outcome.');
      director.sessionId = null;
      if (result?.sessionId) director.lastSessionId = result.sessionId;
      run.publicDecisions = plan.decisions;
      run.workflowId = goal.workflowId;
      run.status = 'completed';
      run.phase = outcome.state === 'completed' ? 'goal_completed'
        : outcome.state === 'blocked' ? 'goal_blocked'
          : outcome.state === 'awaiting_owner' ? 'awaiting_owner' : 'delegated';
      if (evaluatedWave?.status === 'completed' && !evaluatedWave.assessment) {
        evaluatedWave.assessment = { at: now(), runId: run.id, state: outcome.state, decisions: plan.decisions, gateAudit };
      }
      goal.evaluationFailures = 0;
      goal.nextEvaluationAt = null;
      director.lastSummary = run.output.slice(-2000);
      director.status = 'idle';
      this._progress(run, run.phase, outcome.taskIds.length
        ? `판정 완료. ${outcome.taskIds.length}개 후속 작업을 배치하고 Goal 감독을 계속합니다.`
        : `판정 완료. Goal 상태는 ${goal.status}입니다.`, { goalId: goal.id, outcome: outcome.state });
      if (outcome.taskIds.length) {
        queueMicrotask(() => this.tickDirector(director.id).catch(error => {
          if (this.listenerCount('error')) this.emit('error', error);
        }));
      }
      return { goalId: goal.id, runId: run.id, state: outcome.state, taskIds: outcome.taskIds };
    } catch (error) {
      run.status = 'failed';
      run.phase = 'failed';
      run.error = error.message;
      run.output = '';
      goal.evaluationFailures += 1;
      if (goal.evaluationFailures >= DEFAULT_MAX_EVALUATION_FAILURES) {
        this._parkGoalForOwner(goal, {
          kind: 'evaluation_failure',
          required: true,
          question: `Director 자동 평가가 ${goal.evaluationFailures}회 연속 실패했습니다. 재시도할지 결정해 주세요.`,
          options: ['다시 시도', '차단하고 종료'],
          optionActions: { '다시 시도': 'retry_evaluation', '차단하고 종료': 'stop' },
          evidence: [error.message],
        }, '반복된 Director 평가 실패로 Owner 판단을 기다립니다.');
      } else {
        goal.status = goal.waves.length ? 'evaluating' : 'planning';
        goal.phase = 'retry_scheduled';
        goal.nextEvaluationAt = new Date(Date.now() + Math.min(60000, goal.evaluationFailures * 15000)).toISOString();
        addGoalEvent(goal, 'error', 'retry_scheduled', 'Director 평가 실패 후 자동 재시도를 예약했습니다.', {
          error: error.message, failureCount: goal.evaluationFailures, retryAt: goal.nextEvaluationAt,
        });
      }
      director.status = 'error';
      run.progressEvents ||= [];
      run.progressEvents.push({ at: now(), phase: 'failed', message: `Goal 평가 실패: ${error.message}` });
      return { goalId: goal.id, runId: run.id, error: error.message };
    } finally {
      run.completedAt = now();
      this.goalLocks.delete(goal.id);
      this._save();
      this.emit('run', { ...run });
      this.emit('goal', { ...goal });
    }
  }

  async _resumeMaterializingWave(director, goal, wave) {
    if (!wave || wave.status !== 'materializing' || this.goalLocks.has(goal.id) || director.status === 'running') {
      return { skipped: true };
    }
    if (goal.nextEvaluationAt && Date.parse(goal.nextEvaluationAt) > Date.now()) {
      return { skipped: true, retryAt: goal.nextEvaluationAt };
    }
    this.goalLocks.add(goal.id);
    const run = this._createSupervisionRun(director, goal, 'materialization_recovery');
    run.kind = 'materialization_recovery';
    run.status = 'running';
    run.startedAt = now();
    director.status = 'running';
    goal.status = wave.kind === 'remediation' ? 'remediating'
      : ['review', 'verification'].includes(wave.kind) ? 'verifying' : 'executing';
    goal.phase = 'materialization_recovery';
    addGoalEvent(goal, 'recovery', 'materialization_recovery', '저장된 action journal에서 미생성 Worker 카드를 재개합니다.', {
      waveId: wave.id,
      pendingActionIds: (wave.actions || []).filter(action => !action.taskId).map(action => action.id),
    });
    this._progress(run, 'materialization_recovery', '중단된 Worker 배치를 동일 idempotency key로 복구합니다.', { goalId: goal.id, waveId: wave.id });
    try {
      const plan = {
        mode: 'delegate',
        state: 'executing',
        workflowId: wave.workflowId || goal.workflowId,
        requirements: wave.requirements || [],
        decisions: wave.decisions || [],
        actions: wave.actions || [],
        ownerDecision: { required: false, question: null, options: [], evidence: [] },
      };
      const outcome = await this._materializeGoalWave({ director, goal, run, plan, existingWave: wave });
      run.status = 'completed';
      run.phase = 'delegated';
      run.output = `중단된 wave ${wave.index}의 남은 ${outcome.taskIds.length}개 Worker 카드를 복구했습니다.`;
      director.status = 'idle';
      director.lastSummary = run.output;
      goal.nextEvaluationAt = null;
      this._progress(run, 'delegated', 'Action journal 복구를 완료하고 Worker 감시를 계속합니다.', {
        goalId: goal.id, waveId: wave.id, taskIds: wave.taskIds,
      });
      queueMicrotask(() => this.tickDirector(director.id).catch(error => {
        if (this.listenerCount('error')) this.emit('error', error);
      }));
      return { goalId: goal.id, runId: run.id, recoveredTaskIds: outcome.taskIds };
    } catch (error) {
      run.status = 'failed';
      run.phase = 'failed';
      run.error = error.message;
      director.status = 'error';
      if ((wave.materializationFailures || 0) >= DEFAULT_MAX_EVALUATION_FAILURES) {
        this._parkGoalForOwner(goal, {
          kind: 'materialization_failure',
          required: true,
          question: 'Worker 카드 생성이 반복 실패했습니다. 환경을 확인한 뒤 재시도할지 결정해 주세요.',
          options: ['다시 시도', '차단하고 종료'],
          optionActions: { '다시 시도': 'retry_materialization', '차단하고 종료': 'stop' },
          evidence: [error.message],
        });
      } else {
        goal.nextEvaluationAt = new Date(Date.now() + Math.min(60000, (wave.materializationFailures || 1) * 15000)).toISOString();
      }
      return { goalId: goal.id, runId: run.id, error: error.message };
    } finally {
      run.completedAt = now();
      this.goalLocks.delete(goal.id);
      this._save();
      this.emit('run', { ...run });
      this.emit('goal', { ...goal });
    }
  }

  async _resumeApprovedAuthority(director, goal, pending) {
    if (!pending?.plan || pending.planDigest !== goal.pendingAuthorityPlan?.planDigest
      || this.goalLocks.has(goal.id) || director.status === 'running') return { skipped: true };
    this.goalLocks.add(goal.id);
    const run = this._createSupervisionRun(director, goal, 'owner_authority_approved');
    run.kind = 'authority_resume';
    run.status = 'running';
    run.startedAt = now();
    director.status = 'running';
    let reevaluate = false;
    try {
      const observedPlanDigest = persistedAuthorityPlanDigest(pending);
      if (!observedPlanDigest || observedPlanDigest !== pending.planDigest
        || pending.plan.workflowId !== goal.workflowId) {
        throw new Error('Persisted Owner-approved authority plan no longer matches its exact approval digest.');
      }
      if (pending.kind === 'completion') {
        const candidate = await this._captureGoalCandidate(director, goal);
        if (!candidate || candidate.digest !== pending.candidateDigest) {
          goal.pendingAuthorityPlan = null;
          goal.status = 'evaluating';
          goal.phase = 'candidate_changed_after_approval';
          run.status = 'completed';
          run.phase = 'reevaluation_required';
          run.output = 'Owner 승인 이후 후보 리비전이 변경되어 기존 승인을 사용하지 않고 새 증거 평가를 예약했습니다.';
          addGoalEvent(goal, 'authority', 'candidate_changed_after_approval', run.output, {
            approvedCandidate: pending.candidateDigest,
            observedCandidate: candidate?.digest || null,
          });
          reevaluate = true;
          return { goalId: goal.id, runId: run.id, state: 'evaluating' };
        }
      }
      // The approval is bound to this exact validated plan. Never ask the model
      // to regenerate it after Owner approval.
      goal.pendingAuthorityPlan = null;
      const outcome = await this._applyGoalControl({
        director, goal, run, plan: cloneJson(pending.plan), publicOutput: pending.publicOutput || '',
        gateAudit: pending.kind === 'completion' ? cloneJson(pending.gateAudit) : null,
      });
      if (outcome.state === 'awaiting_owner') throw new Error('Exact Owner-approved plan was not recognized by the authority ledger.');
      run.status = 'completed';
      run.phase = outcome.state === 'completed' ? 'goal_completed' : 'delegated';
      run.publicDecisions = [...(pending.plan.decisions || [])];
      run.workflowId = goal.workflowId;
      director.status = 'idle';
      director.lastSummary = run.output.slice(-2000);
      addGoalEvent(goal, 'authority', run.phase, 'Owner가 승인한 정확한 계획을 변경 없이 실행했습니다.', {
        planDigest: pending.planDigest, taskIds: outcome.taskIds,
      });
      if (outcome.taskIds.length) queueMicrotask(() => this.tickDirector(director.id).catch(error => {
        if (this.listenerCount('error')) this.emit('error', error);
      }));
      return { goalId: goal.id, runId: run.id, state: outcome.state, taskIds: outcome.taskIds };
    } catch (error) {
      run.status = 'failed';
      run.phase = 'failed';
      run.error = error.message;
      director.status = 'error';
      if (!goal.waves.some(wave => wave.status === 'materializing')) {
        goal.pendingAuthorityPlan = pending;
        this._parkGoalForOwner(goal, {
          kind: 'authority_resume_failure',
          question: '승인된 정확한 계획을 실행하지 못했습니다. 환경 확인 후 다시 시도할까요?',
          options: ['승인 계획 다시 시도', '차단하고 종료'],
          optionActions: { '승인 계획 다시 시도': 'retry_authority', '차단하고 종료': 'stop' },
          evidence: [error.message],
          approvalKind: pending.approvalKind,
          planDigest: pending.planDigest,
          throughWave: pending.throughWave,
        });
      }
      return { goalId: goal.id, runId: run.id, error: error.message };
    } finally {
      run.completedAt = now();
      this.goalLocks.delete(goal.id);
      this._save();
      this.emit('run', { ...run });
      this.emit('goal', { ...goal });
      if (reevaluate) queueMicrotask(() => this._evaluateGoal(goal.id, { reason: 'candidate_changed_after_approval' }).catch(error => {
        if (this.listenerCount('error')) this.emit('error', error);
      }));
    }
  }

  async _resumeInitialGoalPlanning(director, goal) {
    if (this.goalLocks.has(goal.id) || director.status === 'running'
      || this.state.runs.some(run => run.goalId === goal.id && ['queued', 'running'].includes(run.status))) {
      return { skipped: true };
    }
    if (goal.nextEvaluationAt && Date.parse(goal.nextEvaluationAt) > Date.now()) {
      return { skipped: true, retryAt: goal.nextEvaluationAt };
    }
    this.goalLocks.add(goal.id);
    const createdAt = now();
    const run = {
      id: randomUUID(), directorId: director.id, projectId: director.projectId, goalId: goal.id,
      kind: 'planning_recovery', status: 'queued', prompt: goal.objective,
      output: '', error: null, createdAt, startedAt: null, completedAt: null,
      requestedMode: 'delegate', resolvedMode: 'delegate', phase: 'queued', attempt: 0,
      analysisAttempt: 0, planAttempt: 0, maxAttempts: 2, analysis: null,
      workflowId: null, taskIds: [], actions: [], publicDecisions: [],
      progressEvents: [{ at: createdAt, phase: 'queued', message: '중단된 초기 Goal 분석·계획을 새 Director 턴에서 재개합니다.' }],
    };
    this.state.runs.push(run);
    goal.lastRunId = run.id;
    director.lastRunId = run.id;
    director.status = 'running';
    addGoalEvent(goal, 'recovery', 'planning', '초기 분석이 완성되지 않아 분석·워크플로 선택부터 재개합니다.', { runId: run.id });
    this._save();
    try {
      await this._executeChat(run.id);
      return { goalId: goal.id, runId: run.id, status: this.getRun(run.id)?.status };
    } finally {
      this.goalLocks.delete(goal.id);
      this._save();
    }
  }

  async _observeWakeSignals(director, goal) {
    const wave = currentWave(goal);
    if (!wave) return null;
    const candidates = (wave.taskIds || [])
      .map(taskId => goal.taskRecords.find(record => record.taskId === taskId))
      .filter(record => record && isTerminalTask(record.status) && !record.wakeObservedAt && record.wakeOn?.length);
    if (!candidates.length) return goal.pendingWakeReason || null;
    const detailsByTaskId = new Map();
    const findingCandidates = candidates.filter(record => record.wakeOn.includes('finding'));
    if (typeof this.runtime.taskDetails === 'function' && findingCandidates.length) {
      const loaded = await mapWithConcurrency(findingCandidates, 4, async record => {
        try {
          return [record.taskId, await this.runtime.taskDetails({
            profile: director.profile, board: director.board, cwd: director.cwd,
            taskId: record.taskId, target: directorTarget(director),
          })];
        } catch { return [record.taskId, null]; }
      });
      for (const [taskId, details] of loaded) if (details) detailsByTaskId.set(taskId, details);
    }
    const evidenceById = new Map(goalTaskEvidence(goal, detailsByTaskId).map(item => [item.taskId, item]));
    const priority = { completion: 1, finding: 2, failure: 3 };
    let strongest = goal.pendingWakeReason || null;
    wave.wakeSignals ||= [];
    for (const record of candidates) {
      const detailsUnavailableForFinding = record.wakeOn.includes('finding')
        && !detailsByTaskId.has(record.taskId)
        && !record.wakeOn.includes('completion')
        && !(['blocked', 'failed', 'cancelled'].includes(record.status) && record.wakeOn.includes('failure'));
      if (detailsUnavailableForFinding) continue;
      const evidence = evidenceById.get(record.taskId);
      if (detailsByTaskId.has(record.taskId)) {
        record.summary = evidence.summary;
        record.report = compactReport(evidence.report);
        record.reportApproved = evidence.persistedReportApproved === null
          ? isStructuredEvidenceApproved(evidence) : evidence.persistedReportApproved;
      }
      const report = evidence?.report;
      const hasFinding = report?.schema === 'review.v1'
        && (['fail', 'inconclusive'].includes(report.verdict)
          || report.findings?.some(finding => finding?.blocking));
      const failed = ['blocked', 'failed', 'cancelled'].includes(record.status);
      const signals = [];
      if (failed && record.wakeOn.includes('failure')) signals.push('failure');
      if (hasFinding && record.wakeOn.includes('finding')) signals.push('finding');
      if (record.wakeOn.includes('completion')) signals.push('completion');
      record.wakeObservedAt = now();
      for (const signal of signals) {
        wave.wakeSignals.push({ at: record.wakeObservedAt, signal, taskId: record.taskId });
        if (!strongest || priority[signal] > priority[strongest]) strongest = signal;
        addGoalEvent(goal, 'wake', `worker_${signal}`, `Worker ${record.taskId}의 ${signal} 신호를 감지했습니다.`, {
          taskId: record.taskId, signal, status: record.status,
        });
      }
    }
    goal.pendingWakeReason = strongest;
    this._save();
    return strongest;
  }

  async _maybeSuperviseGoal(director, boardTasks) {
    const goal = this._activeGoal(director.id);
    if (!goal) return { skipped: true };
    if (goal.status === 'awaiting_owner') return { monitored: true, awaitingOwner: true };
    const pendingAuthority = goal.pendingAuthorityPlan;
    const pendingApproved = pendingAuthority && (goal.ownerApprovals || []).some(item => (
      item.kind === pendingAuthority.approvalKind
        && item.planDigest === pendingAuthority.planDigest
        && Number(item.throughWave) >= Number(pendingAuthority.throughWave)
    ));
    if (pendingApproved) return this._resumeApprovedAuthority(director, goal, pendingAuthority);
    if (goal.reanalysisRequired || !goal.workflowId || !goal.analysis) return this._resumeInitialGoalPlanning(director, goal);
    const materializing = currentWave(goal);
    if (materializing?.status === 'materializing') {
      return this._resumeMaterializingWave(director, goal, materializing);
    }
    const before = JSON.stringify({
      status: goal.status,
      phase: goal.phase,
      records: goal.taskRecords?.map(record => [record.taskId, record.status, record.completedAt, record.missingObservations, record.missingSince]),
      waves: goal.waves?.map(wave => [wave.id, wave.status, wave.completedAt]),
    });
    syncGoalTasks(goal, boardTasks, now());
    const waveBeforeEvaluation = currentWave(goal);
    const listedIds = new Set(boardTasks.map(task => task?.id).filter(Boolean));
    for (const record of goal.taskRecords || []) {
      if (!listedIds.has(record.taskId) || (!record.missingObservations && !record.missingSince)) continue;
      record.missingObservations = 0;
      record.missingSince = null;
      record.lastMissingAt = null;
    }
    const missing = (waveBeforeEvaluation?.taskIds || [])
      .map(taskId => goal.taskRecords.find(record => record.taskId === taskId))
      .filter(record => record && !listedIds.has(record.taskId) && !isTerminalTask(record.status));
    if (missing.length) {
      const recovered = await Promise.all(missing.map(async record => {
        if (typeof this.runtime.taskDetails !== 'function') return null;
        try {
          const details = await this.runtime.taskDetails({
            profile: director.profile, board: director.board, cwd: director.cwd,
            taskId: record.taskId, target: directorTarget(director),
          });
          return details?.task || null;
        } catch { return null; }
      }));
      syncGoalTasks(goal, [...boardTasks, ...recovered.filter(Boolean)], now());
      const observedAt = now();
      missing.forEach((record, index) => {
        if (recovered[index]) {
          record.missingObservations = 0;
          record.missingSince = null;
          return;
        }
        record.missingObservations = (Number(record.missingObservations) || 0) + 1;
        record.missingSince ||= observedAt;
        record.lastMissingAt = observedAt;
        if (record.missingObservations >= 3 && !isTerminalTask(record.status)) {
          record.status = 'failed';
          record.completedAt = observedAt;
          record.failureKind = 'lost_task';
          record.pausedByOwner = false;
          record.pausePending = false;
          record.resumePending = false;
          record.summary = 'Hermes board and task details both lost this durable task for three consecutive observations.';
          addGoalEvent(goal, 'error', 'worker_lost', `Worker ${record.taskId}가 3회 연속 보드와 상세 조회에서 사라져 실패로 확정했습니다.`, {
            taskId: record.taskId, waveId: waveBeforeEvaluation?.id || null,
          }, observedAt);
        }
      });
    }
    const after = JSON.stringify({
      status: goal.status,
      phase: goal.phase,
      records: goal.taskRecords?.map(record => [record.taskId, record.status, record.completedAt, record.missingObservations, record.missingSince]),
      waves: goal.waves?.map(wave => [wave.id, wave.status, wave.completedAt]),
    });
    if (before !== after) {
      const wave = currentWave(goal);
      addGoalEvent(goal, 'monitor', 'worker_progress', `Wave ${wave?.index || 0} 상태를 ${wave?.status || 'planning'}로 갱신했습니다.`, {
        waveId: wave?.id || null,
        taskStates: (goal.currentWaveTaskIds || []).map(taskId => ({
          taskId, status: goal.taskRecords.find(record => record.taskId === taskId)?.status || 'unknown',
        })),
      });
      this._save();
    }
    await this._observeWakeSignals(director, goal);
    if (!goalReadyForEvaluation(goal)) return { monitored: true, ready: false };
    if (director.status === 'running') return { monitored: true, ready: true, deferred: true };
    const reason = goal.pendingWakeReason || (goal.waves.length ? 'wave_completed' : 'recovery');
    goal.pendingWakeReason = null;
    return this._evaluateGoal(goal.id, { reason });
  }

  async answerGoalDecision(directorId, goalId, { answer = '', selectedOption = null } = {}) {
    const director = this.getDirector(directorId);
    const goal = this.getGoal(goalId);
    if (!director || !goal || goal.directorId !== directorId) throw new Error('Goal not found');
    if (goal.status !== 'awaiting_owner' || !goal.ownerDecision?.required) throw new Error('Goal is not awaiting an Owner decision');
    if (director.status === 'running' || this.goalLocks.has(goal.id)) throw new Error('Director is already running');
    this._assertAcceptingWork(director);
    const response = String(answer || selectedOption || '').trim().slice(0, 12000);
    if (!response) throw new Error('Owner decision answer is required');
    const decidedAt = now();
    const decision = goal.ownerDecision;
    const requestedOption = selectedOption ? String(selectedOption) : null;
    const selectedLabel = requestedOption && decision.options.includes(requestedOption) ? requestedOption
      : decision.options.includes(response) ? response : null;
    const ownerAction = selectedLabel ? decision.optionActions?.[selectedLabel] || null : null;
    const pendingAuthority = goal.pendingAuthorityPlan;
    if (decision.kind === 'workflow_approval' && ownerAction === 'approve'
      && (!decision.approvalKind || !decision.planDigest || !pendingAuthority
        || pendingAuthority.planDigest !== decision.planDigest
        || pendingAuthority.approvalKind !== decision.approvalKind)) {
      throw new Error('Owner approval is not bound to the currently persisted exact action plan. Re-evaluation is required.');
    }
    if (decision.kind === 'workflow_approval' && ownerAction === 'reevaluate') {
      goal.verificationBarrier = {
        requestedAt: decidedAt,
        afterWave: goal.waves.length,
        candidateDigest: pendingAuthority?.candidateDigest || goal.currentCandidate?.digest || null,
        planDigest: decision.planDigest || null,
      };
    }
    goal.ownerAnswers.push({
      at: decidedAt,
      question: decision.question,
      answer: response,
      selectedOption: selectedLabel,
      action: ownerAction,
      evidence: decision.evidence,
    });
    if (decision.kind === 'loop_limit' && ownerAction === 'extend') {
      goal.maxCycles += 4;
      goal.maxRemediationLoops += 1;
    }
    if (decision.kind === 'workflow_approval' && ownerAction === 'approve') {
      goal.ownerApprovals ||= [];
      goal.ownerApprovals.push({
        at: decidedAt,
        kind: decision.approvalKind,
        planDigest: decision.planDigest,
        throughWave: Number(decision.throughWave) || goal.waves.length,
        answer: response,
      });
    }
    if (ownerAction === 'stop') {
      this._finishGoal(goal, 'blocked', 'Owner가 자동 감독을 중단하고 Goal을 차단했습니다.', { ownerAnswer: response });
      this._save();
      this.emit('goal', { ...goal });
      return { ...goal };
    }
    const resumeAuthority = decision.kind === 'workflow_approval' && ownerAction === 'approve'
      ? pendingAuthority : decision.kind === 'authority_resume_failure' && ownerAction === 'retry_authority'
        ? pendingAuthority : null;
    if (!resumeAuthority && ['workflow_approval', 'authority_resume_failure'].includes(decision.kind)) {
      goal.pendingAuthorityPlan = null;
    }
    goal.ownerDecision = null;
    const resumeMaterialization = decision.kind === 'materialization_failure'
      && ownerAction === 'retry_materialization'
      && currentWave(goal)?.status === 'materializing';
    const resumeWave = resumeMaterialization ? currentWave(goal) : null;
    const resumeInitialPlanning = decision.kind === 'initial_clarification';
    if (resumeInitialPlanning) goal.reanalysisRequired = true;
    goal.status = resumeMaterialization
      ? (resumeWave.kind === 'remediation' ? 'remediating' : ['review', 'verification'].includes(resumeWave.kind) ? 'verifying' : 'executing')
      : resumeAuthority ? 'planning'
        : goal.waves.length ? 'evaluating' : 'planning';
    goal.phase = 'owner_answered';
    goal.evaluationFailures = 0;
    goal.nextEvaluationAt = null;
    addGoalEvent(goal, 'owner', 'owner_answered', 'Owner 결정이 기록되어 Director 감독을 재개합니다.', {
      answer: response,
    }, decidedAt);
    this._save();
    queueMicrotask(() => (resumeMaterialization
      ? this._resumeMaterializingWave(director, goal, resumeWave)
      : resumeAuthority ? this._resumeApprovedAuthority(director, goal, resumeAuthority)
        : resumeInitialPlanning ? this._resumeInitialGoalPlanning(director, goal)
          : this._evaluateGoal(goal.id, { reason: 'owner_decision' })).catch(error => {
      if (this.listenerCount('error')) this.emit('error', error);
    }));
    return { ...goal };
  }

  async createObjective(directorId, { title, body }) {
    const director = this.getDirector(directorId);
    if (!director || director.kind !== 'project') throw new Error('Project Director not found');
    if (!director.cwd) throw new Error('Director has no assigned project directory');
    this._assertAcceptingWork(director);
    await this._ensureBoard(director);
    this._assertAcceptingWork(director);
    const result = await this.runtime.createObjective({
      profile: director.profile, board: director.board, cwd: director.cwd, title, body, target: directorTarget(director),
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

  _assertAcceptingWork(director) {
    if (this.shutdownPending) throw new Error('Praetorium 종료 확인 중에는 새 작업을 시작할 수 없습니다.');
    if (director?.projectId && this.detachingProjects.has(director.projectId)) {
      throw new Error('프로젝트 배정 제거 확인 중에는 새 작업을 시작할 수 없습니다.');
    }
  }

  async _assertProjectDetachable(projectId) {
    const director = this.state.directors.find(item => item.projectId === projectId);
    if (!director) return true;
    const activeGoal = this._activeGoal(director.id);
    if (activeGoal) throw new Error(`Goal ${activeGoal.id}이 ${activeGoal.status} 상태라 프로젝트 배정을 제거할 수 없습니다.`);
    if (director.status === 'running' || this.state.runs.some(run => run.projectId === projectId && ['queued', 'running'].includes(run.status))) {
      throw new Error('Director 실행이 진행 중이어서 프로젝트 배정을 제거할 수 없습니다.');
    }
    const tasks = await this._refreshBoard(director, { force: true });
    if (director.status === 'running' || this.state.runs.some(run => run.projectId === projectId && ['queued', 'running'].includes(run.status))) {
      throw new Error('Director 실행이 진행 중이어서 프로젝트 배정을 제거할 수 없습니다.');
    }
    const pending = tasks.filter(task => !['done', 'archived', 'failed'].includes(task.status));
    if (pending.length) throw new Error(`미완료 작업 ${pending.length}개가 있어 프로젝트 배정을 제거할 수 없습니다.`);
    return true;
  }

  async detachProject(projectId, removeProject) {
    if (this.detachingProjects.has(projectId)) throw new Error('프로젝트 배정 제거 확인이 이미 진행 중입니다.');
    this.detachingProjects.add(projectId);
    try {
      await this._assertProjectDetachable(projectId);
      const deleted = removeProject(projectId);
      if (deleted) this.syncProjects();
      return deleted;
    } finally {
      this.detachingProjects.delete(projectId);
    }
  }

  async beginShutdown() {
    if (this.shutdownPending) return { safe: false, reason: 'Praetorium 종료 확인이 이미 진행 중입니다.' };
    this.shutdownPending = true;
    let keepLocked = false;
    const activeRuns = () => this.state.runs.filter(run => ['queued', 'running'].includes(run.status));
    try {
      const before = activeRuns();
      if (before.length) return { safe: false, reason: `Director 실행 ${before.length}개가 진행 중입니다.` };
      const directors = this.state.directors.filter(director => director.cwd);
      const boards = await Promise.all(directors.map(async director => ({
        director,
        tasks: await this._refreshBoard(director, { force: true }),
      })));
      const after = activeRuns();
      if (after.length) return { safe: false, reason: `Director 실행 ${after.length}개가 진행 중입니다.` };
      const running = boards.flatMap(({ director, tasks }) => tasks
        .filter(task => task.status === 'running').map(task => ({ directorId: director.id, taskId: task.id })));
      if (running.length) return { safe: false, reason: `Worker 실행 ${running.length}개가 진행 중입니다.`, running };
      keepLocked = true;
      return { safe: true, reason: '실행 중인 Director 또는 Worker가 없습니다.' };
    } catch (error) {
      return { safe: false, reason: `실행 상태를 안전하게 확인할 수 없습니다: ${error.message}` };
    } finally {
      if (!keepLocked) this.shutdownPending = false;
    }
  }

  async getTaskDetails(directorId, taskId) {
    const director = this.getDirector(directorId);
    if (!director || !director.cwd) throw new Error('Director not found');
    await this._ensureBoard(director);
    const details = await this.runtime.taskDetails({
      profile: director.profile, board: director.board, cwd: director.cwd, taskId, target: directorTarget(director),
    });
    if (!details?.task) throw new Error('Task not found');
    return details;
  }

  async getTaskTrace(directorId, taskId) {
    const director = this.getDirector(directorId);
    if (!director || !director.cwd) throw new Error('Director not found');
    await this._ensureBoard(director);
    const log = await this.runtime.taskLog({
      profile: director.profile, board: director.board, cwd: director.cwd, taskId, target: directorTarget(director),
    });
    return { taskId, log, observedAt: now() };
  }

  async interveneTask(directorId, taskId, message) {
    const director = this.getDirector(directorId);
    if (!director || !director.cwd) throw new Error('Director not found');
    this._assertAcceptingWork(director);
    await this._ensureBoard(director);
    this._assertAcceptingWork(director);
    await this.runtime.commentTask({
      profile: director.profile, board: director.board, cwd: director.cwd,
      taskId, message, author: 'Owner', target: directorTarget(director),
    });
    return { taskId, delivered: true, message: String(message).trim(), at: now() };
  }

  async _reconcilePendingTaskControls(director, boardTasks) {
    const byId = new Map((boardTasks || []).filter(task => task?.id).map(task => [task.id, task]));
    const pending = (this.state.goals || [])
      .filter(goal => goal.directorId === director.id && isActiveGoal(goal))
      .flatMap(goal => (goal.taskRecords || [])
        .filter(record => !isTerminalTask(record.status) && (record.pausePending || record.resumePending
          || (record.pausedByOwner && String(byId.get(record.taskId)?.status || '').toLowerCase() !== 'blocked')))
        .map(record => ({ goal, record })));
    if (!pending.length) return { tasks: boardTasks, unresolved: false };
    let unresolved = false;
    for (const { goal, record } of pending) {
      try {
        let task = byId.get(record.taskId) || null;
        if (!task && typeof this.runtime.taskDetails === 'function') {
          const details = await this.runtime.taskDetails({
            profile: director.profile, board: director.board, cwd: director.cwd,
            taskId: record.taskId, target: directorTarget(director),
          });
          task = details?.task || null;
        }
        if (!task) { unresolved = true; continue; }
        const observed = String(task.status || '').toLowerCase();
        if (record.resumePending) {
          if (['blocked', 'scheduled'].includes(observed)) {
            await this.runtime.unblockTask({
              profile: director.profile, board: director.board, cwd: director.cwd,
              taskId: record.taskId, target: directorTarget(director),
            });
          } else if (isTerminalTask(observed)) {
            throw new Error(`Cannot recover resume for terminal task (${observed})`);
          }
          record.resumePending = false;
          record.pausePending = false;
          record.pausedByOwner = false;
          record.pausedAt = null;
          record.status = 'queued';
          record.completedAt = null;
          addGoalEvent(goal, 'recovery', 'resumed_by_owner', `재시작 후 Worker ${record.taskId} 재개 요청을 복구했습니다.`, { taskId: record.taskId });
          continue;
        }
        if (isTerminalTask(observed) && observed !== 'blocked') {
          record.pausePending = false;
          record.pausedByOwner = false;
          record.pausedAt = null;
          record.status = observed;
          record.completedAt ||= now();
          addGoalEvent(goal, 'recovery', 'pause_race_terminal', `Worker ${record.taskId}가 pause 적용 전에 ${observed}로 끝나 완료 상태를 보존했습니다.`, { taskId: record.taskId });
          continue;
        }
        if (observed === 'running') {
          await this.runtime.reclaimTask({
            profile: director.profile, board: director.board, cwd: director.cwd,
            taskId: record.taskId, reason: 'Recover durable Owner pause intent', target: directorTarget(director),
          });
        }
        if (observed !== 'blocked') {
          await this.runtime.blockTask({
            profile: director.profile, board: director.board, cwd: director.cwd,
            taskId: record.taskId, reason: 'Recover durable Owner pause intent', target: directorTarget(director),
          });
        }
        record.pausePending = false;
        record.pausedByOwner = true;
        record.status = 'paused';
        record.completedAt = null;
        goal.phase = 'paused_by_owner';
        addGoalEvent(goal, 'recovery', 'paused_by_owner', `재시작 후 Worker ${record.taskId} pause 요청을 복구했습니다.`, { taskId: record.taskId });
      } catch (error) {
        unresolved = true;
        record.controlError = error.message;
        record.lastControlAttemptAt = now();
      }
    }
    this._save();
    const tasks = await this._refreshBoard(director, { force: true }).catch(() => boardTasks);
    return { tasks, unresolved };
  }

  async controlTask(directorId, taskId, action, reason = '') {
    const director = this.getDirector(directorId);
    if (!director || !director.cwd) throw new Error('Director not found');
    this._assertAcceptingWork(director);
    await this._ensureBoard(director);
    if (!['pause', 'resume'].includes(action)) throw new Error('Unsupported task control action');
    const boardKey = this._boardKey(director);
    const controlKey = `${boardKey}\n${taskId}`;
    if (this.boardLocks.has(boardKey) || this.taskControlLocks.has(controlKey)) {
      throw new Error('Task control is already running; retry after the current board operation finishes');
    }
    this.boardLocks.add(boardKey);
    this.taskControlLocks.add(controlKey);
    let status;
    let lockedGoalId = null;
    try {
      const details = await this.runtime.taskDetails({
        profile: director.profile, board: director.board, cwd: director.cwd, taskId, target: directorTarget(director),
      });
      if (!details?.task) throw new Error('Task not found');
      status = String(details.task.status || '').toLowerCase();
      const goal = (this.state.goals || []).findLast(item => item.directorId === directorId && item.taskIds?.includes(taskId)) || null;
      const record = goal?.taskRecords?.find(item => item.taskId === taskId) || null;
      if (goal) {
        if (!isActiveGoal(goal)) throw new Error('Cannot control a Worker owned by a terminal Goal');
        if (!currentWave(goal)?.taskIds?.includes(taskId)) {
          throw new Error('Cannot control a Worker from a historical Goal wave');
        }
        if (this.goalLocks.has(goal.id)) {
          throw new Error('Goal supervision is already running; retry Worker control after it finishes');
        }
        // Serialize Owner control with the post-wave evaluator. In particular,
        // a blocked task must not be unblocked while a Director is accepting
        // that same terminal observation as the end of the wave.
        this.goalLocks.add(goal.id);
        lockedGoalId = goal.id;
      }
      if (action === 'pause') {
        if (isTerminalTask(status)) throw new Error(`Cannot pause terminal task (${status})`);
        const note = String(reason || 'Owner가 실행을 일시정지했습니다.').slice(0, 2000);
        const requestedAt = now();
        if (record) {
          record.pausedByOwner = true;
          record.pausePending = true;
          record.pausedAt = requestedAt;
          record.status = 'paused';
          record.completedAt = null;
          goal.phase = 'pause_requested';
          addGoalEvent(goal, 'owner', 'pause_requested', `Owner가 Worker ${taskId}의 일시정지를 요청했습니다.`, { taskId, reason: note });
          // Durable intent closes the completion/evaluation race before the
          // first external reclaim/block await.
          this._save();
        }
        try {
          if (status === 'running') {
            await this.runtime.reclaimTask({
              profile: director.profile, board: director.board, cwd: director.cwd, taskId, reason: note, target: directorTarget(director),
            });
          }
          const afterReclaim = await this.runtime.taskDetails({
            profile: director.profile, board: director.board, cwd: director.cwd, taskId, target: directorTarget(director),
          });
          const observed = String(afterReclaim?.task?.status || status).toLowerCase();
          if (isTerminalTask(observed) && observed !== 'blocked') {
            if (record) {
              record.pausedByOwner = false;
              record.pausePending = false;
              record.pausedAt = null;
              record.status = observed;
              record.completedAt ||= now();
            }
            throw new Error(`Task reached terminal state before pause completed (${observed})`);
          }
          if (observed !== 'blocked') {
            await this.runtime.blockTask({
              profile: director.profile, board: director.board, cwd: director.cwd, taskId, reason: note, target: directorTarget(director),
            });
          }
          if (record) {
            record.pausePending = false;
            record.status = 'paused';
            goal.phase = 'paused_by_owner';
            addGoalEvent(goal, 'owner', 'paused_by_owner', `Owner가 Worker ${taskId}를 일시정지했습니다. 자동 완료 판정에서 제외합니다.`, { taskId, reason: note });
          }
        } catch (error) {
          if (record && !record.pausedByOwner) goal.phase = goal.status;
          this._save();
          throw error;
        }
      } else {
        if (isTerminalTask(status) && status !== 'blocked') throw new Error(`Cannot resume terminal task (${status})`);
        if (!record?.pausedByOwner && !['blocked', 'scheduled'].includes(status)) throw new Error('Only a paused task can be resumed');
        if (record) {
          record.resumePending = true;
          this._save();
        }
        await this.runtime.unblockTask({
          profile: director.profile, board: director.board, cwd: director.cwd, taskId, target: directorTarget(director),
        });
        if (record) {
          record.pausedByOwner = false;
          record.pausePending = false;
          record.resumePending = false;
          record.pausedAt = null;
          record.status = 'queued';
          record.completedAt = null;
          goal.phase = goal.status;
          addGoalEvent(goal, 'owner', 'resumed_by_owner', `Owner가 Worker ${taskId}를 재개했습니다.`, { taskId });
        }
      }
      this._save();
    } finally {
      if (lockedGoalId) this.goalLocks.delete(lockedGoalId);
      this.taskControlLocks.delete(controlKey);
      this.boardLocks.delete(boardKey);
    }
    await this._refreshBoard(director, { force: true }).catch(() => {});
    if (action === 'resume') void this.tickDirector(directorId).catch(error => {
      if (this.listenerCount('error')) this.emit('error', error);
    });
    return { taskId, action, previousStatus: status, accepted: true, at: now() };
  }

  async tickDirector(directorId, requestedMax = null) {
    const director = this.getDirector(directorId);
    const boardKey = director?.cwd ? this._boardKey(director) : null;
    if (!director || !director.cwd || this.boardLocks.has(boardKey)
      || this.shutdownPending || this.detachingProjects.has(director.projectId)) return { skipped: true };
    this.boardLocks.add(boardKey);
    let dispatchResult;
    let observedTasks = [];
    let reserved = 0;
    try {
      let tasks = await this._refreshBoard(director, { force: true });
      if (this.shutdownPending || this.detachingProjects.has(director.projectId)) return { skipped: true };
      const controls = await this._reconcilePendingTaskControls(director, tasks);
      tasks = controls.tasks;
      const ready = tasks.filter(t => ['ready', 'todo'].includes(t.status)).length;
      const running = tasks.filter(t => t.status === 'running').length;
      const globalRunning = [...this.boardCache.values()]
        .flatMap(entry => entry.tasks)
        .filter(task => task.status === 'running').length;
      const available = adaptiveWorkerLimit({ ready, running: globalRunning + this.dispatchReservations });
      const requested = requestedMax == null ? available : Math.max(0, Math.min(12, Number(requestedMax) || 0));
      const max = controls.unresolved ? 0 : Math.min(requested, available);
      reserved = max;
      this.dispatchReservations += reserved;
      // Hermes performs dead-PID/orphan reconciliation inside every dispatch
      // pass, including --max 0. Skipping dispatch when no task is ready leaves
      // a worker that exited without a terminal board tool stuck as running.
      const result = await this.runtime.dispatch({ profile: director.profile, board: director.board, cwd: director.cwd, max, target: directorTarget(director) });
      observedTasks = await this._refreshBoard(director, { force: true }).catch(() => tasks);
      dispatchResult = {
        ready, running, globalRunning, available, allocated: max,
        spawned: result.json?.spawned ?? null, dispatch: result.json, tasks: observedTasks,
      };
    } finally {
      this.dispatchReservations = Math.max(0, this.dispatchReservations - reserved);
      this.boardLocks.delete(boardKey);
    }
    const supervision = await this._maybeSuperviseGoal(director, observedTasks);
    return { ...dispatchResult, supervision };
  }

  async tick() {
    // Boards are independent failure domains. A missing/slow repository in
    // slot 1 must never stall dispatch for slots 2 and 3.
    const eligible = this.state.directors.filter(director => director.cwd);
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
    const recentGoals = this.listGoals({ limit: 50 });
    const activeGoals = this.listGoals({ activeOnly: true, limit: 200 });
    const activeIds = new Set(activeGoals.map(goal => goal.id));
    const goals = [...activeGoals, ...recentGoals.filter(goal => !activeIds.has(goal.id))];
    const workerTasks = [...this.boardCache.values()].flatMap(entry => entry.tasks);
    const activeDirectorRuns = runs.filter(r => ['queued', 'running'].includes(r.status)).length;
    const activeWorkers = workerTasks.filter(task => task.status === 'running').length;
    return {
      localOnly: true,
      stateRecovery: this.stateRecovery,
      directors: this.listDirectors(),
      activeRuns: activeDirectorRuns,
      sessions: {
        directors: activeDirectorRuns,
        workers: activeWorkers,
        total: activeDirectorRuns + activeWorkers,
      },
      recentRuns: this.listRuns({ limit: 20 }),
      goals,
      activeGoals,
      workflows: WORKFLOWS,
      skills: PRAETORIUM_SKILLS,
      workerProfiles: WORKER_PROFILES,
      terminalTaskStates: [...TERMINAL_TASK_STATES],
    };
  }
}

export const _test = {
  actionPlanDigest, persistedAuthorityPlanDigest,
  defaultState, createdTaskId, taskBody, projectCwd, validProject, directorTarget,
};
