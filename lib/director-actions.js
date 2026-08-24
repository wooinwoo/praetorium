import { PRAETORIUM_SKILLS, WORKER_PROFILES, workflowById } from './workflow-catalog.js';

const CONTROL_RE = /<PRAETORIUM_CONTROL>\s*([\s\S]*?)\s*<\/PRAETORIUM_CONTROL>/i;
const ANALYSIS_RE = /<PRAETORIUM_ANALYSIS>\s*([\s\S]*?)\s*<\/PRAETORIUM_ANALYSIS>/i;
const EXECUTION_PATTERNS = [
  /(?:해줘|해라|하자|해봐|해주세요|찾아|조사|만들|고쳐|수정|구현|작성|검증|테스트|배포|릴리스|올려|정리해|분석해|설계해|실행해|진행해|구해와)/i,
  /\b(?:build|fix|implement|research|find|create|write|test|verify|review|deploy|release|ship|investigate)\b/i,
];
const CONVERSATION_PATTERNS = [
  /^(?:ㅎㅇ+|하이|안녕|ㅇㅇ+|응+|그래+|오케이|ok|okay|고마워|ㄱㅅ)[!.?\s]*$/i,
  /(?:뭐|무엇|왜|어떻게|언제|어디|누구|몇|맞아|인가|거야|있어|없어|설명|상태|현황|스킬)/i,
];
const READ_ONLY_REQUEST_PATTERNS = [
  /(?:작업|진행|상태|현황|상황|결과|변경(?:사항)?|내용|맥락|대화|세션|커밋).{0,30}(?:요약|정리|설명|확인|알려|말해|보여|어디까지)/i,
  /^(?:지금|현재|이번에|그동안)?\s*(?:뭘?\s*했는지\s*)?(?:요약|설명)(?:해\s*줘|해주세요|해봐|좀)?[!.?\s]*$/i,
  /\b(?:summari[sz]e|explain|status update|what (?:did|are|is|was|were))\b/i,
];
const MUTATING_REQUEST_PATTERNS = [
  /(?:고쳐|수정(?:해|하|해서|하여)|구현|만들|작성(?:해|하|해서|하여)|추가(?:해|하)|삭제(?:해|하)|옮겨|바꿔|변경(?:해|하)|리팩터|배포(?:해|하)|릴리스(?:해|하)|실행(?:해|하)|설치(?:해|하))/i,
  /(?:파일|폴더|디렉터리|코드)\s*(?:을|를)?\s*정리(?:해|하)/i,
  /\b(?:build|fix|implement|create|write|edit|delete|remove|refactor|deploy|release|ship|install|run)\b/i,
];

function cleanStrings(values, limit = 20) {
  if (!Array.isArray(values)) return [];
  return values.map(value => String(value || '').trim().slice(0, 4000)).filter(Boolean).slice(0, limit);
}

export function inferRequestMode(prompt, requested = 'auto') {
  if (requested === 'conversation' || requested === 'delegate') return requested;
  const text = String(prompt || '').trim();
  const readOnlyRequest = READ_ONLY_REQUEST_PATTERNS.some(pattern => pattern.test(text));
  const mutatingRequest = MUTATING_REQUEST_PATTERNS.some(pattern => pattern.test(text));
  if (readOnlyRequest && !mutatingRequest) return 'conversation';
  if (EXECUTION_PATTERNS.some(pattern => pattern.test(text))) return 'delegate';
  if (CONVERSATION_PATTERNS.some(pattern => pattern.test(text)) || /[?？]\s*$/.test(text)) return 'conversation';
  return 'delegate';
}

export function extractDirectorControl(output) {
  const text = String(output || '');
  const match = text.match(CONTROL_RE);
  if (!match) return { control: null, publicOutput: text.trim() };
  let control;
  try { control = JSON.parse(match[1]); }
  catch (error) { throw new Error(`Director control JSON is invalid: ${error.message}`); }
  return { control, publicOutput: text.replace(match[0], '').trim() };
}

export function extractDirectorAnalysis(output) {
  const text = String(output || '');
  const match = text.match(ANALYSIS_RE);
  if (!match) return null;
  try { return JSON.parse(match[1]); }
  catch (error) { throw new Error(`Director analysis JSON is invalid: ${error.message}`); }
}

