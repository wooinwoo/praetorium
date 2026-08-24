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

  it('builds a bounded fresh-turn prompt with current evidence, limited history, and recent Owner answers', () => {
    const ownerAnswers = Array.from({ length: 12 }, (_, index) => ({ at: `time-${index}`, answer: `answer-${index}` }));
    const goal = goalRecord({
      status: 'evaluating',
      phase: 'assessing_evidence',
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
});
