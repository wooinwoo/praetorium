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

function cleanStrings(values, limit = 20) {
  if (!Array.isArray(values)) return [];
  return values.map(value => String(value || '').trim()).filter(Boolean).slice(0, limit);
}

export function inferRequestMode(prompt, requested = 'auto') {
  if (requested === 'conversation' || requested === 'delegate') return requested;
  const text = String(prompt || '').trim();
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
    successCriteria: cleanStrings(value.success_criteria, 24),
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

export function validateDirectorControl(value, { requiredMode = 'conversation' } = {}) {
  if (!value || value.schema !== 'director-action.v1') throw new Error('Director did not return director-action.v1 control data.');
  const mode = value.mode === 'delegate' ? 'delegate' : value.mode === 'conversation' ? 'conversation' : null;
  if (!mode) throw new Error('Director control mode must be conversation or delegate.');
  if (requiredMode === 'delegate' && mode !== 'delegate') throw new Error('Execution requests must be delegated to workers.');

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
    const skills = cleanStrings(raw?.skills, 8);
    for (const skill of skills) if (!PRAETORIUM_SKILLS[skill]) throw new Error(`Unapproved Praetorium skill: ${skill}`);
    const task = String(raw?.task || '').trim();
    if (!task) throw new Error(`Action ${id} has no bounded task.`);
    return {
      id,
      title: String(raw?.title || task.split(/\r?\n/)[0]).trim().slice(0, 160),
      target,
      task,
      skills,
      dependencies: cleanStrings(raw?.dependencies, 16),
      writeScope: cleanStrings(raw?.write_scope, 32),
      acceptance: cleanStrings(raw?.acceptance, 32),
      wakeOn: cleanStrings(raw?.wake_on, 8),
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
  if (mode === 'delegate' && actions.length === 0) throw new Error('A delegated request must create at least one worker task.');
  if (mode === 'conversation' && actions.length) throw new Error('Conversation mode cannot create worker tasks.');

  return {
    schema: 'director-action.v1',
    mode,
    workflowId,
    state: String(value.state || (mode === 'delegate' ? 'executing' : 'complete')),
    requirements: cleanStrings(value.requirements, 32),
    decisions: cleanStrings(value.decisions, 20),
    actions,
    ownerDecision: value.owner_decision && typeof value.owner_decision === 'object' ? {
      required: Boolean(value.owner_decision.required),
      question: value.owner_decision.question ? String(value.owner_decision.question) : null,
      options: cleanStrings(value.owner_decision.options, 8),
      evidence: cleanStrings(value.owner_decision.evidence, 16),
    } : { required: false, question: null, options: [], evidence: [] },
  };
}

export const _test = { CONTROL_RE, ANALYSIS_RE, EXECUTION_PATTERNS, CONVERSATION_PATTERNS };