export function validateDirectorAnalysis(value) {
  if (!value || value.schema !== 'director-analysis.v1') throw new Error('Director did not return director-analysis.v1 checkpoint data.');
  const successCriteria = cleanStrings(value.success_criteria, 24);
  if (!successCriteria.length) throw new Error('Director analysis must define at least one observable success criterion.');
  const recommendedWorkflow = String(value.recommended_workflow || '').trim();
  if (!workflowById(recommendedWorkflow)) throw new Error(`Unknown recommended workflow: ${recommendedWorkflow || '(none)'}`);
  const candidates = Array.isArray(value.workflow_candidates) ? value.workflow_candidates.slice(0, 6).map(candidate => {
    const id = String(candidate?.id || '').trim();
    if (!workflowById(id)) throw new Error(`Unknown workflow candidate: ${id || '(none)'}`);
    return { id, fit: String(candidate?.fit || '').trim(), tradeoff: String(candidate?.tradeoff || '').trim() };
  }) : [];
  if (!candidates.some(candidate => candidate.id === recommendedWorkflow)) {
    candidates.unshift({ id: recommendedWorkflow, fit: 'recommended', tradeoff: '' });
  }
  return {
    schema: 'director-analysis.v1',
    requestSummary: String(value.request_summary || '').trim(),
    successCriteria,
    constraints: cleanStrings(value.constraints, 24),
    evidence: cleanStrings(value.evidence, 24),
    risks: cleanStrings(value.risks, 24),
    unknowns: cleanStrings(value.unknowns, 16),
    workflowCandidates: candidates,
    recommendedWorkflow,
    workerStrategy: cleanStrings(value.worker_strategy, 16),
    reviewStrategy: cleanStrings(value.review_strategy, 16),
    stopConditions: cleanStrings(value.stop_conditions, 16),
  };
}

