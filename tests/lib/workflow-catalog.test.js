import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  WORKFLOW_POLICIES,
  evaluateWorkflowGates,
  isStructuredEvidenceApproved,
  requiredWorkflowStage,
  workflowPolicyById,
} from '../../lib/workflow-catalog.js';
import { compactReport } from '../../lib/goal-supervisor.js';

const DIGEST_V1 = 'sha256:candidate-v1';
const DIGEST_V2 = 'sha256:candidate-v2';
const QUICK_REVIEW_PROFILES = [
  'convention-reviewer',
  'test-gap-reviewer',
  'adversarial-reviewer',
];
const REVIEW_KIND = Object.freeze({
  'convention-reviewer': 'convention',
  'test-gap-reviewer': 'test-gap',
  'adversarial-reviewer': 'adversarial',
  'security-reviewer': 'security',
});

function sha256Json(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')}`;
}

function observedReceipt(item, candidateDigest = DIGEST_V1) {
  const creditedEvidence = {
    taskId: String(item.taskId || ''),
    profile: String(item.profile || '').trim(),
    status: String(item.status || ''),
    completedAt: item.completedAt || null,
    waveIndex: item.waveIndex !== null && item.waveIndex !== undefined && item.waveIndex !== ''
      && Number.isFinite(Number(item.waveIndex)) ? Number(item.waveIndex) : null,
    report: item.report || null,
    summary: String(item.summary || ''),
  };
  const emptyHash = sha256Json(null);
  return {
    schema: 'hermes-board-observation.v1',
    source: 'praetorium-host',
    observedAt: '2026-08-24T00:10:00.000Z',
    observationSucceeded: true,
    taskId: item.taskId,
    status: item.status,
    candidateDigest,
    taskLogObserved: true,
    executionAttested: false,
    hashes: {
      task: emptyHash,
      validation: emptyHash,
      summary: emptyHash,
      comments: emptyHash,
      events: emptyHash,
      runs: emptyHash,
      log: sha256Json('worker task log'),
      creditedEvidence: sha256Json(creditedEvidence),
    },
    counts: { comments: 1, events: 2, runs: 1 },
  };
}

function writeEvidence({
  taskId = 'task-write-v1', profile = 'codex-implementer', waveIndex = 1,
  status = 'done', completedAt = '2026-08-24T00:01:00.000Z',
} = {}) {
  return { taskId, profile, waveIndex, status, completedAt, report: null };
}

function reviewEvidence(profile, {
  taskId = `task-${profile}`,
  digest = DIGEST_V1,
  waveIndex = 2,
  status = 'done',
  completedAt = '2026-08-24T00:02:00.000Z',
  verdict = 'pass',
} = {}) {
  const reviewKind = REVIEW_KIND[profile];
  return {
    taskId,
    profile,
    waveIndex,
    status,
    completedAt,
    report: {
      schema: 'review.v1',
      review_kind: reviewKind,
      scope: {
        project: 'praetorium',
        objective: 'ship the candidate safely',
        base_revision: 'base-revision',
        head_revision: null,
        artifact_digest: digest,
        paths: ['lib/'],
      },
      verdict,
      summary: `${reviewKind} review passed`,
      checks: [{ id: `${reviewKind}-contract`, status: 'pass', evidence: ['node --test passed'] }],
      findings: [],
      coverage: { examined: ['lib/'], omitted: [], limitations: [], assumptions: [] },
    },
  };
}

function gateEvidence({
  taskId = 'task-quality-gate',
  digest = DIGEST_V1,
  waveIndex = 3,
  status = 'done',
  completedAt = '2026-08-24T00:03:00.000Z',
  reports = QUICK_REVIEW_PROFILES.map(profile => ({
    review_kind: REVIEW_KIND[profile], status: 'current', verdict: 'pass',
  })),
  acceptance = [{ criterion: 'the candidate is verified', status: 'met', evidence: ['npm test passed'] }],
  blockers = [],
} = {}) {
  return {
    taskId,
    profile: 'quality-gate-reviewer',
    waveIndex,
    status,
    completedAt,
    report: {
      schema: 'quality-gate.v1',
      candidate: { revision: null, artifact_digest: digest },
      decision: 'advance',
      acceptance,
      reports,
      blockers,
      residual_risk: [],
      next_action: 'advance the verified candidate',
    },
  };
}

