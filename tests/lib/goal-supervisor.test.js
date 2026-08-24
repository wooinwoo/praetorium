import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  _test,
  buildSupervisionPrompt,
  evaluateGoalAcceptance,
  goalReadyForEvaluation,
  goalTaskEvidence,
  normalizeGoalRecord,
  syncGoalTasks,
} from '../../lib/goal-supervisor.js';
import { evaluateWorkflowGates, isStructuredEvidenceApproved } from '../../lib/workflow-catalog.js';

function goalRecord(overrides = {}) {
  return {
    id: 'goal-test',
    objective: 'Complete the API safely',
    status: 'executing',
    phase: 'executing',
    workflowId: 'quick-fix',
    successCriteria: ['API returns 200', 'Unauthorized requests are denied'],
    constraints: ['local only'],
    requirements: ['tests pass'],
    taskIds: [],
    currentWaveTaskIds: [],
    taskRecords: [],
    waves: [],
    ownerAnswers: [],
    cycleCount: 1,
    maxCycles: 12,
    remediationCount: 0,
    maxRemediationLoops: 2,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

function gateReport(acceptance, overrides = {}) {
  return {
    schema: 'quality-gate.v1',
    candidate: { artifact_digest: 'sha256:candidate' },
    decision: 'advance',
    acceptance,
    reports: [],
    blockers: [],
    residual_risk: [],
    next_action: 'complete',
    ...overrides,
  };
}

function reviewReport(reviewKind = 'convention', overrides = {}) {
  return {
    schema: 'review.v1',
    review_kind: reviewKind,
    scope: {
      base_revision: 'base-revision', head_revision: null,
      artifact_digest: 'sha256:candidate', paths: ['lib/'],
    },
    verdict: 'pass',
    summary: `${reviewKind} review passed`,
    checks: [{ id: `${reviewKind}-contract`, status: 'pass', evidence: ['node --test passed'] }],
    findings: [],
    coverage: { examined: ['lib/'], omitted: [], limitations: [], assumptions: [] },
    ...overrides,
  };
}

describe('durable Goal supervisor', () => {
  it('normalizes restart fields and bounds persisted event history', () => {
    const events = Array.from({ length: 245 }, (_, index) => ({ at: `event-${index}`, kind: 'monitor' }));
    const normalized = normalizeGoalRecord({
      id: 'goal-restart',
      status: 'unknown-state',
      createdAt: '2026-08-24T09:00:00+09:00',
      updatedAt: '2026-08-24T09:01:00+09:00',
      nextEvaluationAt: '2026-08-24T09:02:00+09:00',
      evaluationFailures: '2',
      ownerApprovals: [{ kind: 'external', approved: false }],
      pendingAuthorityPlan: { effect: 'external_mutation' },
      specFrozen: 1,
      currentCandidate: { revision: 'abc', digest: 'sha256:abc' },
      candidateSnapshots: [{ revision: 'abc' }],
      maxCycles: 0,
      maxRemediationLoops: 0,
      events,
    });

    assert.equal(normalized.status, 'planning');
    assert.equal(normalized.createdAt, '2026-08-24T00:00:00.000Z');
    assert.equal(normalized.updatedAt, '2026-08-24T00:01:00.000Z');
    assert.equal(normalized.nextEvaluationAt, '2026-08-24T00:02:00.000Z');
    assert.equal(normalized.evaluationFailures, 2);
    assert.deepEqual(normalized.ownerApprovals, [{ kind: 'external', approved: false }]);
    assert.deepEqual(normalized.pendingAuthorityPlan, { effect: 'external_mutation' });
    assert.equal(normalized.specFrozen, true);
    assert.deepEqual(normalized.currentCandidate, { revision: 'abc', digest: 'sha256:abc' });
    assert.deepEqual(normalized.candidateSnapshots, [{ revision: 'abc' }]);
    assert.equal(normalized.maxCycles, 12);
    assert.equal(normalized.maxRemediationLoops, 3);
    assert.equal(normalized.events.length, 240);
    assert.equal(normalized.events[0].at, 'event-5');
  });

  it('normalizes Hermes epoch seconds without corrupting millisecond or ISO timestamps', () => {
    const expected = '2026-08-24T16:04:32.000Z';
    assert.equal(_test.iso(1787587472), expected);
    assert.equal(_test.iso('1787587472'), expected);
    assert.equal(_test.iso(1787587472000), expected);
    assert.equal(_test.iso('1787587472000'), expected);
    assert.equal(_test.iso('2026-08-25T01:04:32+09:00'), expected);
    assert.equal(_test.iso(new Date(expected)), expected);
    for (const invalid of [null, undefined, false, 0, '', 'not-a-time', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      assert.equal(_test.iso(invalid), null);
    }

    const goal = goalRecord({
      currentWaveTaskIds: ['task-epoch-seconds'],
      taskRecords: [{ taskId: 'task-epoch-seconds', status: 'queued', startedAt: null }],
      waves: [{
        id: 'wave-epoch-seconds', index: 1, status: 'queued', taskIds: ['task-epoch-seconds'],
        startedAt: null, completedAt: null,
      }],
    });
    syncGoalTasks(goal, [
      { id: 'task-epoch-seconds', status: 'running', started_at: 1787587472 },
    ], '2026-08-24T16:05:00.000Z');

    assert.equal(goal.taskRecords[0].startedAt, expected);
    assert.equal(goal.waves[0].startedAt, expected);
  });

  it('repairs a persisted 1970 startedAt from the live board without overwriting a valid first start', () => {
    const repaired = '2026-08-24T16:04:32.000Z';
    const preserved = '2026-08-24T15:59:00.000Z';
    const goal = goalRecord({
      currentWaveTaskIds: ['task-legacy-1970', 'task-valid-start'],
      taskRecords: [{
        taskId: 'task-legacy-1970', status: 'queued', startedAt: '1970-01-21T16:33:07.472Z',
      }, {
        taskId: 'task-valid-start', status: 'queued', startedAt: preserved,
      }, {
        taskId: 'task-invalid-board-time', status: 'queued', startedAt: '1970-01-01T00:00:01.000Z',
      }],
      waves: [{
        id: 'wave-started-at-repair', index: 1, status: 'queued',
        taskIds: ['task-legacy-1970', 'task-valid-start'],
        startedAt: null, completedAt: null,
      }],
    });

    syncGoalTasks(goal, [{
      id: 'task-legacy-1970', status: 'running', started_at: 1787587472,
    }, {
      id: 'task-valid-start', status: 'running', started_at: 1787587532,
    }, {
      id: 'task-invalid-board-time', status: 'running', started_at: 'invalid',
    }], '2026-08-24T16:05:00.000Z');

    assert.equal(goal.taskRecords[0].startedAt, repaired);
    assert.equal(goal.taskRecords[1].startedAt, preserved,
      'a plausible persisted first-start time must remain immutable across later board observations');
    assert.equal(goal.taskRecords[2].startedAt, '1970-01-01T00:00:01.000Z',
      'invalid live data must not rewrite durable state');
    assert.equal(goal.waves[0].startedAt, preserved);
  });

  it('repairs a persisted 1970 completedAt from the live board without overwriting a valid completion', () => {
    const repaired = '2026-08-24T16:04:32.000Z';
    const preserved = '2026-08-24T16:03:00.000Z';
    const goal = goalRecord({
      currentWaveTaskIds: ['task-legacy-completion', 'task-valid-completion'],
      taskRecords: [{
        taskId: 'task-legacy-completion', status: 'done',
        completedAt: '1970-01-21T16:33:07.472Z',
      }, {
        taskId: 'task-valid-completion', status: 'done', completedAt: preserved,
      }, {
        taskId: 'task-invalid-completion', status: 'done',
        completedAt: '1970-01-01T00:00:01.000Z',
      }],
      waves: [{
        id: 'wave-completed-at-repair', index: 1, status: 'running',
        taskIds: ['task-legacy-completion', 'task-valid-completion'],
        startedAt: '2026-08-24T16:00:00.000Z', completedAt: null,
      }],
    });

    syncGoalTasks(goal, [{
      id: 'task-legacy-completion', status: 'done', completed_at: 1787587472,
    }, {
      id: 'task-valid-completion', status: 'done', completed_at: 1787587532,
    }, {
      id: 'task-invalid-completion', status: 'done', completed_at: 'invalid',
    }], '2026-08-24T16:05:00.000Z');

    assert.equal(goal.taskRecords[0].completedAt, repaired);
    assert.equal(goal.taskRecords[1].completedAt, preserved,
      'a plausible durable completion must not move on later board observations');
    assert.equal(goal.taskRecords[2].completedAt, '1970-01-01T00:00:01.000Z',
      'invalid live completion data must not rewrite durable state');
    assert.equal(goal.waves[0].completedAt, repaired);
  });

  it('keeps an Owner-paused card non-terminal until it is actually resumed and completed', () => {
    const goal = goalRecord({
      currentWaveTaskIds: ['task-paused', 'task-done'],
      taskRecords: [
        { taskId: 'task-paused', status: 'running', pausedByOwner: true, completedAt: '2026-08-24T00:00:30.000Z' },
        { taskId: 'task-done', status: 'running' },
      ],
      waves: [{ id: 'wave-1', index: 1, status: 'running', taskIds: ['task-paused', 'task-done'], startedAt: null, completedAt: null }],
    });
    syncGoalTasks(goal, [
      { id: 'task-paused', status: 'blocked', updated_at: '2026-08-24T00:01:00.000Z' },
      { id: 'task-done', status: 'done', completed_at: '2026-08-24T00:01:00.000Z' },
    ], '2026-08-24T00:01:01.000Z');

    assert.equal(goal.taskRecords[0].status, 'paused');
    assert.equal(goal.taskRecords[0].completedAt, null);
    assert.equal(goal.waves[0].status, 'queued');
    assert.equal(goalReadyForEvaluation(goal), false);

    goal.taskRecords[0].pausedByOwner = false;
    syncGoalTasks(goal, [
      { id: 'task-paused', status: 'completed', completed_at: '2026-08-24T00:02:00.000Z' },
      { id: 'task-done', status: 'done', completed_at: '2026-08-24T00:01:00.000Z' },
    ], '2026-08-24T00:02:01.000Z');
    assert.equal(goal.taskRecords[0].status, 'completed');
    assert.equal(goal.waves[0].status, 'completed');
    assert.equal(goal.waves[0].completedAt, '2026-08-24T00:02:00.000Z');
    assert.equal(goalReadyForEvaluation(goal), true);
  });

  it('wakes only for an evaluable planning state or a fully terminal current wave', () => {
    assert.equal(goalReadyForEvaluation(goalRecord({ status: 'planning' })), true);
    assert.equal(goalReadyForEvaluation(goalRecord({ status: 'evaluating' })), true);
    assert.equal(goalReadyForEvaluation(goalRecord({ status: 'executing' })), false);
    assert.equal(goalReadyForEvaluation(goalRecord({ status: 'awaiting_owner' })), false);
    assert.equal(goalReadyForEvaluation(goalRecord({ status: 'completed' })), false);

    const goal = goalRecord({
      currentWaveTaskIds: ['current'],
      taskRecords: [{ taskId: 'current', status: 'done' }, { taskId: 'older', status: 'running' }],
      waves: [
        { id: 'old', index: 1, taskIds: ['older'] },
        { id: 'current', index: 2, taskIds: ['current'] },
      ],
    });
    assert.equal(goalReadyForEvaluation(goal), true, 'only the selected current wave gates evaluation');
    goal.taskRecords[0].status = 'paused';
    assert.equal(goalReadyForEvaluation(goal), false);
  });

  it('extracts structured Worker reports from noisy evidence while bounding summaries and comments', () => {
    const report = {
      schema: 'review.v1', review_kind: 'security', verdict: 'pass',
      scope: { artifact_digest: 'sha256:candidate' }, summary: 'quoted } brace is safe',
    };
    const longSummary = `worker output\n${JSON.stringify(report)}\n${'x'.repeat(4500)}`;
    const comments = Array.from({ length: 9 }, (_, index) => ({
      author: `worker-${index}`, body: `${index}:${'c'.repeat(700)}`, created_at: `2026-08-24T00:00:0${index}.000Z`,
    }));
    const goal = goalRecord({
      taskRecords: [{
        taskId: 'security-review', actionId: 'review', title: 'Security review', profile: 'security-reviewer',
        waveIndex: 2, status: 'done', completedAt: '2026-08-24T00:01:00.000Z', acceptance: ['review report'],
      }],
    });
    const evidence = goalTaskEvidence(goal, new Map([['security-review', {
      task: { id: 'security-review', status: 'done' },
      latest_summary: longSummary,
      validation: 'not-json',
      comments,
    }]]));

    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].summary.length, 4000);
    assert.deepEqual(evidence[0].report, report);
    assert.equal(evidence[0].comments.length, 6);
    assert.equal(evidence[0].comments[0].author, 'worker-3');
    assert.equal(evidence[0].comments[0].body.length, 600);
    assert.deepEqual(_test.parseJsonObject(`prefix ${JSON.stringify(report)} suffix`), report);
  });

  it('credits the approved report from the latest Hermes run metadata before truncated summaries', () => {
    const staleReport = reviewReport('convention', { summary: 'stale validation report' });
    const currentReport = reviewReport('convention', { summary: 'complete latest run report' });
    const goal = goalRecord({
      taskRecords: [{
        taskId: 'convention-review', actionId: 'review', title: 'Convention review',
        profile: 'convention-reviewer', waveIndex: 2, status: 'done',
        completedAt: '2026-08-24T00:01:00.000Z', acceptance: ['review report'],
      }],
    });
    const evidence = goalTaskEvidence(goal, new Map([['convention-review', {
      task: { id: 'convention-review', status: 'done' },
      validation: JSON.stringify(staleReport),
      latest_summary: `truncated ${JSON.stringify(staleReport).slice(0, 80)}`,
      runs: [
        { id: 1, metadata: { report: staleReport, review_outcome: 'approved' } },
        { id: 2, metadata: JSON.stringify({ report: currentReport, review_outcome: 'approved' }) },
        { id: 3, metadata: { session_id: 'latest-run-without-a-report' } },
      ],
    }]]));

    assert.deepEqual(evidence[0].report, currentReport);
    assert.equal(evidence[0].persistedReportApproved, null);
    assert.equal(isStructuredEvidenceApproved(evidence[0]), true);
    const mismatched = evaluateWorkflowGates('quick-fix', evidence, {
      expectedCandidate: { digest: 'sha256:a-different-candidate' },
    });
    assert.deepEqual(mismatched.blockingReasons, [{
      taskId: 'convention-review', profile: 'convention-reviewer', reason: 'host-candidate-mismatch',
    }]);
  });

  it('credits the durable Hermes board task result when run metadata only contains a completion receipt', () => {
    const report = reviewReport('security', { summary: 'durable board result' });
    const goal = goalRecord({
      taskRecords: [{
        taskId: 'security-board-result', actionId: 'review', title: 'Security review',
        profile: 'security-reviewer', waveIndex: 2, status: 'done',
        completedAt: '2026-08-24T00:01:00.000Z', acceptance: ['review report'],
      }],
    });
    const evidence = goalTaskEvidence(goal, new Map([['security-board-result', {
      task: {
        id: 'security-board-result',
        status: 'done',
        result: JSON.stringify(report),
      },
      latest_summary: 'Security review passed, but this summary does not contain the full report.',
      runs: [{
        metadata: {
          schema: 'kanban-completion.v1',
          evidence: { verdict: 'pass' },
          artifacts: [{ kind: 'review', storage: 'kanban_result', schema: 'review.v1' }],
        },
      }],
    }]]));

    assert.deepEqual(evidence[0].report, report);
    assert.equal(evidence[0].persistedReportApproved, null);
    assert.equal(isStructuredEvidenceApproved(evidence[0]), true);
  });

  it('leaves metadata reports without an outcome to structural validation', () => {
    const report = reviewReport();
    const goal = goalRecord({
      taskRecords: [{
        taskId: 'outcome-less-review', profile: 'convention-reviewer', waveIndex: 2,
        status: 'done', completedAt: '2026-08-24T00:01:00.000Z',
      }],
    });
    const evidence = goalTaskEvidence(goal, new Map([['outcome-less-review', {
      task: { id: 'outcome-less-review', status: 'done' },
      runs: [{ metadata: { report } }],
    }]]));

    assert.equal(evidence[0].persistedReportApproved, null);
    assert.equal(isStructuredEvidenceApproved(evidence[0]), true);
    evidence[0].report.checks = [];
    assert.equal(isStructuredEvidenceApproved(evidence[0]), false);
  });

  it('does not let summary fallback bypass a rejected latest-run review outcome', () => {
    const report = reviewReport();
    const goal = goalRecord({
      taskRecords: [{
        taskId: 'rejected-review', profile: 'convention-reviewer', waveIndex: 2,
        status: 'done', completedAt: '2026-08-24T00:01:00.000Z',
      }],
    });
    const evidence = goalTaskEvidence(goal, new Map([['rejected-review', {
      task: { id: 'rejected-review', status: 'done' },
      latest_summary: JSON.stringify(report),
      runs: [{ metadata: { report, review_outcome: 'rejected' } }],
    }]]));

    assert.deepEqual(evidence[0].report, report);
    assert.equal(evidence[0].persistedReportApproved, false);
    assert.equal(isStructuredEvidenceApproved(evidence[0]), false);
  });

  it('reads an approved quality-gate report from latest Hermes run metadata', () => {
    const acceptance = [
      { criterion: 'API returns 200', status: 'met', evidence: ['contract test api.test.js:20'] },
      { criterion: 'Unauthorized requests are denied', status: 'met', evidence: ['auth test api.test.js:41'] },
    ];
    const report = gateReport(acceptance);
    const goal = goalRecord({
      taskRecords: [{
        taskId: 'metadata-gate', profile: 'quality-gate-reviewer', waveIndex: 3,
        status: 'done', completedAt: '2026-08-24T00:03:00.000Z',
      }],
    });
    const evidence = goalTaskEvidence(goal, new Map([['metadata-gate', {
      task: { id: 'metadata-gate', status: 'done' },
      latest_summary: '{"schema":"quality-gate.v1","candidate":',
      runs: [{ metadata: { report, review_outcome: 'approved' } }],
    }]]));

    assert.deepEqual(evidence[0].report, report);
    assert.equal(evaluateGoalAcceptance(goal, evidence, { gateTaskId: 'metadata-gate' }).satisfied, true);
  });

  it('accepts only the selected current quality gate with exact criterion evidence', () => {
    const goal = goalRecord();
    const completeAcceptance = [
      { criterion: ' API   RETURNS 200 ', status: 'met', evidence: ['contract test api.test.js:20'] },
      { criterion: 'Unauthorized requests are denied', status: 'met', evidence: ['auth test api.test.js:41'] },
    ];
    const evidence = [
      {
        taskId: 'gate-old', profile: 'quality-gate-reviewer', status: 'done', waveIndex: 2,
        completedAt: '2026-08-24T00:02:00.000Z', report: gateReport(completeAcceptance),
      },
      {
        taskId: 'gate-current', profile: 'quality-gate-reviewer', status: 'done', waveIndex: 3,
        completedAt: '2026-08-24T00:03:00.000Z', report: gateReport([
          completeAcceptance[0],
          { criterion: 'Unauthorized requests', status: 'met', evidence: ['substring is not enough'] },
        ]),
      },
      {
        taskId: 'writer-claim', profile: 'codex-implementer', status: 'done', waveIndex: 3,
        report: gateReport(completeAcceptance),
      },
    ];

    const currentIncomplete = evaluateGoalAcceptance(goal, evidence, { gateTaskId: 'gate-current' });
    assert.equal(currentIncomplete.satisfied, false);
    assert.deepEqual(currentIncomplete.missingCriteria, ['Unauthorized requests are denied']);
    assert.equal(evaluateGoalAcceptance(goal, evidence).satisfied, false, 'an explicit credited gate is mandatory');
    assert.equal(evaluateGoalAcceptance(goal, evidence, { gateTaskId: 'writer-claim' }).satisfied, false);

    evidence[1].report = gateReport(completeAcceptance);
    const accepted = evaluateGoalAcceptance(goal, evidence, { gateTaskId: 'gate-current' });
    assert.equal(accepted.satisfied, true);
    assert.equal(accepted.gateTaskId, 'gate-current');
    assert.ok(accepted.criteria.every(item => item.met && item.evidence.length > 0));

    evidence[1].report.acceptance[1] = {
      criterion: 'Unauthorized requests are denied', status: 'met', evidence: [],
    };
    assert.equal(evaluateGoalAcceptance(goal, evidence, { gateTaskId: 'gate-current' }).satisfied, false);

    evidence[1].report = gateReport(completeAcceptance);
    evidence[1].persistedReportApproved = false;
    assert.equal(
      evaluateGoalAcceptance(goal, evidence, { gateTaskId: 'gate-current' }).satisfied,
      false,
      'a compacted report cannot regain authority after its raw form failed validation',
    );

    evidence[1].persistedReportApproved = true;
    evidence[1].report.blockers = ['unresolved blocker'];
    assert.equal(
      evaluateGoalAcceptance(goal, evidence, { gateTaskId: 'gate-current' }).satisfied,
      false,
      'acceptance cannot bypass the strict quality-gate report contract',
    );
  });

  it('accepts conservative ordered criterion labels without reusing or guessing rows', () => {
    const successCriteria = [
      'Non-string inputs throw TypeError.',
      'Strings undergo NFKD normalization, combining-mark removal, trimming, lowercasing, ASCII-alphanumeric run separation, edge-hyphen removal, safe 32-character truncation, and untitled fallback.',
      'No runtime dependency or test-file changes are introduced.',
      'The complete npm test suite passes on the final revision.',
      'Convention, security, test-gap, and adversarial reviewers report no unresolved blocking findings, followed by a passing quality gate.',
    ];
    const acceptance = [
      { criterion: successCriteria[0], status: 'met', evidence: ['type probe'] },
      { criterion: 'Required normalization and slug pipeline.', status: 'met', evidence: ['pipeline probe'] },
      { criterion: 'No runtime dependency or protected-file changes.', status: 'met', evidence: ['git diff'] },
      { criterion: 'Complete npm test suite passes.', status: 'met', evidence: ['npm test'] },
      { criterion: 'Required current reviews have no unresolved blockers and quality gate passes.', status: 'met', evidence: ['gate audit'] },
    ];
    const evidence = [{
      taskId: 'ordered-gate', profile: 'quality-gate-reviewer', status: 'done', waveIndex: 3,
      completedAt: '2026-08-24T00:03:00.000Z', report: gateReport(acceptance),
    }];
    assert.equal(evaluateGoalAcceptance(
      goalRecord({ successCriteria }), evidence, { gateTaskId: 'ordered-gate' },
    ).satisfied, true);

    const duplicateGoal = goalRecord({ successCriteria: ['API returns 200', 'API returns 200'] });
    evidence[0].report = gateReport([
      { criterion: 'API returns 200', status: 'met', evidence: ['one row'] },
    ]);
    const duplicate = evaluateGoalAcceptance(duplicateGoal, evidence, { gateTaskId: 'ordered-gate' });
    assert.equal(duplicate.satisfied, false);
    assert.equal(duplicate.criteria.filter(item => item.met).length, 1, 'one gate row may be consumed only once');
  });

  it('builds a bounded fresh-turn prompt with current evidence, limited history, and recent Owner answers', () => {
    const ownerAnswers = Array.from({ length: 12 }, (_, index) => ({ at: `time-${index}`, answer: `answer-${index}` }));
    const goal = goalRecord({
      status: 'evaluating',
      phase: 'assessing_evidence',
      analysis: {
        requestSummary: 'Preserve the public API contract',
        evidence: ['SPEC.md checked'],
        risks: ['authorization regression'],
        unknowns: ['legacy client behavior'],
        workerStrategy: ['one bounded writer'],
        reviewStrategy: ['independent security review'],
        stopConditions: ['ask Owner before changing the public contract'],
        recommendedWorkflow: 'quick-fix',
      },
      publicDecisions: [{ at: 'time-decision', waveIndex: 2, decision: 'Keep the v1 response shape' }],
      ownerAnswers,
      currentWaveTaskIds: ['current-review'],
      currentCandidate: { revision: 'abc', digest: 'sha256:candidate' },
      waves: [{ id: 'wave-current', index: 41, taskIds: ['current-review'] }],
    });
    const historical = Array.from({ length: 40 }, (_, index) => ({
      taskId: `history-${index + 1}`,
      profile: index % 2 ? 'security-reviewer' : 'codex-implementer',
      kind: index % 2 ? 'review' : 'write',
      waveIndex: index + 1,
      status: 'done',
      completedAt: `2026-08-23T00:${String(index).padStart(2, '0')}:00.000Z`,
      summary: 'h'.repeat(900),
      comments: [{ body: 'historical detail must not be copied' }],
    }));
    const current = {
      taskId: 'current-review', profile: 'security-reviewer', kind: 'review', waveIndex: 41, status: 'done',
      completedAt: '2026-08-24T00:41:00.000Z', summary: 'c'.repeat(3200),
      comments: Array.from({ length: 7 }, (_, index) => ({ body: `comment-${index}` })),
    };
    const prompt = buildSupervisionPrompt({
      goal,
      evidence: [...historical, current],
      gateAudit: { satisfied: false, missingProfiles: ['quality-gate-reviewer'] },
      catalog: '[CATALOG FOR TEST]',
      reason: 'worker_wave_completed',
    });
    const snapshot = JSON.parse(prompt.split('[DURABLE GOAL SNAPSHOT]\n')[1]);

    assert.match(prompt, /fresh Director inference turn for an existing durable Goal/);
    assert.match(prompt, /Wake reason: worker_wave_completed/);
    assert.match(prompt, /"effect":"read_only\|workspace_write\|external_mutation\|skill_activation"/);
    assert.match(prompt, /\[CATALOG FOR TEST\]/);
    assert.deepEqual(snapshot.owner_answers.map(item => item.answer), ownerAnswers.slice(-8).map(item => item.answer));
    assert.equal(snapshot.current_wave.id, 'wave-current');
    assert.deepEqual(snapshot.goal_charter.risks, ['authorization regression']);
    assert.equal(snapshot.goal_charter.recommendedWorkflow, 'quick-fix');
    assert.equal(snapshot.public_decisions[0].decision, 'Keep the v1 response shape');
    assert.equal(snapshot.current_wave_evidence.length, 1);
    assert.equal(snapshot.current_wave_evidence[0].summary.length, 2500);
    assert.deepEqual(snapshot.current_wave_evidence[0].comments.map(item => item.body), ['comment-3', 'comment-4', 'comment-5', 'comment-6']);
    assert.equal(snapshot.historical_evidence.length, 32);
    assert.equal(snapshot.historical_evidence[0].taskId, 'history-9');
    assert.ok(snapshot.historical_evidence.filter(item => item.profile === 'codex-implementer').every(item => item.summary.length <= 500));
    assert.ok(snapshot.historical_evidence.filter(item => item.profile !== 'codex-implementer').every(item => item.summary === ''));
    assert.equal(prompt.includes('answer-0'), false);
    assert.ok(prompt.length < 50000, `prompt should remain bounded, got ${prompt.length} characters`);
  });

  it('compacts an oversized durable Goal without entering a permanent supervision deadlock', () => {
    const long = prefix => Array.from({ length: 100 }, (_, index) => `${prefix}-${index}-${'x'.repeat(1800)}`);
    const goal = goalRecord({
      objective: 'o'.repeat(200000),
      successCriteria: long('criterion'),
      constraints: long('constraint'),
      requirements: long('requirement'),
      ownerAnswers: long('answer').map((answer, index) => ({
        at: `time-${index}`, question: 'q'.repeat(2000), answer,
      })),
      analysis: {
        requestSummary: 's'.repeat(10000),
        evidence: long('checked'),
        risks: long('risk'),
        unknowns: long('unknown'),
        workerStrategy: long('worker'),
        reviewStrategy: long('review'),
        stopConditions: long('stop'),
        recommendedWorkflow: 'high-risk-change',
      },
      publicDecisions: long('decision').map((decision, index) => ({ at: `d-${index}`, waveIndex: index, decision })),
    });

    const prompt = buildSupervisionPrompt({
      goal,
      evidence: [],
      gateAudit: { satisfied: false, missingProfiles: ['quality-gate-reviewer'] },
      catalog: '[CATALOG FOR TEST]',
      reason: 'retry_after_restart',
    });
    const snapshot = JSON.parse(prompt.split('[DURABLE GOAL SNAPSHOT]\n')[1]);

    assert.ok(prompt.length < 130000, `prompt should remain below the hard budget, got ${prompt.length}`);
    assert.equal(snapshot.goal_charter.recommendedWorkflow, 'high-risk-change');
    assert.ok(snapshot.public_decisions.length > 0);
    assert.match(prompt, /retry_after_restart/);
  });
});
