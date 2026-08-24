import {
  isStructuredEvidenceApproved, WORKER_PROFILES, workflowById,
} from './workflow-catalog.js';

export const TERMINAL_TASK_STATES = new Set([
  'done', 'completed', 'succeeded', 'success', 'blocked', 'archived', 'failed', 'cancelled',
]);
export const TERMINAL_GOAL_STATES = new Set(['completed', 'blocked', 'failed']);
export const QUEUED_GOAL_STATES = new Set(['queued']);
export const ACTIVE_GOAL_STATES = new Set([
  'clarifying', 'planning', 'executing', 'evaluating', 'remediating', 'verifying', 'awaiting_owner',
]);

function iso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function taskTimestamp(task) {
  return iso(task?.completed_at || task?.completedAt || task?.updated_at || task?.updatedAt);
}

function taskStatus(task) {
  return String(task?.status || '').trim().toLowerCase();
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const source = String(value || '').trim();
  if (!source) return null;
  try { return JSON.parse(source); } catch { /* scan for the first balanced object */ }
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { return JSON.parse(source.slice(start, index + 1)); } catch { start = -1; }
      }
    }
  }
  return null;
}

export function isTerminalTask(status) {
  return TERMINAL_TASK_STATES.has(String(status || '').toLowerCase());
}

export function isActiveGoal(goal) {
  return Boolean(goal && ACTIVE_GOAL_STATES.has(goal.status));
}

export function normalizeGoalRecord(goal) {
  const createdAt = iso(goal?.createdAt) || new Date().toISOString();
  return {
    ...goal,
    status: ACTIVE_GOAL_STATES.has(goal?.status) || TERMINAL_GOAL_STATES.has(goal?.status)
      || QUEUED_GOAL_STATES.has(goal?.status) ? goal.status : 'planning',
    phase: String(goal?.phase || goal?.status || 'planning'),
    workflowId: goal?.workflowId || null,
    analysis: goal?.analysis || null,
    successCriteria: Array.isArray(goal?.successCriteria) ? goal.successCriteria : [],
    constraints: Array.isArray(goal?.constraints) ? goal.constraints : [],
    requirements: Array.isArray(goal?.requirements) ? goal.requirements : [],
    taskIds: Array.isArray(goal?.taskIds) ? goal.taskIds : [],
    currentWaveTaskIds: Array.isArray(goal?.currentWaveTaskIds) ? goal.currentWaveTaskIds : [],
    taskRecords: Array.isArray(goal?.taskRecords) ? goal.taskRecords.map(record => ({
      ...record,
      summary: clip(record?.summary, 4000),
      report: compactReport(record?.report),
    })) : [],
    waves: Array.isArray(goal?.waves) ? goal.waves : [],
    ownerDecision: goal?.ownerDecision || null,
    ownerAnswers: Array.isArray(goal?.ownerAnswers) ? goal.ownerAnswers : [],
    ownerApprovals: Array.isArray(goal?.ownerApprovals) ? goal.ownerApprovals : [],
    pendingAuthorityPlan: goal?.pendingAuthorityPlan || null,
    specFrozen: Boolean(goal?.specFrozen),
    reanalysisRequired: Boolean(goal?.reanalysisRequired),
    verificationBarrier: goal?.verificationBarrier || null,
    publicDecisions: Array.isArray(goal?.publicDecisions) ? goal.publicDecisions : [],
    evidence: Array.isArray(goal?.evidence) ? goal.evidence : [],
    currentCandidate: goal?.currentCandidate || null,
    candidateSnapshots: Array.isArray(goal?.candidateSnapshots) ? goal.candidateSnapshots : [],
    finalReport: goal?.finalReport || null,
    finalAudit: goal?.finalAudit || null,
    error: goal?.error || null,
    cycleCount: Math.max(0, Number(goal?.cycleCount) || 0),
    maxCycles: Math.max(1, Number(goal?.maxCycles) || 12),
    remediationCount: Math.max(0, Number(goal?.remediationCount) || 0),
    maxRemediationLoops: Math.max(1, Number(goal?.maxRemediationLoops) || 3),
    evaluationFailures: Math.max(0, Number(goal?.evaluationFailures) || 0),
    nextEvaluationAt: iso(goal?.nextEvaluationAt),
    createdAt,
    updatedAt: iso(goal?.updatedAt) || createdAt,
    completedAt: iso(goal?.completedAt),
    events: Array.isArray(goal?.events) ? goal.events.slice(-240) : [],
  };
}