function validQuickFixEvidence({ digest = DIGEST_V1 } = {}) {
  return [
    writeEvidence(),
    ...QUICK_REVIEW_PROFILES.map(profile => reviewEvidence(profile, { digest })),
    gateEvidence({ digest }),
  ];
}

function auditQuickFix(evidence, digest = DIGEST_V1) {
  return evaluateWorkflowGates('quick-fix', evidence, { expectedCandidate: { digest } });
}

describe('workflow gate policy', () => {
  it('derives an enforceable candidate → review → remediation/gate → complete sequence', () => {
    assert.deepEqual(requiredWorkflowStage('quick-fix', []).stage, 'candidate');

    const candidate = [writeEvidence()];
    const reviewStage = requiredWorkflowStage('quick-fix', candidate);
    assert.equal(reviewStage.stage, 'review');
    assert.deepEqual(new Set(reviewStage.missingReviewProfiles), new Set(QUICK_REVIEW_PROFILES));

    const reviewed = [
      ...candidate,
      ...QUICK_REVIEW_PROFILES.map(profile => reviewEvidence(profile)),
    ];
    assert.equal(requiredWorkflowStage('quick-fix', reviewed).stage, 'gate');
    assert.equal(requiredWorkflowStage('quick-fix', validQuickFixEvidence()).stage, 'complete');

    const blocked = reviewEvidence('adversarial-reviewer');
    blocked.report.verdict = 'fail';
    blocked.report.checks = [{ id: 'counterexample', status: 'fail', evidence: ['reproduced'] }];
    blocked.report.findings = [{
      id: 'ADV-001', severity: 'high', confidence: 'high', category: 'correctness',
      title: 'Counterexample', claim: 'The claimed behavior fails.',
      evidence: [{ path: 'src/example.js', line: 1, detail: 'reproduction' }],
      impact: 'Acceptance is not met', required_action: 'Fix the behavior',
      verification: 'Rerun the reproduction', blocking: true,
    }];
    const remediation = requiredWorkflowStage('quick-fix', [
      ...candidate,
      ...QUICK_REVIEW_PROFILES.filter(profile => profile !== 'adversarial-reviewer')
        .map(profile => reviewEvidence(profile)),
      blocked,
    ]);
    assert.equal(remediation.stage, 'remediation');
    assert.deepEqual(remediation.allowedProfiles, ['remediator']);
  });

  it('publishes the exact required quick-fix profiles and accepts a complete current report set', () => {
    assert.deepEqual(workflowPolicyById('quick-fix'), WORKFLOW_POLICIES['quick-fix']);
    assert.deepEqual(WORKFLOW_POLICIES['quick-fix'].requiredProfiles, [
      'codex-implementer',
      'convention-reviewer',
      'test-gap-reviewer',
      'adversarial-reviewer',
      'quality-gate-reviewer',
    ]);

    const audit = auditQuickFix(validQuickFixEvidence());
    assert.equal(audit.satisfied, true);
    assert.deepEqual(audit.missingProfiles, []);
    assert.deepEqual(audit.rejectedProfiles, []);
    assert.equal(audit.approvedGateTaskId, 'task-quality-gate');
    assert.equal(audit.gateConsistency.satisfied, true);
  });

  it('credits a warn review when every finding is explicitly non-blocking', () => {
    const evidence = validQuickFixEvidence();
    const review = evidence.find(item => item.profile === 'test-gap-reviewer');
    review.report.verdict = 'warn';
    review.report.checks.push({
      id: 'durable-boundary-coverage',
      status: 'fail',
      evidence: ['The current candidate passes a read-only probe, but the case is not retained in the committed suite.'],
    });
    review.report.findings.push({
      id: 'TG-001',
      severity: 'low',
      confidence: 'high',
      category: 'regression-coverage',
      title: 'A boundary lacks a durable regression test',
      claim: 'A future change could regress without failing the committed suite.',
      evidence: [{ path: 'test/example.test.js', line: 10, detail: 'No direct boundary assertion.' }],
      impact: 'Future regression detection is weaker.',
      required_action: 'Add the direct assertion when test changes are allowed.',
      verification: 'Run the new assertion and the complete suite.',
      blocking: false,
    });
    evidence.find(item => item.profile === 'quality-gate-reviewer')
      .report.reports.find(row => row.review_kind === 'test-gap').verdict = 'warn';

    assert.equal(isStructuredEvidenceApproved(review), true);
    const audit = auditQuickFix(evidence);
    assert.equal(audit.satisfied, true);
    assert.deepEqual(audit.blockingTaskIds, []);
  });

  it('requires the assigned profile and its exact review_kind', () => {
    const missingProfile = structuredClone(validQuickFixEvidence());
    missingProfile.find(item => item.taskId === 'task-convention-reviewer').profile = '';
    const missingAudit = auditQuickFix(missingProfile);
    assert.ok(missingAudit.missingProfiles.includes('convention-reviewer'));
    assert.ok(missingAudit.missingProfiles.includes('quality-gate-reviewer'));
    assert.equal(missingAudit.satisfied, false);

    const wrongKind = structuredClone(validQuickFixEvidence());
    wrongKind.find(item => item.taskId === 'task-convention-reviewer').report.review_kind = 'security';
    const kindAudit = auditQuickFix(wrongKind);
    assert.ok(kindAudit.rejectedProfiles.includes('convention-reviewer'));
    assert.ok(kindAudit.missingProfiles.includes('convention-reviewer'));
    assert.ok(kindAudit.missingProfiles.includes('quality-gate-reviewer'));
    assert.equal(kindAudit.satisfied, false);
  });

  it('rejects malformed or blocking review.v1 reports', () => {
    const mutations = [
      report => { delete report.checks; },
      report => { delete report.findings; },
      report => { delete report.coverage; },
      report => { report.summary = '   '; },
      report => {
        report.verdict = 'warn';
        report.findings = [{ id: 'blocking-finding', blocking: true }];
      },
    ];

    for (const mutate of mutations) {
      const evidence = structuredClone(validQuickFixEvidence());
      mutate(evidence.find(item => item.taskId === 'task-adversarial-reviewer').report);
      const audit = auditQuickFix(evidence);
      assert.equal(audit.satisfied, false);
      assert.ok(audit.rejectedProfiles.includes('adversarial-reviewer'));
      assert.ok(audit.missingProfiles.includes('adversarial-reviewer'));
    }
  });

  it('binds every credited review and gate to the exact host candidate digest', () => {
    const mixedCandidate = structuredClone(validQuickFixEvidence());
    mixedCandidate.find(item => item.taskId === 'task-adversarial-reviewer').report.scope.artifact_digest = DIGEST_V2;
    const mixedAudit = auditQuickFix(mixedCandidate);
    assert.equal(mixedAudit.satisfied, false);
    assert.ok(mixedAudit.gateConsistency.reasons.includes('candidate-mismatch'));
    assert.ok(mixedAudit.gateConsistency.reasons.includes('host-review-digest-mismatch:adversarial-reviewer'));

    const wrongHostAudit = auditQuickFix(validQuickFixEvidence(), DIGEST_V2);
    assert.equal(wrongHostAudit.satisfied, false);
    assert.ok(wrongHostAudit.gateConsistency.reasons.includes('host-gate-digest-mismatch'));
    for (const profile of QUICK_REVIEW_PROFILES) {
      assert.ok(wrongHostAudit.gateConsistency.reasons.includes(`host-review-digest-mismatch:${profile}`));
    }

    const revisionOnly = structuredClone(validQuickFixEvidence());
    for (const item of revisionOnly.filter(entry => QUICK_REVIEW_PROFILES.includes(entry.profile))) {
      item.report.scope.head_revision = DIGEST_V1;
      item.report.scope.artifact_digest = null;
    }
    revisionOnly.find(item => item.profile === 'quality-gate-reviewer').report.candidate = {
      revision: DIGEST_V1, artifact_digest: null,
    };
    const revisionOnlyAudit = auditQuickFix(revisionOnly);
    assert.equal(revisionOnlyAudit.satisfied, false);
    assert.ok(revisionOnlyAudit.gateConsistency.reasons.includes('host-gate-digest-mismatch'));
  });

  it('requires host-observation receipts when the supervisor asks for provenance', () => {
    const evidence = validQuickFixEvidence();
    const missing = evaluateWorkflowGates('quick-fix', evidence, {
      expectedCandidate: { digest: DIGEST_V1 }, requireHostReceipts: true,
    });
    assert.equal(missing.satisfied, false);
    assert.equal(missing.hostReceipts.satisfied, false);
    assert.equal(missing.hostReceipts.missingTaskIds.length, evidence.length);

    for (const item of evidence) item.hostReceipt = observedReceipt(item);
    const observed = evaluateWorkflowGates('quick-fix', evidence, {
      expectedCandidate: { digest: DIGEST_V1 }, requireHostReceipts: true,
    });
    assert.equal(observed.satisfied, true);
    assert.equal(observed.hostReceipts.satisfied, true);
    assert.equal(observed.hostReceipts.executionAttested, false);

    const logless = validQuickFixEvidence().map(item => ({
      ...item,
      hostReceipt: {
        ...observedReceipt(item),
        taskLogObserved: false,
        hashes: { ...observedReceipt(item).hashes, log: null },
        counts: { comments: 0, events: 0, runs: 0 },
      },
    }));
    const loglessAudit = evaluateWorkflowGates('quick-fix', logless, {
      expectedCandidate: { digest: DIGEST_V1 }, requireHostReceipts: true,
    });
    assert.equal(loglessAudit.satisfied, false);
    assert.equal(loglessAudit.hostReceipts.missingTaskIds.length, logless.length);

    evidence[0].report = { forged: true };
    const tampered = evaluateWorkflowGates('quick-fix', evidence, {
      expectedCandidate: { digest: DIGEST_V1 }, requireHostReceipts: true,
    });
    assert.equal(tampered.satisfied, false);
    assert.ok(tampered.hostReceipts.missingTaskIds.includes(evidence[0].taskId));

    const extraHistorical = writeEvidence({ taskId: 'old-write', waveIndex: 0, completedAt: '2026-08-23T00:00:00.000Z' });
    const withUnobservedHistory = evaluateWorkflowGates('quick-fix', [extraHistorical, ...validQuickFixEvidence().map(item => ({
      ...item, hostReceipt: observedReceipt(item),
    }))], {
      expectedCandidate: { digest: DIGEST_V1 }, requireHostReceipts: true,
    });
    assert.equal(withUnobservedHistory.satisfied, true);
    assert.equal(withUnobservedHistory.hostReceipts.satisfied, true);
  });

  it('blocks on every current materialized review even when the workflow did not require that profile', () => {
    const failedSecurity = reviewEvidence('security-reviewer', { taskId: 'task-security-current' });
    failedSecurity.report.verdict = 'fail';
    failedSecurity.report.summary = 'Authentication bypass is reproducible.';
    failedSecurity.report.checks = [{ id: 'auth-bypass', status: 'fail', evidence: ['request returned 200'] }];
    failedSecurity.report.findings = [{
      id: 'auth-bypass', severity: 'critical', confidence: 'high', category: 'authentication',
      title: 'Authentication bypass', claim: 'A protected route is public.',
      evidence: [{ path: 'src/auth.js', line: 10, detail: 'guard is skipped' }],
      impact: 'Unauthorized access', required_action: 'Restore the guard',
      verification: 'The unauthenticated request must return 401', blocking: true,
    }];
    const failed = auditQuickFix([...validQuickFixEvidence(), failedSecurity]);
    assert.equal(failed.satisfied, false);
    assert.ok(failed.rejectedProfiles.includes('security-reviewer'));
    assert.ok(failed.blockingTaskIds.includes('task-security-current'));

    const untrustedSecurity = reviewEvidence('security-reviewer', { taskId: 'task-security-untrusted' });
    untrustedSecurity.report.scope.artifact_digest = DIGEST_V2;
    const untrusted = auditQuickFix([...validQuickFixEvidence(), untrustedSecurity]);
    assert.equal(untrusted.satisfied, false);
    assert.ok(untrusted.blockingTaskIds.includes('task-security-untrusted'));

    const passedSecurity = reviewEvidence('security-reviewer', { taskId: 'task-security-pass' });
    const gateWithSecurity = gateEvidence({ reports: [
      ...QUICK_REVIEW_PROFILES.map(profile => ({
        review_kind: REVIEW_KIND[profile], status: 'current', verdict: 'pass',
      })),
      { review_kind: 'security', status: 'current', verdict: 'pass' },
    ] });
    const passed = auditQuickFix([
      ...validQuickFixEvidence().filter(item => item.profile !== 'quality-gate-reviewer'),
      passedSecurity,
      gateWithSecurity,
    ]);
    assert.equal(passed.satisfied, true);
    assert.equal(passed.creditedTaskIds['security-reviewer'], 'task-security-pass');
  });

  it('requires provenance for supplemental current reviews and ignores stale pre-write failures', () => {
    const evidence = validQuickFixEvidence().map(item => ({ ...item, hostReceipt: observedReceipt(item) }));
    const supplemental = reviewEvidence('security-reviewer', { taskId: 'task-security-current' });
    const missingReceipt = evaluateWorkflowGates('quick-fix', [...evidence, supplemental], {
      expectedCandidate: { digest: DIGEST_V1 }, requireHostReceipts: true,
    });
    assert.equal(missingReceipt.satisfied, false);
    assert.ok(missingReceipt.hostReceipts.missingTaskIds.includes('task-security-current'));
    assert.ok(missingReceipt.blockingTaskIds.includes('task-security-current'));

    const staleFailure = reviewEvidence('security-reviewer', {
      taskId: 'task-security-stale', waveIndex: 0, completedAt: '2026-08-23T00:00:00.000Z',
    });
    staleFailure.report.verdict = 'fail';
    const currentOnly = evaluateWorkflowGates('quick-fix', [staleFailure, ...evidence], {
      expectedCandidate: { digest: DIGEST_V1 }, requireHostReceipts: true,
    });
    assert.equal(currentOnly.satisfied, true);
    assert.ok(!currentOnly.blockingTaskIds.includes('task-security-stale'));
  });

  it('invalidates pre-remediation reviews and accepts only fresh reports for the new candidate', () => {
    const staleEvidence = [
      ...validQuickFixEvidence(),
      writeEvidence({
        taskId: 'task-remediation-v2', profile: 'remediator', waveIndex: 4,
        completedAt: '2026-08-24T00:04:00.000Z',
      }),
      gateEvidence({
        taskId: 'task-quality-gate-v2', digest: DIGEST_V2, waveIndex: 5,
        completedAt: '2026-08-24T00:05:00.000Z',
      }),
    ];
    const staleAudit = auditQuickFix(staleEvidence, DIGEST_V2);
    assert.equal(staleAudit.satisfied, false);
    assert.equal(staleAudit.latestWriteTaskId, 'task-remediation-v2');
    assert.deepEqual(new Set(staleAudit.staleProfiles), new Set(QUICK_REVIEW_PROFILES));
    for (const profile of QUICK_REVIEW_PROFILES) assert.ok(staleAudit.missingProfiles.includes(profile));

    const freshEvidence = [
      ...staleEvidence,
      ...QUICK_REVIEW_PROFILES.map(profile => reviewEvidence(profile, {
        taskId: `task-${profile}-v2`, digest: DIGEST_V2, waveIndex: 5,
        completedAt: '2026-08-24T00:05:30.000Z',
      })),
      gateEvidence({
        taskId: 'task-quality-gate-v2-fresh', digest: DIGEST_V2, waveIndex: 6,
        completedAt: '2026-08-24T00:06:00.000Z',
      }),
    ];
    const freshAudit = auditQuickFix(freshEvidence, DIGEST_V2);
    assert.equal(freshAudit.satisfied, true);
    assert.equal(freshAudit.approvedGateTaskId, 'task-quality-gate-v2-fresh');
    for (const profile of QUICK_REVIEW_PROFILES) {
      assert.equal(freshAudit.creditedTaskIds[profile], `task-${profile}-v2`);
    }
  });

  it('requires an explicit empty blockers array for an advancing quality-gate.v1', () => {
    const missingBlockers = structuredClone(validQuickFixEvidence());
    delete missingBlockers.find(item => item.profile === 'quality-gate-reviewer').report.blockers;
    const missingAudit = auditQuickFix(missingBlockers);
    assert.equal(missingAudit.satisfied, false);
    assert.ok(missingAudit.rejectedProfiles.includes('quality-gate-reviewer'));

    const blocking = structuredClone(validQuickFixEvidence());
    blocking.find(item => item.profile === 'quality-gate-reviewer').report.blockers = ['finding-1'];
    const blockingAudit = auditQuickFix(blocking);
    assert.equal(blockingAudit.satisfied, false);
    assert.ok(blockingAudit.rejectedProfiles.includes('quality-gate-reviewer'));
  });

  it('requires structured acceptance and an exact current report row for every required review', () => {
    const malformedGates = [
      report => { delete report.acceptance; },
      report => { report.acceptance = []; },
      report => { report.acceptance[0].evidence = []; },
      report => { delete report.reports; },
      report => { delete report.residual_risk; },
      report => { report.next_action = '   '; },
      report => { report.reports = report.reports.filter(row => row.review_kind !== 'test-gap'); },
      report => { report.reports.find(row => row.review_kind === 'adversarial').verdict = 'warn'; },
    ];

    for (const mutate of malformedGates) {
      const evidence = structuredClone(validQuickFixEvidence());
      mutate(evidence.find(item => item.profile === 'quality-gate-reviewer').report);
      const audit = auditQuickFix(evidence);
      assert.equal(audit.satisfied, false);
      assert.ok(audit.missingProfiles.includes('quality-gate-reviewer'));
    }
  });

  it('does not count archived evidence as successful completion', () => {
    const archived = validQuickFixEvidence().map(item => ({ ...item, status: 'archived' }));
    const audit = auditQuickFix(archived);
    assert.equal(audit.satisfied, false);
    assert.deepEqual(audit.completedProfiles, []);
    assert.deepEqual(new Set(audit.missingProfiles), new Set(WORKFLOW_POLICIES['quick-fix'].requiredProfiles));
    assert.equal(audit.latestWriteTaskId, null);
    assert.equal(audit.approvedGateTaskId, null);
  });

  it('does not launder a truncated raw failure through persisted compact evidence', () => {
    const rawReview = reviewEvidence('convention-reviewer');
    rawReview.report.checks = Array.from({ length: 41 }, (_, index) => ({
      id: `check-${index + 1}`,
      status: index === 40 ? 'fail' : 'pass',
      evidence: [`evidence-${index + 1}`],
    }));
    assert.equal(isStructuredEvidenceApproved(rawReview), false);
    const persistedReview = {
      ...rawReview,
      report: compactReport(rawReview.report),
      persistedReportApproved: false,
    };
    assert.equal(persistedReview.report.checks.length, 40, 'the persistence shape is bounded');
    const evidence = validQuickFixEvidence();
    evidence[evidence.findIndex(item => item.profile === 'convention-reviewer')] = persistedReview;
    assert.equal(auditQuickFix(evidence).satisfied, false);

    const rawGate = gateEvidence();
    rawGate.report.reports.push(...Array.from({ length: 13 }, (_, index) => ({
      review_kind: `supplemental-${index}`, status: 'current', verdict: 'pass',
    })));
    rawGate.report.reports.push({ review_kind: 'hidden-invalid', status: 'stale', verdict: 'fail' });
    assert.equal(isStructuredEvidenceApproved(rawGate), false);
    const persistedGate = {
      ...rawGate,
      report: compactReport(rawGate.report),
      persistedReportApproved: false,
    };
    assert.equal(persistedGate.report.reports.length, 16);
    const gateEvidenceSet = validQuickFixEvidence();
    gateEvidenceSet[gateEvidenceSet.findIndex(item => item.profile === 'quality-gate-reviewer')] = persistedGate;
    assert.equal(auditQuickFix(gateEvidenceSet).satisfied, false);
  });
});
