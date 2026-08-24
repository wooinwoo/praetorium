import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractDirectorAnalysis, extractDirectorControl, inferRequestMode,
  validateDirectorAnalysis, validateDirectorControl,
} from '../../lib/director-actions.js';
import {
  evaluateWorkflowGates, workflowById, workflowPolicyById,
} from '../../lib/workflow-catalog.js';

function control(overrides = {}) {
  return {
    schema: 'director-action.v1', mode: 'delegate', workflow_id: 'standard-feature', state: 'executing',
    requirements: ['observable result'], decisions: ['separate implementation and review'],
    actions: [{
      id: 'implement', title: 'Implement', target: 'codex-implementer', task: 'Implement the bounded feature.',
      effect: 'workspace_write', skills: [], dependencies: [], write_scope: ['src/'], acceptance: ['tests pass'], wake_on: ['completion'],
    }],
    owner_decision: { required: false, question: null, options: [], evidence: [] },
    ...overrides,
  };
}

describe('Director action control', () => {
  it('classifies execution requests before conversational question patterns', () => {
    assert.equal(inferRequestMode('이 공고들 조사해줄래?'), 'delegate');
    assert.equal(inferRequestMode('지금 워커 몇 개야?'), 'conversation');
    assert.equal(inferRequestMode('작업들 요약좀'), 'conversation');
    assert.equal(inferRequestMode('현재 상태 정리해줘'), 'conversation');
    assert.equal(inferRequestMode('현재 작업 상태 확인해줘'), 'conversation');
    assert.equal(inferRequestMode('이번 변경사항 설명해줘'), 'conversation');
    assert.equal(inferRequestMode('상태 요약하고 코드 수정해줘'), 'delegate');
    assert.equal(inferRequestMode('요약 문서 작성해줘'), 'delegate');
    assert.equal(inferRequestMode('ㅎㅇ'), 'conversation');
    assert.equal(inferRequestMode('do the thing'), 'delegate');
  });

  it('extracts the tagged control envelope without exposing it to the Owner', () => {
    const result = extractDirectorControl(`공개 판단입니다.\n<PRAETORIUM_CONTROL>\n${JSON.stringify(control())}\n</PRAETORIUM_CONTROL>`);
    assert.equal(result.publicOutput, '공개 판단입니다.');
    assert.equal(result.control.workflow_id, 'standard-feature');
  });

  it('validates the public Director analysis checkpoint', () => {
    const raw = {
      schema: 'director-analysis.v1', request_summary: 'ship feature', success_criteria: ['works'],
      constraints: ['local only'], evidence: ['repository instructions'], risks: ['regression'], unknowns: [],
      workflow_candidates: [{ id: 'standard-feature', fit: 'multi-step change', tradeoff: 'more review time' }],
      recommended_workflow: 'standard-feature', worker_strategy: ['two independent scopes'],
      review_strategy: ['convention and adversarial'], stop_conditions: ['two failed remediation loops'],
    };
    const extracted = extractDirectorAnalysis(`<PRAETORIUM_ANALYSIS>${JSON.stringify(raw)}</PRAETORIUM_ANALYSIS>`);
    const value = validateDirectorAnalysis(extracted);
    assert.equal(value.recommendedWorkflow, 'standard-feature');
    assert.deepEqual(value.risks, ['regression']);
  });

  it('validates an approved workflow and worker graph', () => {
    const value = control({ actions: [
      control().actions[0],
      { id: 'review', title: 'Review', target: 'adversarial-reviewer', effect: 'read_only', task: 'Falsify behavior.', skills: ['adversarial-review'], dependencies: ['implement'], write_scope: ['read-only'], acceptance: ['verdict'], wake_on: ['finding'] },
    ] });
    const parsed = validateDirectorControl(value, { requiredMode: 'delegate' });
    assert.equal(parsed.actions.length, 2);
    assert.deepEqual(parsed.actions[1].dependencies, ['implement']);
  });

  it('rejects direct execution answers without durable actions', () => {
    assert.throws(() => validateDirectorControl(control({ mode: 'conversation', workflow_id: null, actions: [] }), { requiredMode: 'delegate' }), /must be delegated/);
    assert.throws(() => validateDirectorControl(control({ actions: [] }), { requiredMode: 'delegate' }), /at least one/);
  });

  it('accepts terminal and Owner-waiting delegate checkpoints without actions', () => {
    const awaiting = validateDirectorControl(control({
      state: 'awaiting_owner', actions: [],
      owner_decision: { required: true, question: 'Which contract should win?', options: ['A', 'B'], evidence: ['conflict'] },
    }), { requiredMode: 'delegate' });
    assert.equal(awaiting.state, 'awaiting_owner');
    assert.equal(awaiting.ownerDecision.question, 'Which contract should win?');
    assert.equal(validateDirectorControl(control({ state: 'complete', actions: [] }), { requiredMode: 'delegate' }).state, 'complete');
    assert.equal(validateDirectorControl(control({ state: 'blocked', actions: [] }), { requiredMode: 'delegate' }).state, 'blocked');
  });

  it('rejects inconsistent delegated states and Owner decisions', () => {
    assert.throws(() => validateDirectorControl(control({ state: 'planning', actions: [] })), /Invalid delegated Director state/);
    assert.throws(() => validateDirectorControl(control({ state: 'awaiting_owner', actions: [] })), /requires owner_decision/);
    assert.throws(() => validateDirectorControl(control({ state: 'complete' })), /cannot create worker tasks/);
    assert.throws(() => validateDirectorControl(control({
      state: 'blocked', actions: [],
      owner_decision: { required: true, question: 'Proceed?', options: [], evidence: [] },
    })), /must use awaiting_owner/);
  });

  it('rejects unknown workers, skills, and forward dependencies', () => {
    assert.throws(() => validateDirectorControl(control({ actions: [{ ...control().actions[0], target: 'random-agent' }] })), /Unapproved worker/);
    assert.throws(() => validateDirectorControl(control({ actions: [{ ...control().actions[0], skills: ['magic'] }] })), /Unapproved Praetorium skill/);
    assert.throws(() => validateDirectorControl(control({ actions: [
      { ...control().actions[0], dependencies: ['review'] },
      { ...control().actions[0], id: 'review' },
    ] })), /must appear earlier/);
  });
});