export function addGoalEvent(goal, kind, phase, message, details = null, at = new Date().toISOString()) {
  goal.updatedAt = at;
  goal.events ||= [];
  goal.events.push({ at, kind, phase, message, ...(details ? { details } : {}) });
  goal.events = goal.events.slice(-240);
  return goal.events.at(-1);
}

export function classifyWave(actions = [], waveIndex = 1) {
  const profiles = actions.map(action => action.target);
  if (profiles.includes('remediator')) return 'remediation';
  const kinds = profiles.map(profile => WORKER_PROFILES[profile]?.kind).filter(Boolean);
  if (kinds.length && kinds.every(kind => kind === 'review' || kind === 'gate')) {
    return kinds.includes('gate') ? 'verification' : 'review';
  }
  return waveIndex === 1 ? 'implementation' : 'execution';
}

export function syncGoalTasks(goal, boardTasks = [], observedAt = new Date().toISOString()) {
  const byId = new Map(boardTasks.filter(task => task?.id).map(task => [task.id, task]));
  for (const record of goal.taskRecords || []) {
    const task = byId.get(record.taskId);
    if (!task) continue;
    const previous = record.status;
    const observedStatus = taskStatus(task);
    record.status = record.pausedByOwner && observedStatus === 'blocked' ? 'paused' : observedStatus || previous || 'queued';
    record.startedAt ||= iso(task.started_at || task.startedAt);
    if (record.status === 'paused') record.completedAt = null;
    else if (isTerminalTask(record.status)) record.completedAt ||= taskTimestamp(task) || observedAt;
    record.lastObservedAt = observedAt;
  }

  for (const wave of goal.waves || []) {
    const records = (wave.taskIds || []).map(taskId => goal.taskRecords.find(record => record.taskId === taskId)).filter(Boolean);
    if (!records.length) continue;
    const allTerminal = records.every(record => isTerminalTask(record.status));
    const anyRunning = records.some(record => record.status === 'running');
    wave.status = allTerminal ? 'completed' : anyRunning ? 'running' : 'queued';
    if (anyRunning) wave.startedAt ||= records.map(record => record.startedAt).filter(Boolean).sort()[0] || observedAt;
    if (allTerminal) wave.completedAt ||= records.map(record => record.completedAt).filter(Boolean).sort().at(-1) || observedAt;
  }
  goal.updatedAt = observedAt;
  return goal;
}

export function currentWave(goal) {
  if (!goal?.waves?.length) return null;
  const ids = new Set(goal.currentWaveTaskIds || []);
  return goal.waves.findLast(wave => (wave.taskIds || []).some(id => ids.has(id))) || goal.waves.at(-1);
}

export function goalReadyForEvaluation(goal) {
  if (!goal || TERMINAL_GOAL_STATES.has(goal.status) || goal.status === 'awaiting_owner') return false;
  const wave = currentWave(goal);
  if (!wave) return ['planning', 'evaluating'].includes(goal.status);
  const records = (wave.taskIds || []).map(taskId => goal.taskRecords.find(record => record.taskId === taskId));
  return records.length > 0 && records.every(record => record && isTerminalTask(record.status));
}

