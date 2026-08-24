import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectorService } from '../../lib/director-service.js';
import { normalizeGoalRecord } from '../../lib/goal-supervisor.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), 'director-policy-'));
  const runtime = {
    listTasks: async () => [],
    dispatch: async () => ({ json: { spawned: 0 } }),
    candidateSnapshot: async () => ({
      schema: 'candidate-snapshot.v1', revision: 'candidate-v1', digest: DIGEST, dirty: false,
    }),
  };
  return new DirectorService({
    runtime,
    stateFile: join(dir, 'directors.json'),
    projectsRoot: 'C:\\projects',
    getProjects: () => [{ id: 'alpha', name: 'Alpha', path: 'C:\\projects\\alpha' }],
  });
}

function seedGoal(svc, overrides = {}) {
  const createdAt = '2026-08-25T00:00:00.000Z';
  const goal = normalizeGoalRecord({
    id: `goal-${Math.random()}`,
    directorId: 'project-director-1',
    projectId: 'alpha',
    objective: 'Publish the verified release',
    status: 'evaluating',
    phase: 'assessing_evidence',
    workflowId: 'release',
    analysis: { recommendedWorkflow: 'release' },
    successCriteria: ['release is externally published'],
    taskIds: ['t_release_review', 't_gate'],
    currentWaveTaskIds: ['t_release_review', 't_gate'],
    taskRecords: [
      { taskId: 't_release_review', profile: 'release-reviewer', status: 'done', waveIndex: 1, completedAt: createdAt },
      { taskId: 't_gate', profile: 'quality-gate-reviewer', status: 'done', waveIndex: 1, completedAt: createdAt },
    ],
    waves: [{
      id: 'wave-1', index: 1, kind: 'verification', status: 'completed',
      taskIds: ['t_release_review', 't_gate'], startedAt: createdAt, completedAt: createdAt,
    }],
    publicDecisions: [],
    evidence: [],
    events: [],
    currentCandidate: { revision: 'candidate-v1', digest: DIGEST },
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
  svc.state.goals.push(goal);
  svc.getDirector('project-director-1').activeGoalId = goal.id;
  return goal;
}

function passingGateAudit() {
  return {
    workflowId: 'release',
    satisfied: true,
    missingProfiles: [],
    staleProfiles: [],
    rejectedProfiles: [],
    creditedTaskIds: { 'release-reviewer': 't_release_review', 'quality-gate-reviewer': 't_gate' },
    approvedGateTaskId: 't_gate',
    gateConsistency: { satisfied: true, reasons: [] },
    hostReceipts: { required: true, satisfied: true },
    hostCandidate: { revision: 'candidate-v1', digest: DIGEST },
    acceptance: { satisfied: true, missingCriteria: [], criteria: [{ criterion: 'release is externally published', met: true }] },
  };
}

describe('Director completion and blocker invariants', () => {
  it('does not convert release readiness approval into fictitious external execution', async () => {
    const svc = makeService();
    const goal = seedGoal(svc);
    const run = { id: 'run-release', workflowId: null, output: '', taskIds: [] };
    const plan = {
      mode: 'delegate', workflowId: 'release', state: 'complete', requirements: [],
      decisions: ['The candidate is ready.'], actions: [], ownerDecision: { required: false },
    };

    await assert.rejects(
      svc._applyGoalControl({
        director: svc.getDirector('project-director-1'), goal, run, plan,
        publicOutput: 'Release complete.', gateAudit: passingGateAudit(),
      }),
      /no completed Owner-approved external_mutation action/i,
    );
    assert.notEqual(goal.status, 'completed');
    assert.equal(goal.pendingAuthorityPlan, null);
  });

  it('parks an evidence-free blocker for Owner review instead of terminalizing it', async () => {
    const svc = makeService();
    const goal = seedGoal(svc, {
      objective: 'Diagnose the build', workflowId: 'quick-fix', analysis: { recommendedWorkflow: 'quick-fix' },
      taskIds: ['t_unreadable'], currentWaveTaskIds: ['t_unreadable'],
      taskRecords: [{
        taskId: 't_unreadable', profile: 'codex-implementer', status: 'done', waveIndex: 1,
        completedAt: '2026-08-25T00:01:00.000Z', summary: 'Evidence read failed: board offline', hostReceipt: null,
      }],
      waves: [{
        id: 'wave-unreadable', index: 1, kind: 'implementation', status: 'completed',
        taskIds: ['t_unreadable'], startedAt: '2026-08-25T00:00:00.000Z', completedAt: '2026-08-25T00:01:00.000Z',
      }],
      currentCandidate: null,
    });
    const run = { id: 'run-blocked', workflowId: null, output: '', taskIds: [] };
    const outcome = await svc._applyGoalControl({
      director: svc.getDirector('project-director-1'), goal, run,
      plan: {
        mode: 'delegate', workflowId: 'quick-fix', state: 'blocked', requirements: [],
        decisions: ['The environment may be unavailable.'], actions: [], ownerDecision: { required: false },
      },
      publicOutput: 'Cannot continue.',
    });

    assert.equal(outcome.state, 'awaiting_owner');
    assert.equal(goal.status, 'awaiting_owner');
    assert.equal(goal.ownerDecision.kind, 'unverified_blocker');
    assert.equal(goal.completedAt, null);
  });
});