describe('Workflow gate policy', () => {
  const kinds = {
    'convention-reviewer': 'convention', 'test-gap-reviewer': 'test-gap',
    'adversarial-reviewer': 'adversarial', 'release-reviewer': 'release-readiness',
  };
  const review = (profile, digest) => ({
    schema: 'review.v1', review_kind: kinds[profile],
    scope: { project: 'test', objective: 'test', base_revision: 'base', head_revision: 'head', artifact_digest: digest, paths: ['src/'] },
    verdict: 'pass', summary: 'supported pass',
    checks: [{ id: 'check', status: 'pass', evidence: ['test output'] }], findings: [],
    coverage: { examined: ['src/'], omitted: [], limitations: [], assumptions: [] },
  });
  const gate = (profiles, digest) => ({
    schema: 'quality-gate.v1', candidate: { revision: 'head', artifact_digest: digest }, decision: 'advance',
    acceptance: [{ criterion: 'works', status: 'met', evidence: ['test output'] }],
    reports: profiles.map(profile => ({ review_kind: kinds[profile], status: 'current', verdict: 'pass' })),
    blockers: [], residual_risk: [], next_action: 'advance',
  });
  const done = (taskId, profile, completedAt, waveIndex, report = null) => ({ taskId, profile, status: 'done', completedAt, waveIndex, report });

  it('publishes executable policy on every workflow', () => {
    for (const id of ['quick-fix', 'standard-feature', 'high-risk-change', 'research-planning', 'release', 'skill-development']) {
      const workflow = workflowById(id);
      assert.ok(workflow.policy.requiredProfiles.length >= 2, id);
      assert.equal(workflow.policy, workflowPolicyById(id));
      assert.ok(workflow.policy.gateProfiles.includes('quality-gate-reviewer'), id);
    }
    assert.ok(workflowPolicyById('high-risk-change').reviewProfiles.includes('security-reviewer'));
    assert.equal(workflowPolicyById('release').ownerApprovalBeforeExternalAction, true);
  });

  it('requires all workflow profiles and invalidates review evidence after remediation', () => {
    const initialEvidence = [
      done('implement', 'codex-implementer', '2026-08-24T01:00:00.000Z', 0),
      done('convention', 'convention-reviewer', '2026-08-24T01:01:00.000Z', 1, review('convention-reviewer', 'candidate-1')),
      done('test-gap', 'test-gap-reviewer', '2026-08-24T01:01:00.000Z', 1, review('test-gap-reviewer', 'candidate-1')),
      done('adversarial', 'adversarial-reviewer', '2026-08-24T01:01:00.000Z', 1, review('adversarial-reviewer', 'candidate-1')),
      done('gate', 'quality-gate-reviewer', '2026-08-24T01:02:00.000Z', 2, gate(['convention-reviewer', 'test-gap-reviewer', 'adversarial-reviewer'], 'candidate-1')),
    ];
    const passed = evaluateWorkflowGates('standard-feature', initialEvidence);
    assert.equal(passed.satisfied, true);
    assert.deepEqual(passed.missingProfiles, []);

    const remediated = evaluateWorkflowGates('standard-feature', [
      ...initialEvidence,
      done('remediate', 'remediator', '2026-08-24T01:03:00.000Z', 3),
    ]);
    assert.equal(remediated.satisfied, false);
    assert.deepEqual(remediated.staleProfiles.sort(), [
      'adversarial-reviewer', 'convention-reviewer', 'quality-gate-reviewer', 'test-gap-reviewer',
    ]);
    assert.equal(remediated.latestWriteTaskId, 'remediate');

    const rerun = evaluateWorkflowGates('standard-feature', [
      ...initialEvidence,
      done('remediate', 'remediator', '2026-08-24T01:03:00.000Z', 3),
      done('convention-2', 'convention-reviewer', '2026-08-24T01:04:00.000Z', 4, review('convention-reviewer', 'candidate-2')),
      done('test-gap-2', 'test-gap-reviewer', '2026-08-24T01:04:00.000Z', 4, review('test-gap-reviewer', 'candidate-2')),
      done('adversarial-2', 'adversarial-reviewer', '2026-08-24T01:04:00.000Z', 4, review('adversarial-reviewer', 'candidate-2')),
      done('gate-2', 'quality-gate-reviewer', '2026-08-24T01:05:00.000Z', 5, gate(['convention-reviewer', 'test-gap-reviewer', 'adversarial-reviewer'], 'candidate-2')),
    ]);
    assert.equal(rerun.satisfied, true);
    assert.deepEqual(rerun.staleProfiles, []);
  });

  it('does not credit failed or incomplete gate tasks', () => {
    const result = evaluateWorkflowGates('release', [
      { taskId: 'release-review', profile: 'release-reviewer', status: 'failed', completedAt: '2026-08-24T01:00:00.000Z', waveIndex: 0 },
      done('gate', 'quality-gate-reviewer', '2026-08-24T01:01:00.000Z', 1, gate(['release-reviewer'], 'candidate')),
    ]);
    assert.equal(result.satisfied, false);
    assert.deepEqual(result.missingProfiles, ['release-reviewer', 'quality-gate-reviewer']);
    assert.deepEqual(result.completedProfiles, ['quality-gate-reviewer']);
  });
});