export function goalTaskEvidence(goal, detailsByTaskId = new Map()) {
  return (goal.taskRecords || []).map(record => {
    const hasObservedDetails = detailsByTaskId.has(record.taskId);
    const details = detailsByTaskId.get(record.taskId) || {};
    const task = details.task || {};
    const comments = Array.isArray(details.comments) ? details.comments.slice(-6).map(comment => ({
      author: String(comment?.author || ''),
      body: String(comment?.body || comment?.message || '').slice(0, 600),
      createdAt: comment?.created_at || comment?.createdAt || null,
    })) : [];
    const observedSummary = String(details.latest_summary || details.latestSummary || task.summary || '').slice(0, 4000);
    const summary = observedSummary || String(record.summary || '').slice(0, 4000);
    const observedReport = hasObservedDetails
      ? parseJsonObject(details.validation) || parseJsonObject(observedSummary)
      : null;
    const usingPersistedReport = !observedReport && Boolean(record.report);
    const report = observedReport || record.report || null;
    return {
      taskId: record.taskId,
      actionId: record.actionId,
      title: record.title || task.title || '',
      profile: record.profile,
      kind: WORKER_PROFILES[record.profile]?.kind || null,
      waveIndex: record.waveIndex,
      status: taskStatus(task) || record.status,
      completedAt: record.completedAt || taskTimestamp(task),
      acceptance: record.acceptance || [],
      summary,
      validation: details.validation || null,
      report,
      persistedReportApproved: usingPersistedReport ? record.reportApproved === true : null,
      hostReceipt: record.hostReceipt || null,
      comments,
    };
  });
}

export function evaluateGoalAcceptance(goal, evidence = [], { gateTaskId = null } = {}) {
  const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const gates = evidence
    .filter(item => item.profile === 'quality-gate-reviewer'
      && (!gateTaskId || item.taskId === gateTaskId)
      && ['done', 'completed', 'succeeded', 'success'].includes(String(item.status || '').toLowerCase())
      && item.report?.schema === 'quality-gate.v1'
      && isStructuredEvidenceApproved(item))
    .sort((left, right) => (Number(left.waveIndex) || 0) - (Number(right.waveIndex) || 0)
      || Date.parse(left.completedAt || 0) - Date.parse(right.completedAt || 0));
  const gate = gates.at(-1) || null;
  const accepted = new Map((gate?.report?.acceptance || []).map(item => [normalize(item.criterion), item]));
  const criteria = (goal?.successCriteria || []).map(criterion => {
    const report = accepted.get(normalize(criterion));
    return {
      criterion,
      status: report?.status || 'not_verified',
      evidence: Array.isArray(report?.evidence) ? report.evidence : [],
      met: report?.status === 'met' && Array.isArray(report.evidence) && report.evidence.length > 0,
    };
  });
  return {
    satisfied: Boolean(gate && gateTaskId && criteria.length > 0
      && gate.report.decision === 'advance' && criteria.every(item => item.met)),
    gateTaskId: gate?.taskId || null,
    criteria,
    missingCriteria: criteria.filter(item => !item.met).map(item => item.criterion),
  };
}

function clip(value, max = 600) {
  return String(value || '').slice(0, max);
}

function compactStrings(values, limit = 12, max = 400) {
  return Array.isArray(values) ? values.slice(0, limit).map(value => clip(value, max)) : [];
}

