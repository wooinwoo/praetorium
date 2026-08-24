import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WORKFLOW_POLICIES,
  evaluateWorkflowGates,
  isStructuredEvidenceApproved,
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
});

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
