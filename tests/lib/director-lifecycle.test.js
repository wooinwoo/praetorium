import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectorService } from '../../lib/director-service.js';

const PROJECT = Object.freeze({ id: 'alpha', name: 'Alpha', path: 'C:\\projects\\alpha', slot: 1 });
const CANDIDATE_V1 = 'sha256:candidate-v1';
const CANDIDATE_V2 = 'sha256:candidate-v2';
const SUCCESS_CRITERION = 'feature is verified';
const REVIEW_PROFILES = [
  'convention-reviewer',
  'test-gap-reviewer',
  'adversarial-reviewer',
];
const REVIEW_KIND = Object.freeze({
  'convention-reviewer': 'convention',
  'test-gap-reviewer': 'test-gap',
  'adversarial-reviewer': 'adversarial',
});

function analysisOutput(workflowId = 'quick-fix') {
  return `<PRAETORIUM_ANALYSIS>${JSON.stringify({
    schema: 'director-analysis.v1',
    request_summary: 'Implement and independently verify the feature',
    success_criteria: [SUCCESS_CRITERION],
    constraints: ['keep the candidate local'],
    evidence: ['repository contract'],
    risks: ['regression'],
    unknowns: [],
    workflow_candidates: [{ id: workflowId, fit: 'bounded implementation and review', tradeoff: 'review cost' }],
    recommended_workflow: workflowId,
    worker_strategy: ['one isolated implementation wave'],
    review_strategy: ['fresh independent review and quality gate'],
    stop_conditions: ['quality gate rejects the candidate'],
  })}</PRAETORIUM_ANALYSIS>`;
}

function controlOutput({
  state = 'executing', workflowId = 'quick-fix', actions = [],
  decisions = [], requirements = [SUCCESS_CRITERION], publicOutput = 'Director checkpoint',
} = {}) {
  return `${publicOutput}\n<PRAETORIUM_CONTROL>${JSON.stringify({
    schema: 'director-action.v1',
    mode: 'delegate',
    workflow_id: workflowId,
    state,
    requirements,
    decisions,
    actions,
    owner_decision: { required: false, question: null, options: [], evidence: [] },
  })}</PRAETORIUM_CONTROL>`;
}

function action({
  id, target, effect = 'read_only', dependencies = [], scope = ['read-only:src/'],
  skills = [], title = `${target} task`, task = `Produce ${target} evidence`,
  acceptance = ['structured evidence is current'], wakeOn = ['completion'],
}) {
  return {
    id, title, target, effect, task, skills, dependencies,
    write_scope: scope, acceptance, wake_on: wakeOn,
  };
}

function implementationActions(count = 1, { effect = 'workspace_write' } = {}) {
  return Array.from({ length: count }, (_, index) => action({
    id: `implement-${index + 1}`,
    title: `Implement part ${index + 1}`,
    target: 'codex-implementer',
    effect,
    scope: [`src/part-${index + 1}.js`],
    task: `Implement isolated part ${index + 1}`,
    acceptance: [SUCCESS_CRITERION],
  }));
}

function verificationActions() {
  const reviews = REVIEW_PROFILES.map(profile => action({
    id: REVIEW_KIND[profile],
    title: `${REVIEW_KIND[profile]} review`,
    target: profile,
    skills: [profile === 'convention-reviewer' ? 'convention-review'
      : profile === 'test-gap-reviewer' ? 'test-gap-review' : 'adversarial-review'],
    acceptance: [`valid ${REVIEW_KIND[profile]} review.v1`],
    wakeOn: ['completion', 'finding'],
  }));
  return [
    ...reviews,
    action({
      id: 'quality-gate',
      title: 'Quality gate',
      target: 'quality-gate-reviewer',
      skills: ['quality-gate'],
      dependencies: reviews.map(item => item.id),
      acceptance: [SUCCESS_CRITERION],
    }),
  ];
}

function reviewReport(profile, digest = CANDIDATE_V1) {
  const reviewKind = REVIEW_KIND[profile];
  return {
    schema: 'review.v1',
    review_kind: reviewKind,
    scope: {
      project: 'praetorium', objective: SUCCESS_CRITERION,
      base_revision: 'base', head_revision: null, artifact_digest: digest, paths: ['src/'],
    },
    verdict: 'pass',
    summary: `${reviewKind} review passed`,
    checks: [{ id: `${reviewKind}-check`, status: 'pass', evidence: ['node --test passed'] }],
    findings: [],
    coverage: { examined: ['src/'], omitted: [], limitations: [], assumptions: [] },
  };
}