export function compactReport(report) {
  if (report?.schema === 'review.v1') {
    return {
      schema: report.schema,
      review_kind: clip(report.review_kind, 80),
      scope: {
        base_revision: report.scope?.base_revision || null,
        head_revision: report.scope?.head_revision || null,
        artifact_digest: report.scope?.artifact_digest || null,
        paths: Array.isArray(report.scope?.paths) ? compactStrings(report.scope.paths, 24, 300) : null,
      },
      verdict: clip(report.verdict, 32),
      summary: clip(report.summary, 1200),
      checks: Array.isArray(report.checks) ? report.checks.slice(0, 40).map(check => ({
        id: clip(check?.id, 120), status: clip(check?.status, 32), evidence: compactStrings(check?.evidence, 5, 360),
      })) : null,
      findings: Array.isArray(report.findings) ? report.findings.slice(0, 20).map(finding => ({
        id: clip(finding?.id, 120), severity: clip(finding?.severity, 16), confidence: clip(finding?.confidence, 16),
        category: clip(finding?.category, 100), title: clip(finding?.title, 240), claim: clip(finding?.claim, 500),
        evidence: Array.isArray(finding?.evidence) ? finding.evidence.slice(0, 5).map(item => ({
          path: clip(item?.path, 300), line: Number(item?.line) || 0, detail: clip(item?.detail, 500),
        })) : [],
        impact: clip(finding?.impact, 500), required_action: clip(finding?.required_action, 500),
        verification: clip(finding?.verification, 500),
        blocking: typeof finding?.blocking === 'boolean' ? finding.blocking : clip(finding?.blocking, 32),
      })) : null,
      coverage: report.coverage && typeof report.coverage === 'object'
        ? Object.fromEntries(['examined', 'omitted', 'limitations', 'assumptions']
          .map(key => [key, Array.isArray(report.coverage[key]) ? compactStrings(report.coverage[key], 16, 400) : null]))
        : null,
    };
  }
  if (report?.schema === 'quality-gate.v1') {
    return {
      schema: report.schema,
      candidate: {
        revision: report.candidate?.revision || null,
        artifact_digest: report.candidate?.artifact_digest || null,
      },
      decision: clip(report.decision, 32),
      acceptance: Array.isArray(report.acceptance) ? report.acceptance.slice(0, 40).map(item => ({
        criterion: clip(item?.criterion, 500), status: clip(item?.status, 32), evidence: compactStrings(item?.evidence, 8, 400),
      })) : null,
      reports: Array.isArray(report.reports) ? report.reports.slice(0, 16).map(item => ({
        review_kind: clip(item?.review_kind, 80), status: clip(item?.status, 32), verdict: item?.verdict || null,
      })) : null,
      blockers: Array.isArray(report.blockers) ? compactStrings(report.blockers, 24, 500) : null,
      residual_risk: Array.isArray(report.residual_risk) ? compactStrings(report.residual_risk, 24, 500) : null,
      next_action: clip(report.next_action, 800),
    };
  }
  return null;
}

function compactWave(wave) {
  if (!wave) return null;
  return {
    id: wave.id, index: wave.index, kind: wave.kind, status: wave.status,
    workflowId: wave.workflowId, startedAt: wave.startedAt, completedAt: wave.completedAt,
    requirements: compactStrings(wave.requirements, 24, 500),
    decisions: compactStrings(wave.decisions, 24, 500),
    taskIds: Array.isArray(wave.taskIds) ? wave.taskIds.slice(0, 48) : [],
    actions: Array.isArray(wave.actions) ? wave.actions.slice(0, 32).map(action => ({
      id: action.id, title: clip(action.title, 240), target: action.target, effect: action.effect,
      task: clip(action.task, 1200), dependencies: Array.isArray(action.dependencies) ? action.dependencies.slice(0, 24) : [],
      writeScope: compactStrings(action.writeScope, 24, 300), acceptance: compactStrings(action.acceptance, 24, 500),
      wakeOn: Array.isArray(action.wakeOn) ? action.wakeOn.slice(0, 8) : [], taskId: action.taskId || null,
    })) : [],
  };
}

