import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canEscalateWorkflow,
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
  it('leaves automatic routing to the Director and preserves explicit modes', () => {
    assert.equal(inferRequestMode('지금 워커 몇 개야?'), 'auto');
    assert.equal(inferRequestMode('깃허브 이력 기준으로 각 작업자 태스크 정리해줘'), 'auto');
    assert.equal(inferRequestMode('코드 수정해줘'), 'auto');
    assert.equal(inferRequestMode('anything', 'conversation'), 'conversation');
    assert.equal(inferRequestMode('anything', 'delegate'), 'delegate');
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

  it('rejects a weak workflow for deterministic high-risk requirements and permits monotonic escalation', () => {
    const risky = {
      schema: 'director-analysis.v1', request_summary: 'Replace authentication and migrate the payment schema',
      success_criteria: ['public API remains compatible'], constraints: [],
      evidence: ['current database schema'], risks: ['credential leak and data loss'], unknowns: [],
      workflow_candidates: [{ id: 'quick-fix', fit: 'claimed small change', tradeoff: 'weak review' }],
      recommended_workflow: 'quick-fix', worker_strategy: ['one writer'],
      review_strategy: ['basic review'], stop_conditions: ['tests pass'],
    };
    assert.throws(() => validateDirectorAnalysis(risky), /high-risk-change.*risk floor/i);
    assert.throws(() => validateDirectorAnalysis({
      ...risky,
      recommended_workflow: 'standard-feature',
      workflow_candidates: [{ id: 'standard-feature', fit: 'claimed normal feature', tradeoff: 'insufficient specialist review' }],
    }), /high-risk-change.*standard-feature.*not allowed/i);
    const escalated = validateDirectorAnalysis({
      ...risky,
      recommended_workflow: 'high-risk-change',
      workflow_candidates: [{ id: 'high-risk-change', fit: 'security and migration risk', tradeoff: 'more review' }],
    }, { currentWorkflowId: 'standard-feature' });
    assert.equal(escalated.recommendedWorkflow, 'high-risk-change');
    assert.equal(canEscalateWorkflow('quick-fix', 'standard-feature'), true);
    assert.equal(canEscalateWorkflow('standard-feature', 'high-risk-change'), true);
    assert.equal(canEscalateWorkflow('high-risk-change', 'quick-fix'), false);
    assert.throws(() => validateDirectorAnalysis({
      ...risky,
      request_summary: 'Small label change', risks: ['regression'], success_criteria: ['label changes'],
      recommended_workflow: 'quick-fix',
    }, { currentWorkflowId: 'high-risk-change' }), /cannot downgrade/i);
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

  it('applies the control risk floor only to mutation-bearing actions', () => {
    const readOnlyGate = validateDirectorControl(control({
      workflow_id: 'quick-fix',
      requirements: ['Confirm authentication is not applicable to the changed utility.'],
      decisions: ['Authentication behavior was reviewed and requires no mutation.'],
      actions: [{
        id: 'quality-gate', title: 'Verify authentication is not applicable',
        target: 'quality-gate-reviewer', effect: 'read_only',
        task: 'Inspect the candidate and verify authentication is not applicable or already preserved.',
        skills: [], dependencies: [], write_scope: ['read-only:src/'],
        acceptance: ['Authentication status is verified with evidence.'], wake_on: ['completion', 'finding'],
      }],
    }), { requiredMode: 'delegate', currentWorkflowId: 'quick-fix' });
    assert.equal(readOnlyGate.workflowId, 'quick-fix');
    assert.equal(readOnlyGate.actions[0].effect, 'read_only');

    assert.equal(validateDirectorControl(control({
      workflow_id: 'quick-fix', state: 'complete', actions: [],
      requirements: ['Authentication was verified as not applicable.'],
      decisions: ['The read-only security evidence is current.'],
    }), { requiredMode: 'delegate', currentWorkflowId: 'quick-fix' }).state, 'complete');

    assert.throws(() => validateDirectorControl(control({
      workflow_id: 'quick-fix',
      actions: [{
        ...control().actions[0],
        title: 'Change authentication middleware',
        task: 'Modify authentication and login handling in the middleware.',
        acceptance: ['Authentication contract tests pass.'],
      }],
    }), { requiredMode: 'delegate', currentWorkflowId: 'quick-fix' }), /high-risk-change.*authentication.*quick-fix.*not allowed/i);
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
    assert.equal(validateDirectorControl(control({
      state: 'blocked', actions: [], decisions: ['A terminal Worker report proves the blocker.'],
    }), { requiredMode: 'delegate' }).state, 'blocked');
  });

  it('rejects inconsistent delegated states and Owner decisions', () => {
    assert.throws(() => validateDirectorControl(control({ state: 'planning', actions: [] })), /Invalid delegated Director state/);
    assert.throws(() => validateDirectorControl(control({ state: 'awaiting_owner', actions: [] })), /requires owner_decision/);
    assert.throws(() => validateDirectorControl(control({ state: 'complete' })), /cannot create worker tasks/);
    assert.throws(() => validateDirectorControl(control({
      state: 'blocked', actions: [],
      owner_decision: { required: true, question: 'Proceed?', options: [], evidence: [] },
    })), /must use awaiting_owner/);
    assert.throws(() => validateDirectorControl(control({
      state: 'blocked', actions: [], decisions: [],
    })), /public blocker decision/i);
  });

  it('rejects unknown workers, skills, and forward dependencies', () => {
    assert.throws(() => validateDirectorControl(control({ actions: [{ ...control().actions[0], target: 'random-agent' }] })), /Unapproved worker/);
    assert.throws(() => validateDirectorControl(control({ actions: [{ ...control().actions[0], skills: ['magic'] }] })), /Unapproved Praetorium skill/);
    assert.throws(() => validateDirectorControl(control({ actions: [
      { ...control().actions[0], dependencies: ['review'] },
      { ...control().actions[0], id: 'review' },
    ] })), /must appear earlier/);
  });

  it('fails closed when external or destructive authority is mislabeled as a workspace write', () => {
    const riskyActions = [
      { title: 'Push origin', task: 'Run git push origin main and open the production PR.' },
      { title: 'Notify customer', task: 'Send an email to the customer after the change.' },
      { title: 'Mutate API', task: 'POST https://api.example.invalid/releases to create the release.' },
      { title: 'Clean repository', task: 'Run git clean -fdx and delete all untracked files.' },
      { title: 'Drop old data', task: 'Drop the legacy database table permanently.' },
    ];
    for (const mutation of riskyActions) {
      assert.throws(() => validateDirectorControl(control({
        actions: [{ ...control().actions[0], ...mutation }],
      })), /must declare effect as external_mutation/i, mutation.task);
    }

    const approvedShape = validateDirectorControl(control({
      workflow_id: 'high-risk-change',
      actions: [{
        ...control().actions[0], title: 'Push origin', task: 'Run git push origin main.',
        effect: 'external_mutation',
      }],
    }));
    assert.equal(approvedShape.actions[0].effect, 'external_mutation');
  });

  it('requires every write authority to declare literal repository-relative candidate paths', () => {
    for (const scope of [['dist/**'], ['../outside'], ['.'], ['node_modules/pkg'], ['C:\\temp\\artifact']]) {
      assert.throws(() => validateDirectorControl(control({
        actions: [{ ...control().actions[0], write_scope: scope }],
      })), /repository-relative literal paths/i, scope[0]);
    }
    const accepted = validateDirectorControl(control({
      actions: [{ ...control().actions[0], write_scope: ['src/index.js', 'dist/app.js', 'literal $file name.js'] }],
    }));
    assert.deepEqual(accepted.actions[0].writeScope, ['dist/app.js', 'literal $file name.js', 'src/index.js']);
    assert.throws(() => validateDirectorControl(control({
      workflow_id: 'high-risk-change',
      actions: [{
        ...control().actions[0], title: 'Publish release', task: 'Publish the exact release.',
        effect: 'external_mutation', write_scope: ['https://registry.example.invalid/release'],
      }],
    })), /repository-relative literal paths/i);
  });

  it('rejects object-shaped string lists before they can hide deterministic risk', () => {
    assert.throws(() => validateDirectorAnalysis({
      schema: 'director-analysis.v1', request_summary: 'Small change', success_criteria: ['works'],
      constraints: [], evidence: [], risks: [{ category: 'authentication', detail: 'OAuth token handling' }],
      unknowns: [], workflow_candidates: [{ id: 'quick-fix', fit: 'small', tradeoff: 'none' }],
      recommended_workflow: 'quick-fix', worker_strategy: [], review_strategy: [], stop_conditions: [],
    }), /string arrays|deterministic risk floor/i);
  });

  it('provides monotonic high-risk variants for categorical workflows', () => {
    assert.equal(canEscalateWorkflow('release', 'release-high-risk'), true);
    assert.equal(canEscalateWorkflow('release', 'high-risk-change'), false);
    assert.equal(canEscalateWorkflow('skill-development', 'skill-development-high-risk'), true);
    assert.throws(() => validateDirectorAnalysis({
      schema: 'director-analysis.v1', request_summary: 'Release with OAuth migration', success_criteria: ['deployed'],
      constraints: [], evidence: [], risks: ['authentication and schema migration'], unknowns: [],
      workflow_candidates: [{ id: 'release', fit: 'release', tradeoff: 'risk' }],
      recommended_workflow: 'release', worker_strategy: [], review_strategy: [], stop_conditions: [],
    }), /release-high-risk is the deterministic risk floor/i);
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