function qualityGateReport(digest = CANDIDATE_V1) {
  return {
    schema: 'quality-gate.v1',
    candidate: { revision: null, artifact_digest: digest },
    decision: 'advance',
    acceptance: [{ criterion: SUCCESS_CRITERION, status: 'met', evidence: ['node --test passed'] }],
    reports: REVIEW_PROFILES.map(profile => ({
      review_kind: REVIEW_KIND[profile], status: 'current', verdict: 'pass',
    })),
    blockers: [],
    residual_risk: [],
    next_action: 'complete the verified Goal',
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class FakeRuntime {
  constructor({ chat, candidateSnapshot, createTask, tasks = [] } = {}) {
    this.chatImpl = chat || (() => { throw new Error('Unexpected Director inference'); });
    this.candidateSnapshotImpl = candidateSnapshot || (() => ({
      schema: 'candidate-snapshot.v1', revision: 'candidate-v1', digest: CANDIDATE_V1, dirty: true,
    }));
    this.createTaskImpl = createTask || null;
    this.tasks = new Map(tasks.map(task => [task.id, clone(task)]));
    this.chatCalls = [];
    this.createTaskCalls = [];
    this.snapshotCalls = 0;
    this.nextTask = this.tasks.size;
  }

  async ensureBoard() {}

  async chat(options) {
    this.chatCalls.push(options.prompt);
    return { stdout: await this.chatImpl({ ...options, call: this.chatCalls.length }) };
  }

  async listTasks() {
    return [...this.tasks.values()].map(task => ({
      id: task.id,
      title: task.title,
      status: task.status,
      assignee: task.assignee,
      completed_at: task.completed_at || null,
    }));
  }

  async dispatch({ max }) {
    return { json: { spawned: max } };
  }

  async createTask(options) {
    const persistedCall = clone(options);
    this.createTaskCalls.push(persistedCall);
    const custom = this.createTaskImpl
      ? await this.createTaskImpl(persistedCall, this.createTaskCalls.length)
      : null;
    const id = custom?.id || `t_fake_${++this.nextTask}`;
    this.tasks.set(id, {
      id,
      title: options.title,
      assignee: options.assignee,
      status: 'ready',
      completed_at: null,
      report: null,
      summary: '',
    });
    return { json: { id } };
  }

  async taskDetails({ taskId }) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    return {
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        completed_at: task.completed_at || null,
      },
      latest_summary: task.summary || '',
      validation: task.report || null,
      comments: [{ author: task.assignee || 'worker', body: 'OBSERVED: bounded task evidence recorded.' }],
      events: [{ type: 'task_observed', status: task.status }],
      runs: [{ id: `run-${task.id}`, status: task.status }],
    };
  }

  async taskLog({ taskId }) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    return `task=${taskId} status=${task.status}\n${task.summary || ''}`;
  }

  async candidateSnapshot() {
    this.snapshotCalls += 1;
    return clone(await this.candidateSnapshotImpl(this.snapshotCalls));
  }

  complete(taskId, { report = null } = {}) {
    const task = this.tasks.get(taskId);
    assert.ok(task, `Unknown fake task ${taskId}`);
    task.status = 'done';
    task.completed_at = new Date(Date.UTC(2026, 7, 24, 0, 0, this.snapshotCalls + this.createTaskCalls.length)).toISOString();
    task.report = clone(report);
    task.summary = report ? JSON.stringify(report) : 'Implementation completed with tests.';
  }
}

function createService(runtime, stateFile = null) {
  const dir = stateFile ? null : mkdtempSync(join(tmpdir(), 'director-lifecycle-'));
  return new DirectorService({
    runtime,
    stateFile: stateFile || join(dir, 'directors.json'),
    projectsRoot: 'C:\\projects',
    getProjects: () => [PROJECT],
  });
}