export function buildSupervisionPrompt({ goal, evidence, gateAudit, catalog, reason = 'wave_completed' }) {
  const workflow = workflowById(goal.workflowId);
  const current = currentWave(goal);
  const recentEvidence = evidence.filter(item => !current || item.waveIndex === current.index);
  const boundedCurrentEvidence = recentEvidence.map(item => ({
    taskId: item.taskId, actionId: item.actionId, title: clip(item.title, 240), profile: item.profile,
    kind: item.kind, waveIndex: item.waveIndex, status: item.status, completedAt: item.completedAt,
    acceptance: compactStrings(item.acceptance, 24, 500),
    summary: String(item.summary || '').slice(0, 2500),
    report: compactReport(item.report),
    comments: (item.comments || []).slice(-4).map(comment => ({
      author: clip(comment?.author, 120), body: clip(comment?.body, 600), createdAt: comment?.createdAt || null,
    })),
  }));
  const historicalEvidence = evidence
    .filter(item => current && item.waveIndex !== current.index)
    .slice(-32)
    .map(item => ({
      taskId: item.taskId,
      profile: item.profile,
      waveIndex: item.waveIndex,
      status: item.status,
      completedAt: item.completedAt,
      report: compactReport(item.report),
      summary: item.kind === 'write' ? String(item.summary || '').slice(0, 500) : '',
    }));
  const ownerAnswers = (goal.ownerAnswers || []).slice(-8).map(item => ({
    at: item.at, question: clip(item.question, 1200), answer: clip(item.answer, 4000),
    selectedOption: item.selectedOption ? clip(item.selectedOption, 500) : null,
    action: item.action || null, evidence: compactStrings(item.evidence, 12, 500),
  }));
  const compactGateAudit = gateAudit ? {
    workflowId: gateAudit.workflowId,
    satisfied: Boolean(gateAudit.satisfied),
    requiredProfiles: Array.isArray(gateAudit.requiredProfiles) ? gateAudit.requiredProfiles.slice(0, 24) : [],
    approvedProfiles: Array.isArray(gateAudit.approvedProfiles) ? gateAudit.approvedProfiles.slice(0, 24) : [],
    rejectedProfiles: Array.isArray(gateAudit.rejectedProfiles) ? gateAudit.rejectedProfiles.slice(0, 24) : [],
    missingProfiles: Array.isArray(gateAudit.missingProfiles) ? gateAudit.missingProfiles.slice(0, 24) : [],
    staleProfiles: Array.isArray(gateAudit.staleProfiles) ? gateAudit.staleProfiles.slice(0, 24) : [],
    creditedTaskIds: gateAudit.creditedTaskIds || {},
    approvedGateTaskId: gateAudit.approvedGateTaskId || null,
    gateConsistency: gateAudit.gateConsistency || null,
    hostCandidate: gateAudit.hostCandidate ? {
      schema: gateAudit.hostCandidate.schema, revision: gateAudit.hostCandidate.revision,
      digest: gateAudit.hostCandidate.digest, dirty: gateAudit.hostCandidate.dirty,
      fileCount: gateAudit.hostCandidate.fileCount,
    } : null,
    hostCandidateError: clip(gateAudit.hostCandidateError, 1000) || null,
    acceptance: gateAudit.acceptance ? {
      satisfied: Boolean(gateAudit.acceptance.satisfied), gateTaskId: gateAudit.acceptance.gateTaskId || null,
      criteria: Array.isArray(gateAudit.acceptance.criteria) ? gateAudit.acceptance.criteria.slice(0, 40).map(item => ({
        criterion: clip(item.criterion, 500), status: clip(item.status, 32), met: Boolean(item.met),
        evidence: compactStrings(item.evidence, 8, 400),
      })) : [],
      missingCriteria: compactStrings(gateAudit.acceptance.missingCriteria, 40, 500),
    } : null,
  } : null;
  const snapshot = {
    id: goal.id,
    objective: clip(goal.objective, 6000),
    status: goal.status,
    phase: goal.phase,
    workflow_id: goal.workflowId,
    workflow_name: workflow?.name || goal.workflowId,
    success_criteria: compactStrings(goal.successCriteria, 40, 1000),
    constraints: compactStrings(goal.constraints, 40, 1000),
    requirements: compactStrings(goal.requirements, 80, 1000),
    host_candidate: goal.currentCandidate ? {
      schema: goal.currentCandidate.schema, revision: goal.currentCandidate.revision,
      digest: goal.currentCandidate.digest, dirty: goal.currentCandidate.dirty,
      fileCount: goal.currentCandidate.fileCount, observedAt: goal.currentCandidate.observedAt,
    } : null,
    cycles: { used: goal.cycleCount, max: goal.maxCycles },
    remediation_loops: { used: goal.remediationCount, max: goal.maxRemediationLoops },
    owner_answers: ownerAnswers,
    current_wave: compactWave(current),
    current_wave_evidence: boundedCurrentEvidence,
    historical_evidence: historicalEvidence,
    workflow_gate_audit: compactGateAudit,
  };
  let snapshotText = JSON.stringify(snapshot);
  if (snapshotText.length > 120000) {
    snapshot.historical_evidence = snapshot.historical_evidence.slice(-12);
    snapshot.current_wave_evidence = snapshot.current_wave_evidence.slice(-24);
    snapshot.prompt_truncated = true;
    snapshotText = JSON.stringify(snapshot);
  }
  if (snapshotText.length > 120000) {
    snapshot.current_wave_evidence = snapshot.current_wave_evidence.slice(-12).map(item => ({
      taskId: item.taskId, profile: item.profile, waveIndex: item.waveIndex, status: item.status,
      summary: clip(item.summary, 300),
    }));
    snapshot.historical_evidence = [];
    if (snapshot.current_wave?.actions) snapshot.current_wave.actions = snapshot.current_wave.actions.slice(0, 16).map(action => ({
      id: action.id, title: action.title, target: action.target, effect: action.effect,
      task: clip(action.task, 300), dependencies: action.dependencies, writeScope: action.writeScope,
    }));
    snapshotText = JSON.stringify(snapshot);
  }
  if (snapshotText.length > 120000) throw new Error('Durable Goal snapshot exceeds the hard 120000 character supervision budget.');
  if (snapshotText.length > 120000) {
    snapshot.current_wave_evidence = snapshot.current_wave_evidence.map(item => ({
      taskId: item.taskId, profile: item.profile, waveIndex: item.waveIndex, status: item.status,
      completedAt: item.completedAt, summary: clip(item.summary, 600), report: item.report
        ? { schema: item.report.schema, verdict: item.report.verdict, decision: item.report.decision,
          review_kind: item.report.review_kind, candidate: item.report.candidate, scope: item.report.scope }
        : null,
    }));
    snapshotText = JSON.stringify(snapshot);
  }
  return [
    '[PRAETORIUM DURABLE GOAL SUPERVISION]',
    `Wake reason: ${reason}. This is a fresh Director inference turn for an existing durable Goal, not a new Owner request.`,
    'You are structurally read-only. Judge worker evidence, decide the next bounded wave, and keep supervising until the Goal is truly complete.',
    'Do not reveal private chain-of-thought. Before the control envelope, publish only concise operational PLAN / OBSERVED / DECISION / VERIFY evidence useful to the Owner.',
    'Use the immutable workflow already selected for this Goal. Do not claim completion merely because workers completed their cards.',
    'State rules:',
    '- executing: create one or more approved worker actions for the next wave.',
    '- awaiting_owner: create no actions and ask exactly one material decision question.',
    '- complete: create no actions; use only when every success criterion is evidenced and the host workflow gate audit is satisfied.',
    '- blocked: create no actions; use only for a concrete hard blocker that more worker effort cannot resolve.',
    'If any finding remains, assign remediation and then fresh affected reviews. A review completed before the latest write is stale.',
    '<PRAETORIUM_CONTROL>',
    '{"schema":"director-action.v1","mode":"delegate","workflow_id":"existing-workflow","state":"executing|awaiting_owner|complete|blocked","requirements":["..."],"decisions":["public operational reason"],"actions":[{"id":"a1","title":"short title","target":"approved-worker-profile","effect":"read_only|workspace_write|external_mutation|skill_activation","task":"bounded worker outcome with relevant evidence","skills":["approved-skill"],"dependencies":[],"write_scope":["path or read-only"],"acceptance":["observable evidence"],"wake_on":["completion|finding|failure"]}],"owner_decision":{"required":false,"question":null,"options":[],"evidence":[]}}',
    '</PRAETORIUM_CONTROL>',
    catalog,
    '[DURABLE GOAL SNAPSHOT]',
    snapshotText,
  ].join('\n\n');
}

export const _test = { iso, taskTimestamp, taskStatus, parseJsonObject, compactReport, compactWave };