export function validateDirectorControl(value, { requiredMode = null } = {}) {
  if (!value || value.schema !== 'director-action.v1') throw new Error('Director did not return director-action.v1 control data.');
  const mode = value.mode === 'delegate' ? 'delegate' : value.mode === 'conversation' ? 'conversation' : null;
  if (!mode) throw new Error('Director control mode must be conversation or delegate.');
  if (requiredMode === 'delegate' && mode !== 'delegate') throw new Error('Execution requests must be delegated to workers.');
  if (requiredMode === 'conversation' && mode !== 'conversation') throw new Error('Conversation requests cannot create delegated work.');

  const workflowId = value.workflow_id ? String(value.workflow_id) : null;
  if (mode === 'delegate' && !workflowById(workflowId)) throw new Error(`Unknown or missing workflow: ${workflowId || '(none)'}`);
  const rawActions = Array.isArray(value.actions) ? value.actions : [];
  if (rawActions.length > 24) throw new Error('A Director turn may create at most 24 worker tasks.');

  const ids = new Set();
  const actions = rawActions.map((raw, index) => {
    const id = String(raw?.id || `action-${index + 1}`).trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) || ids.has(id)) throw new Error(`Invalid or duplicate action id: ${id}`);
    ids.add(id);
    const target = String(raw?.target || '').trim();
    if (!WORKER_PROFILES[target]) throw new Error(`Unapproved worker profile: ${target || '(none)'}`);
    const effect = String(raw?.effect || '').trim().toLowerCase();
    if (!['read_only', 'workspace_write', 'external_mutation', 'skill_activation'].includes(effect)) {
      throw new Error(`Action ${id} must declare effect as read_only, workspace_write, external_mutation, or skill_activation.`);
    }
    if (['review', 'gate'].includes(WORKER_PROFILES[target].kind) && effect !== 'read_only') {
      throw new Error(`Read-only worker ${target} cannot declare ${effect} effect.`);
    }
    if (['external_mutation', 'skill_activation'].includes(effect) && WORKER_PROFILES[target].kind !== 'write') {
      throw new Error(`Only a write worker can request ${effect} authority.`);
    }
    const skills = cleanStrings(raw?.skills, 8);
    for (const skill of skills) if (!PRAETORIUM_SKILLS[skill]) throw new Error(`Unapproved Praetorium skill: ${skill}`);
    const task = String(raw?.task || '').trim();
    if (!task) throw new Error(`Action ${id} has no bounded task.`);
    if (task.length > 12000) throw new Error(`Action ${id} task exceeds 12000 characters.`);
    const writeScope = cleanStrings(raw?.write_scope, 32);
    const acceptance = cleanStrings(raw?.acceptance, 32);
    if (!writeScope.length) throw new Error(`Action ${id} must declare a write_scope or read-only scope.`);
    if (!acceptance.length) throw new Error(`Action ${id} must declare observable acceptance evidence.`);
    const wakeOn = cleanStrings(raw?.wake_on, 8);
    if (!wakeOn.length) throw new Error(`Action ${id} must declare at least one wake_on signal.`);
    for (const signal of wakeOn) {
      if (!['completion', 'finding', 'failure'].includes(signal)) throw new Error(`Action ${id} has unsupported wake_on signal: ${signal}`);
    }
    return {
      id,
      title: String(raw?.title || task.split(/\r?\n/)[0]).trim().slice(0, 160),
      target,
      effect,
      task,
      skills,
      dependencies: cleanStrings(raw?.dependencies, 16),
      writeScope,
      acceptance,
      wakeOn,
    };
  });
  for (const action of actions) {
    for (const dependency of action.dependencies) {
      if (!ids.has(dependency)) throw new Error(`Action ${action.id} references unknown dependency ${dependency}.`);
      if (dependency === action.id) throw new Error(`Action ${action.id} cannot depend on itself.`);
      if (actions.findIndex(item => item.id === dependency) >= actions.findIndex(item => item.id === action.id)) {
        throw new Error(`Action ${action.id} dependency ${dependency} must appear earlier in the plan.`);
      }
    }
  }
  const state = String(value.state || (mode === 'delegate' ? 'executing' : 'complete')).trim().toLowerCase();
  const ownerDecision = value.owner_decision && typeof value.owner_decision === 'object' ? {
    required: Boolean(value.owner_decision.required),
    question: value.owner_decision.question ? String(value.owner_decision.question).trim() : null,
    options: cleanStrings(value.owner_decision.options, 8),
    evidence: cleanStrings(value.owner_decision.evidence, 16),
  } : { required: false, question: null, options: [], evidence: [] };
  if (ownerDecision.question && ownerDecision.question.length > 2000) throw new Error('Owner decision question exceeds 2000 characters.');
  if (mode === 'delegate') {
    const allowedStates = new Set(['executing', 'awaiting_owner', 'complete', 'blocked']);
    if (!allowedStates.has(state)) throw new Error(`Invalid delegated Director state: ${state || '(none)'}.`);
    if (state === 'executing' && actions.length === 0) {
      throw new Error('A delegated request in executing state must create at least one worker task.');
    }
    if (state !== 'executing' && actions.length > 0) {
      throw new Error(`A delegated request in ${state} state cannot create worker tasks.`);
    }
    if (state === 'awaiting_owner' && (!ownerDecision.required || !ownerDecision.question)) {
      throw new Error('awaiting_owner state requires owner_decision.required and a question.');
    }
    if (ownerDecision.required && state !== 'awaiting_owner') {
      throw new Error('A required Owner decision must use awaiting_owner state.');
    }
  }
  if (mode === 'conversation') {
    if (actions.length) throw new Error('Conversation mode cannot create worker tasks.');
    if (workflowId) throw new Error('Conversation mode cannot select a workflow.');
    if (state !== 'complete') throw new Error('Conversation mode must use complete state.');
    if (ownerDecision.required) throw new Error('Conversation mode cannot require an Owner decision.');
  }

  return {
    schema: 'director-action.v1',
    mode,
    workflowId,
    state,
    requirements: cleanStrings(value.requirements, 32),
    decisions: cleanStrings(value.decisions, 20),
    actions,
    ownerDecision,
  };
}

export const _test = {
  CONTROL_RE, ANALYSIS_RE, EXECUTION_PATTERNS, CONVERSATION_PATTERNS,
  READ_ONLY_REQUEST_PATTERNS, MUTATING_REQUEST_PATTERNS,
};