async function waitFor(check, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForRun(service, runId) {
  return waitFor(() => {
    const run = service.getRun(runId);
    return ['completed', 'failed'].includes(run?.status) ? run : null;
  }, `run ${runId}`);
}

async function settleService(service) {
  await new Promise(resolve => setImmediate(resolve));
  await waitFor(() => service.boardLocks.size === 0 && service.goalLocks.size === 0, 'service locks to settle');
  await new Promise(resolve => setImmediate(resolve));
}

function lifecycleRuntime({ candidateSnapshot } = {}) {
  let supervisionTurns = 0;
  return new FakeRuntime({
    candidateSnapshot,
    chat: ({ prompt }) => {
      if (prompt.includes('[PRAETORIUM ANALYSIS CHECKPOINT]')) return analysisOutput();
      if (prompt.includes('[PRAETORIUM DURABLE GOAL SUPERVISION]')) {
        supervisionTurns += 1;
        if (supervisionTurns === 1) {
          return controlOutput({
            actions: verificationActions(),
            decisions: ['Implementation evidence requires fresh independent reviews.'],
            publicOutput: 'Fresh review wave required.',
          });
        }
        return controlOutput({
          state: 'complete',
          actions: [],
          decisions: ['All exact candidate-bound gates and success criteria passed.'],
          publicOutput: 'The verified Goal is complete.',
        });
      }
      return controlOutput({
        actions: implementationActions(),
        decisions: ['Implement before independent review.'],
        publicOutput: 'Implementation wave created.',
      });
    },
  });
}

async function startLifecycle(service) {
  const submitted = service.submitMessage('project-director-1', 'Implement the feature completely', { mode: 'delegate' });
  const run = await waitForRun(service, submitted.id);
  assert.equal(run.status, 'completed', run.error || 'initial Director turn failed');
  await settleService(service);
  const goal = service.getGoal(run.goalId);
  assert.equal(goal.waves.length, 1);
  return { run, goal };
}

async function advanceToVerification(service, runtime, goal) {
  const implementationTaskId = goal.waves[0].taskIds[0];
  runtime.complete(implementationTaskId);
  const tick = await service.tickDirector('project-director-1');
  await settleService(service);
  assert.equal(tick.supervision?.state, 'verifying', tick.supervision?.error || 'verification wave was not created');
  assert.equal(goal.waves.length, 2);
  return tick.supervision;
}

function completeVerificationWave(runtime, goal, digest = CANDIDATE_V1) {
  const wave = goal.waves[1];
  for (const taskId of wave.taskIds) {
    const task = runtime.tasks.get(taskId);
    const report = task.assignee === 'quality-gate-reviewer'
      ? qualityGateReport(digest)
      : reviewReport(task.assignee, digest);
    runtime.complete(taskId, { report });
  }
}

function externalApprovalRuntime() {
  let supervisionTurns = 0;
  return new FakeRuntime({
    chat: ({ prompt }) => {
      if (prompt.includes('[PRAETORIUM ANALYSIS CHECKPOINT]')) return analysisOutput();
      if (prompt.includes('[PRAETORIUM DURABLE GOAL SUPERVISION]')) {
        supervisionTurns += 1;
        if (supervisionTurns === 1) {
          return controlOutput({
            actions: verificationActions(),
            decisions: ['Create fresh review and quality-gate evidence before external authority.'],
            publicOutput: 'Fresh verification wave required.',
          });
        }
        return controlOutput({
          actions: implementationActions(1, { effect: 'external_mutation' }),
          decisions: ['Stage one exact external action after the fresh host-bound gate.'],
          publicOutput: 'Owner approval is required for the exact external action.',
        });
      }
      return controlOutput({
        actions: implementationActions(),
        decisions: ['Implement locally before independent review.'],
        publicOutput: 'Implementation wave created.',
      });
    },
  });
}

describe('Director durable lifecycle', () => {
  it('completes implementation through fresh independent reviews and an exact host-bound quality gate', async () => {
    const runtime = lifecycleRuntime();
    const service = createService(runtime);
    const { goal } = await startLifecycle(service);

    const firstSupervision = await advanceToVerification(service, runtime, goal);
    const implementationAssessment = goal.waves[0].assessment;
    assert.equal(implementationAssessment.runId, firstSupervision.runId);
    assert.equal(implementationAssessment.state, 'verifying');
    assert.deepEqual(implementationAssessment.decisions, ['Implementation evidence requires fresh independent reviews.']);
    assert.equal(implementationAssessment.gateAudit.hostCandidate.digest, CANDIDATE_V1);
    assert.equal(implementationAssessment.gateAudit.satisfied, false);
    assert.deepEqual(implementationAssessment.gateAudit.missingProfiles, [
      'convention-reviewer', 'test-gap-reviewer', 'adversarial-reviewer', 'quality-gate-reviewer',
    ]);
    assert.ok(runtime.createTaskCalls.length >= 5);
    assert.ok(
      runtime.createTaskCalls.every(call => call.goalMode === true),
      'implementers, reviewers, and quality gates must all keep a durable lifecycle turn loop',
    );

    completeVerificationWave(runtime, goal);
    const completedTick = await service.tickDirector('project-director-1');
    const completed = service.getGoal(goal.id);

    assert.equal(completedTick.supervision?.state, 'completed', completedTick.supervision?.error || 'Goal did not complete');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.finalReport, 'The verified Goal is complete.');
    assert.ok(completed.completedAt);
    assert.equal(service.getDirector('project-director-1').activeGoalId, null);
    assert.equal(completed.currentCandidate.digest, CANDIDATE_V1);
    assert.equal(completed.waves[0].assessment, implementationAssessment, 'the prior wave assessment must not be overwritten');
    assert.equal(completed.waves[1].assessment.runId, completedTick.supervision.runId);
    assert.equal(completed.waves[1].assessment.state, 'completed');
    assert.equal(completed.waves[1].assessment.gateAudit.satisfied, true);
    assert.equal(completed.waves[1].assessment.gateAudit.acceptance.satisfied, true);
    assert.equal(completed.finalAudit.satisfied, true);
    assert.equal(completed.finalAudit.hostReceipts.satisfied, true);
    assert.equal(completed.finalAudit.hostReceipts.executionAttested, false);
    assert.ok(completed.taskRecords.every(record => record.hostReceipt?.schema === 'hermes-board-observation.v1'));
    assert.equal(runtime.snapshotCalls, 3, 'audit capture plus final pre-completion capture must observe one candidate');
  });

  it('rejects completion when the candidate digest changes during the final Director inference', async () => {
    const runtime = lifecycleRuntime({
      candidateSnapshot: call => ({
        schema: 'candidate-snapshot.v1',
        revision: call <= 2 ? 'candidate-v1' : 'candidate-v2',
        digest: call <= 2 ? CANDIDATE_V1 : CANDIDATE_V2,
        dirty: true,
      }),
    });
    const service = createService(runtime);
    const { goal } = await startLifecycle(service);
    await advanceToVerification(service, runtime, goal);
    completeVerificationWave(runtime, goal, CANDIDATE_V1);

    const rejectedTick = await service.tickDirector('project-director-1');
    const rejected = service.getGoal(goal.id);

    assert.match(rejectedTick.supervision?.error || '', /candidate changed after evidence evaluation/);
    assert.notEqual(rejected.status, 'completed');
    assert.equal(rejected.completedAt, null);
    assert.equal(rejected.currentCandidate.digest, CANDIDATE_V2);
    const finalRun = service.getRun(rejectedTick.supervision.runId);
    assert.equal(finalRun.status, 'failed');
    assert.match(finalRun.error, /candidate changed after evidence evaluation/);
    assert.equal(runtime.snapshotCalls, 4, 'the rejected complete checkpoint is retried once but never accepted');
  });

  it('recovers only the second action from the persisted journal with the exact idempotency contract', async () => {
    const beforeCrash = new FakeRuntime({
      chat: ({ prompt }) => {
        if (prompt.includes('[PRAETORIUM ANALYSIS CHECKPOINT]')) return analysisOutput();
        return controlOutput({
          actions: implementationActions(2),
          decisions: ['Two disjoint implementation actions can run independently.'],
        });
      },
      createTask: (options, call) => {
        if (call === 2) throw new Error('simulated crash during second createTask');
        return { id: 't_first_created' };
      },
    });
    const firstService = createService(beforeCrash);
    const submitted = firstService.submitMessage('project-director-1', 'Implement both isolated parts', { mode: 'delegate' });
    const failedRun = await waitForRun(firstService, submitted.id);
    assert.equal(failedRun.status, 'failed');
    assert.match(failedRun.error, /simulated crash during second createTask/);
    const goal = firstService.getGoal(failedRun.goalId);
    const wave = goal.waves[0];
    assert.equal(wave.status, 'materializing');
    assert.equal(wave.actions[0].taskId, 't_first_created');
    assert.equal(wave.actions[1].taskId, null);
    assert.deepEqual(wave.taskIds, ['t_first_created']);
    const failedSecondCreate = beforeCrash.createTaskCalls[1];

    const afterRestart = new FakeRuntime({
      tasks: [...beforeCrash.tasks.values()],
      createTask: () => ({ id: 't_second_recovered' }),
    });
    const restarted = createService(afterRestart, firstService.stateFile);
    const recoveryTick = await restarted.tickDirector('project-director-1');
    await settleService(restarted);
    const recovered = restarted.getGoal(goal.id);

    assert.deepEqual(recoveryTick.supervision?.recoveredTaskIds, ['t_second_recovered']);
    assert.equal(afterRestart.chatCalls.length, 0, 'journal recovery must not ask the model to regenerate the plan');
    assert.equal(afterRestart.createTaskCalls.length, 1, 'the already-created first action must not be duplicated');
    assert.deepEqual(afterRestart.createTaskCalls[0], failedSecondCreate);
    assert.deepEqual(recovered.waves[0].taskIds, ['t_first_created', 't_second_recovered']);
    assert.equal(recovered.waves[0].actions[0].taskId, 't_first_created');
    assert.equal(recovered.waves[0].actions[1].taskId, 't_second_recovered');
  });

  it('resumes the exact approved external-mutation plan after a crash without another model turn', async () => {
    const beforeCrash = externalApprovalRuntime();
    const firstService = createService(beforeCrash);
    const { goal } = await startLifecycle(firstService);
    await advanceToVerification(firstService, beforeCrash, goal);
    completeVerificationWave(beforeCrash, goal);
    const approvalTick = await firstService.tickDirector('project-director-1');
    await settleService(firstService);

    assert.equal(approvalTick.supervision?.state, 'awaiting_owner', approvalTick.supervision?.error || 'authority plan was not parked');
    assert.equal(goal.status, 'awaiting_owner');
    const pending = clone(goal.pendingAuthorityPlan);
    assert.equal(pending.candidateDigest, CANDIDATE_V1);
    assert.equal(pending.gateAudit.hostReceipts.satisfied, true);
    const approveOption = goal.ownerDecision.options.find(option => goal.ownerDecision.optionActions[option] === 'approve');
    assert.ok(approveOption, 'host approval decision must expose an approve option');

    let interceptedResume = 0;
    firstService._resumeApprovedAuthority = async () => { interceptedResume += 1; return { simulatedCrash: true }; };
    await firstService.answerGoalDecision('project-director-1', goal.id, {
      answer: approveOption,
      selectedOption: approveOption,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(interceptedResume, 1);
    assert.equal(goal.status, 'planning');
    assert.equal(goal.pendingAuthorityPlan.planDigest, pending.planDigest);
    assert.ok(goal.ownerApprovals.some(item => item.planDigest === pending.planDigest));

    const afterRestart = new FakeRuntime();
    const restarted = createService(afterRestart, firstService.stateFile);
    const resumedTick = await restarted.tickDirector('project-director-1');
    await settleService(restarted);
    const resumed = restarted.getGoal(goal.id);

    assert.equal(afterRestart.chatCalls.length, 0, 'an exact approved plan must resume without Director inference');
    assert.equal(afterRestart.createTaskCalls.length, 1);
    assert.equal(afterRestart.createTaskCalls[0].assignee, pending.plan.actions[0].target);
    assert.equal(afterRestart.createTaskCalls[0].title, pending.plan.actions[0].title);
    assert.match(afterRestart.createTaskCalls[0].body, /\[EFFECT\] external_mutation/);
    assert.equal(
      afterRestart.createTaskCalls[0].idempotencyKey,
      `praetorium-${goal.id}-3-${pending.plan.actions[0].id}`,
    );
    assert.equal(resumedTick.supervision?.state, 'executing');
    assert.equal(resumed.pendingAuthorityPlan, null);
    assert.equal(resumed.status, 'executing');
  });

  it('recovers an active Goal from a checksum-valid backup when the primary state is corrupt', async () => {
    const runtime = lifecycleRuntime();
    const firstService = createService(runtime);
    const submitted = firstService.submitMessage('project-director-1', 'Prepare a recoverable active Goal', { mode: 'delegate' });
    const plannedRun = await waitForRun(firstService, submitted.id);
    assert.equal(plannedRun.status, 'completed');
    const goal = firstService.getGoal(plannedRun.goalId);
    assert.equal(goal.status, 'executing');
    firstService._save();
    firstService._save();

    const backupPath = `${firstService.stateFile}.bak`;
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
    const expectedDigest = backup.integrity.digest;
    delete backup.integrity;
    assert.equal(createHash('sha256').update(JSON.stringify(backup)).digest('hex'), expectedDigest);
    assert.ok(backup.goals.some(item => item.id === goal.id && item.status === 'executing'));

    writeFileSync(firstService.stateFile, '{"schema":2,"corrupt":', 'utf8');
    const recoveredService = createService(new FakeRuntime(), firstService.stateFile);
    const recovered = recoveredService.getGoal(goal.id);

    assert.equal(recoveredService.stateRecovery?.source, 'backup');
    assert.ok(recoveredService.stateRecovery?.failures.some(item => item.path === firstService.stateFile));
    assert.equal(recovered.status, 'executing');
    assert.equal(recoveredService.getDirector('project-director-1').activeGoalId, goal.id);
    assert.ok(recoveredService.summary().activeGoals.some(item => item.id === goal.id));
  });
});
