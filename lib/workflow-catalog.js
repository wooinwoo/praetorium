import { createHash } from 'node:crypto';

export const WORKER_PROFILES = Object.freeze({
  'codex-implementer': { label: '구현 워커', kind: 'write', reasoning: 'xhigh', skill: null, description: '경계가 정해진 코드 변경을 구현하고 테스트 근거와 정확한 인수인계를 남깁니다.' },
  'convention-reviewer': { label: '컨벤션 리뷰어', kind: 'review', reasoning: 'xhigh', skill: 'convention-review', description: '저장소 지침, 기존 패턴, 공개 인터페이스 규칙 위반을 읽기 전용으로 검토합니다.' },
  'security-reviewer': { label: '보안 리뷰어', kind: 'review', reasoning: 'xhigh', skill: 'security-review', description: '변경된 신뢰 경계의 악용 가능한 보안·개인정보 위험을 검토합니다.' },
  'adversarial-reviewer': { label: '적대적 검증 리뷰어', kind: 'review', reasoning: 'xhigh', skill: 'adversarial-review', description: '경계값과 실패 사례로 구현의 주장을 반증하려고 시도합니다.' },
  'test-gap-reviewer': { label: '테스트 갭 리뷰어', kind: 'review', reasoning: 'xhigh', skill: 'test-gap-review', description: '수용 기준과 변경 위험 경로에 빠진 회귀 근거를 찾습니다.' },
  'architecture-reviewer': { label: '아키텍처 리뷰어', kind: 'review', reasoning: 'xhigh', skill: 'architecture-review', description: '모듈 경계, 의존 방향, 공개 계약, 마이그레이션과 상태 수명을 검토합니다.' },
  'performance-reviewer': { label: '성능 리뷰어', kind: 'review', reasoning: 'xhigh', skill: 'performance-review', description: '지연, 처리량, 메모리, I/O, 동시성과 자원 제한 회귀를 검토합니다.' },
  'release-reviewer': { label: '릴리스 리뷰어', kind: 'review', reasoning: 'xhigh', skill: 'release-readiness', description: '현재 빌드, 테스트, 마이그레이션, 롤백과 운영 근거로 출시 준비도를 판단합니다.' },
  remediator: { label: '수정 워커', kind: 'write', reasoning: 'xhigh', skill: 'remediate-findings', description: '현재 리비전에 묶인 리뷰 지적만 수정하고 재검증 근거를 넘깁니다.' },
  'quality-gate-reviewer': { label: '품질 게이트', kind: 'gate', reasoning: 'xhigh', skill: 'quality-gate', description: '현재 후보 리비전의 근거만으로 진행 또는 중단을 판정합니다.' },
});

const DIRECTOR_PROFILES = [
  ['project-director-1', 'Project Director 1', '프로젝트 목표를 분해하고 격리된 Worker와 리뷰 흐름을 지휘합니다.'],
  ['project-director-2', 'Project Director 2', '두 번째 프로젝트의 목표와 Worker 풀을 독립적으로 지휘합니다.'],
  ['project-director-3', 'Project Director 3', '세 번째 프로젝트의 목표와 Worker 풀을 독립적으로 지휘합니다.'],
  ['skill-director', 'Skill Director', '반복된 행동 근거를 평가 가능한 스킬 제안과 통제된 활성화로 전환합니다.'],
];

export const PROFILE_CATALOG = Object.freeze([
  ...DIRECTOR_PROFILES.map(([id, label, description]) => ({
    id, label, description, group: 'director', kind: 'orchestrate', model: 'gpt-5.6-sol', reasoning: 'ultra', access: 'read-only', skill: id.startsWith('project-') ? 'project-director' : 'skill-director',
  })),
  ...Object.entries(WORKER_PROFILES).map(([id, profile]) => ({
    id, ...profile, group: profile.kind === 'write' ? 'worker' : 'review', model: 'gpt-5.6-sol', access: profile.kind === 'write' ? 'workspace-write' : 'read-only',
  })),
]);

export const PRAETORIUM_SKILLS = Object.freeze({
  'project-director': '요구를 분해하고 워커·리뷰·수정 루프를 지휘',
  'context-handoff': '새 세션이 이어받을 수 있는 근거 기반 인수인계',
  'convention-review': '저장소 규칙과 기존 패턴 위반 검토',
  'security-review': '신뢰 경계·권한·입력·비밀·민감정보 보안 검토',
  'adversarial-review': '경계값·실패·동시성·재시도로 구현 주장 반증',
  'test-gap-review': '수용 기준과 변경 경로의 회귀 테스트 공백 검토',
  'architecture-review': '모듈 경계·공개 계약·스키마·상태 수명 검토',
  'performance-review': '지연·처리량·메모리·I/O·동시성 회귀 검토',
  'remediate-findings': '리뷰 지적을 별도 워커가 수정하고 재검증 근거 생성',
  'release-readiness': '빌드·테스트·마이그레이션·롤백·운영 출시 준비 검토',
  'quality-gate': '현재 리비전의 근거로 진행 또는 중단 판정',
  'skill-director': '관찰→제안→평가→카나리→활성화로 스킬 수명주기 관리',
});

function freezePolicy({ write = [], review = [], gate = [], ...rest }) {
  const writeProfiles = Object.freeze([...write]);
  const reviewProfiles = Object.freeze([...review]);
  const gateProfiles = Object.freeze([...gate]);
  return Object.freeze({
    writeProfiles,
    reviewProfiles,
    gateProfiles,
    requiredProfiles: Object.freeze([...writeProfiles, ...reviewProfiles, ...gateProfiles]),
    revisionSensitiveProfiles: Object.freeze([...reviewProfiles, ...gateProfiles]),
    remediationProfile: 'remediator',
    maxRemediationLoops: 2,
    reviewAfterWrite: true,
    ...rest,
  });
}

export const WORKFLOW_POLICIES = Object.freeze({
  'quick-fix': freezePolicy({
    write: ['codex-implementer'],
    review: ['convention-reviewer', 'test-gap-reviewer', 'adversarial-reviewer'],
    gate: ['quality-gate-reviewer'],
  }),
  'standard-feature': freezePolicy({
    write: ['codex-implementer'],
    review: ['convention-reviewer', 'test-gap-reviewer', 'adversarial-reviewer'],
    gate: ['quality-gate-reviewer'],
  }),
  'high-risk-change': freezePolicy({
    write: ['codex-implementer'],
    review: [
      'security-reviewer', 'architecture-reviewer', 'performance-reviewer',
      'convention-reviewer', 'test-gap-reviewer', 'adversarial-reviewer',
      'release-reviewer',
    ],
    gate: ['quality-gate-reviewer'],
    ownerApprovalBeforeExternalAction: true,
  }),
  'research-planning': freezePolicy({
    write: ['codex-implementer'],
    review: ['adversarial-reviewer'],
    gate: ['quality-gate-reviewer'],
  }),
  release: freezePolicy({
    review: ['release-reviewer'],
    gate: ['quality-gate-reviewer'],
    ownerApprovalBeforeExternalAction: true,
  }),
  'skill-development': freezePolicy({
    write: ['codex-implementer'],
    review: ['adversarial-reviewer'],
    gate: ['quality-gate-reviewer'],
    ownerApprovalBeforeActivation: true,
  }),
});

export const WORKFLOWS = Object.freeze([
  {
    id: 'quick-fix',
    name: '빠른 수정',
    description: '작고 국소적인 결함을 고치고 핵심 회귀만 빠르게 검증합니다.',
    graph: [
      '범위 확인', '구현+테스트', '컨벤션·테스트갭·적대적 검증(병렬)',
      '지적 수정(최대 2회)', '영향 리뷰 재실행', '품질 게이트',
    ],
    policy: WORKFLOW_POLICIES['quick-fix'],
  },
  {
    id: 'standard-feature',
    name: '표준 기능 개발',
    description: '요구·설계·구현·다중 리뷰·수정 루프를 거치는 기본 개발 플로우입니다.',
    graph: [
      '요구 분석', '설계와 작업 분할', '충돌 방지 직렬 구현·통합', '테스트',
      '컨벤션·테스트갭·적대적 검증(병렬)', '지적 수정(최대 2회)',
      '영향 리뷰 재실행', '품질 게이트', 'Owner 결과 보고',
    ],
    policy: WORKFLOW_POLICIES['standard-feature'],
  },
  {
    id: 'high-risk-change',
    name: '고위험·보안 변경',
    description: '보안·공개 계약·데이터·동시성 위험이 있는 변경을 강하게 검증합니다.',
    graph: [
      '위험·신뢰경계 분석', '아키텍처 설계', '격리 구현', '테스트',
      '보안·아키텍처·성능·컨벤션·테스트갭·적대적 검증(병렬)',
      '지적 수정(최대 2회)', '전체 영향 리뷰 재실행', '릴리스 준비',
      '품질 게이트', 'Owner 승인',
    ],
    policy: WORKFLOW_POLICIES['high-risk-change'],
  },
  {
    id: 'research-planning',
    name: '조사·기획',
    description: '여러 조사 트랙을 병렬화하고 출처 교차검증 후 의사결정 문서를 만듭니다.',
    graph: [
      '질문·선정 기준 확정', '독립 조사 트랙(병렬)', '출처·시점 교차검증',
      '종합·우선순위화', '적대적 검증', '문서화', 'Owner 보고',
    ],
    policy: WORKFLOW_POLICIES['research-planning'],
  },
  {
    id: 'release',
    name: '릴리스',
    description: '고정 후보 리비전을 빌드·테스트·리뷰하고 출시 가능 여부를 판정합니다.',
    graph: [
      '후보 리비전 고정', '빌드·전체 테스트', '위험 기반 전문 리뷰(병렬)',
      '지적 수정·재검증', '릴리스 준비 검토', '품질 게이트',
      'Owner 외부 실행 승인', '태그·배포·검증',
    ],
    policy: WORKFLOW_POLICIES.release,
  },
  {
    id: 'skill-development',
    name: '스킬 개발',
    description: '반복 실패를 근거로 새 스킬을 만들고 평가·카나리·롤백 가능하게 활성화합니다.',
    graph: [
      '행동 증거 수집', '스킬/도구/정책 문제 분류', '스킬 제안', '구현',
      '정상·적대적 평가', '카나리 적용', 'Owner 활성화 승인', '관찰·롤백',
    ],
    policy: WORKFLOW_POLICIES['skill-development'],
  },
]);

export function workflowById(id) {
  return WORKFLOWS.find(workflow => workflow.id === id) || null;
}

export function workflowPolicyById(id) {
  return workflowById(id)?.policy || null;
}

function isCompletedStatus(status) {
  return ['done', 'completed', 'succeeded', 'success'].includes(String(status || '').toLowerCase());
}

function evidencePosition(item) {
  const wave = item?.waveIndex !== null && item?.waveIndex !== undefined && item?.waveIndex !== ''
    && Number.isFinite(Number(item.waveIndex)) ? Number(item.waveIndex) : null;
  const completed = Date.parse(item?.completedAt || '');
  return { wave, completed: Number.isFinite(completed) ? completed : null };
}

function compareEvidence(left, right) {
  const a = evidencePosition(left);
  const b = evidencePosition(right);
  if (a.wave !== null && b.wave !== null && a.wave !== b.wave) return a.wave - b.wave;
  if (a.completed !== null && b.completed !== null) return a.completed - b.completed;
  return null;
}

const REVIEW_KIND_BY_PROFILE = Object.freeze({
  'convention-reviewer': 'convention',
  'security-reviewer': 'security',
  'adversarial-reviewer': 'adversarial',
  'test-gap-reviewer': 'test-gap',
  'architecture-reviewer': 'architecture',
  'performance-reviewer': 'performance',
  'release-reviewer': 'release-readiness',
});

function nonblank(value) { return typeof value === 'string' && value.trim().length > 0; }
function nonblankEvidence(values) { return Array.isArray(values) && values.length > 0 && values.every(nonblank); }
function sha256Json(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')}`;
}

function receiptEvidenceShape(item = {}) {
  return {
    taskId: String(item.taskId || ''),
    profile: String(item.profile || '').trim(),
    status: String(item.status || ''),
    completedAt: item.completedAt || null,
    waveIndex: item.waveIndex !== null && item.waveIndex !== undefined && item.waveIndex !== ''
      && Number.isFinite(Number(item.waveIndex)) ? Number(item.waveIndex) : null,
    report: item.report || null,
    summary: String(item.summary || ''),
  };
}

function isSha256(value) { return /^sha256:[0-9a-f]{64}$/.test(String(value || '')); }

function reportCandidate(report) {
  if (report?.schema === 'review.v1') return report.scope?.artifact_digest || report.scope?.head_revision || null;
  if (report?.schema === 'quality-gate.v1') return report.candidate?.artifact_digest || report.candidate?.revision || null;
  return null;
}

function structuredEvidenceApproved(item) {
  if (item.persistedReportApproved === false) return false;
  const kind = WORKER_PROFILES[item.profile]?.kind;
  if (kind === 'write') return true;
  const report = item.report;
  if (kind === 'review') {
    const verdict = String(report?.verdict || '').toLowerCase();
    const findings = Array.isArray(report?.findings) ? report.findings : null;
    return report?.schema === 'review.v1'
      && report.review_kind === REVIEW_KIND_BY_PROFILE[item.profile]
      && report.scope && typeof report.scope === 'object'
      && Boolean(reportCandidate(report))
      && Array.isArray(report.scope.paths)
      && ['pass', 'warn'].includes(verdict)
      && nonblank(report.summary)
      && Array.isArray(report.checks) && report.checks.length > 0
      && report.checks.every(check => nonblank(check?.id)
        && ['pass', 'not_applicable'].includes(check?.status)
        && (check.status === 'not_applicable' || nonblankEvidence(check.evidence)))
      && findings
      && findings.every(finding => nonblank(finding?.id)
        && ['critical', 'high', 'medium', 'low'].includes(finding?.severity)
        && ['high', 'medium', 'low'].includes(finding?.confidence)
        && nonblank(finding?.category) && nonblank(finding?.title) && nonblank(finding?.claim)
        && Array.isArray(finding?.evidence) && finding.evidence.length > 0
        && nonblank(finding?.impact) && nonblank(finding?.required_action) && nonblank(finding?.verification)
        && typeof finding?.blocking === 'boolean'
        && !(finding.severity === 'critical' && finding.blocking === false))
      && !findings.some(finding => finding.blocking)
      && (verdict !== 'pass' || findings.length === 0)
      && report.coverage && typeof report.coverage === 'object'
      && ['examined', 'omitted', 'limitations', 'assumptions'].every(key => Array.isArray(report.coverage[key]));
  }
  if (kind === 'gate') {
    return report?.schema === 'quality-gate.v1'
      && Boolean(reportCandidate(report))
      && report.decision === 'advance'
      && Array.isArray(report.blockers)
      && report.blockers.length === 0
      && Array.isArray(report.acceptance)
      && report.acceptance.length > 0
      && report.acceptance.every(criterion => nonblank(criterion?.criterion)
        && criterion?.status === 'met' && nonblankEvidence(criterion.evidence))
      && Array.isArray(report.reports)
      && report.reports.every(row => nonblank(row?.review_kind)
        && row.status === 'current' && ['pass', 'warn'].includes(row.verdict))
      && Array.isArray(report.residual_risk) && report.residual_risk.every(nonblank)
      && nonblank(report.next_action);
  }
  return false;
}

export function isStructuredEvidenceApproved(item) {
  return structuredEvidenceApproved(item);
}

export function evaluateWorkflowGates(id, taskEvidence = [], { expectedCandidate = null, requireHostReceipts = false } = {}) {
  const policy = workflowPolicyById(id);
  if (!policy) throw new Error(`Unknown workflow policy: ${id || '(none)'}`);
  const completed = (Array.isArray(taskEvidence) ? taskEvidence : [])
    .filter(item => item && isCompletedStatus(item.status))
    .map(item => ({
      taskId: String(item.taskId || ''),
      profile: String(item.profile || '').trim(),
      status: String(item.status || ''),
      completedAt: item.completedAt || null,
      waveIndex: item.waveIndex !== null && item.waveIndex !== undefined && item.waveIndex !== ''
        && Number.isFinite(Number(item.waveIndex)) ? Number(item.waveIndex) : null,
      summary: String(item.summary || ''),
      report: item.report || null,
      hostReceipt: item.hostReceipt || null,
      // Once a raw report has been compacted for durable storage, its original
      // validation result is the authority.  Re-validating only the bounded
      // prefix could otherwise hide a failure that was truncated from the
      // persisted shape.
      persistedReportApproved: item.persistedReportApproved === null
        || item.persistedReportApproved === undefined
        ? null
        : item.persistedReportApproved === true,
    }))
    .filter(item => item.profile);
  const completedProfiles = [...new Set(completed.map(item => item.profile))];
  const validHostReceipt = item => {
    const receipt = item.hostReceipt;
    const hashes = receipt?.hashes;
    return receipt?.schema === 'hermes-board-observation.v1'
      && receipt.source === 'praetorium-host'
      && Number.isFinite(Date.parse(receipt.observedAt || ''))
      && receipt.observationSucceeded === true
      && receipt.taskId === item.taskId
      && String(receipt.status || '').toLowerCase() === String(item.status || '').toLowerCase()
      && (!expectedCandidate?.digest || receipt.candidateDigest === expectedCandidate.digest)
      && typeof receipt.taskLogObserved === 'boolean'
      && receipt.executionAttested === false
      && hashes && ['task', 'validation', 'summary', 'comments', 'events', 'runs'].every(key => isSha256(hashes[key]))
      && (!receipt.taskLogObserved || isSha256(hashes.log))
      && hashes.creditedEvidence === sha256Json(receiptEvidenceShape(item))
      && receipt.counts && ['comments', 'events', 'runs'].every(key => Number.isInteger(receipt.counts[key]) && receipt.counts[key] >= 0);
  };
  const approved = completed.filter(item => structuredEvidenceApproved(item)
    && (!requireHostReceipts || validHostReceipt(item)));
  const approvedProfiles = [...new Set(approved.map(item => item.profile))];
  const rejectedProfiles = [...new Set(completed
    .filter(item => !structuredEvidenceApproved(item))
    .map(item => item.profile))];
  const writeEvidence = completed.filter(item => WORKER_PROFILES[item.profile]?.kind === 'write');
  const latestWrite = writeEvidence.reduce((latest, item) => {
    if (!latest) return item;
    const comparison = compareEvidence(item, latest);
    return comparison === null || comparison > 0 ? item : latest;
  }, null);
  const receiptCandidates = policy.requiredProfiles.map(profile => {
    let matching = completed.filter(item => item.profile === profile && structuredEvidenceApproved(item));
    if (latestWrite && policy.revisionSensitiveProfiles.includes(profile)) {
      matching = matching.filter(item => {
        const comparison = compareEvidence(item, latestWrite);
        return comparison !== null && comparison > 0;
      });
    }
    return matching.reduce((latest, item) => {
      if (!latest) return item;
      const comparison = compareEvidence(item, latest);
      return comparison === null || comparison > 0 ? item : latest;
    }, null);
  }).filter(Boolean);
  const missingReceiptTaskIds = requireHostReceipts
    ? receiptCandidates.filter(item => !validHostReceipt(item)).map(item => item.taskId)
    : [];
  const staleProfiles = [];
  const creditedTaskIds = {};
  const missingProfiles = policy.requiredProfiles.filter(profile => {
    const matching = approved.filter(item => item.profile === profile);
    if (!matching.length) return true;
    if (!latestWrite || !policy.revisionSensitiveProfiles.includes(profile)) {
      creditedTaskIds[profile] = matching.reduce((latest, item) => {
        if (!latest) return item;
        const comparison = compareEvidence(item, latest);
        return comparison === null || comparison > 0 ? item : latest;
      }, null)?.taskId || null;
      return false;
    }
    const freshEvidence = matching.filter(item => {
      const comparison = compareEvidence(item, latestWrite);
      return comparison !== null && comparison > 0;
    });
    if (!freshEvidence.length) staleProfiles.push(profile);
    else creditedTaskIds[profile] = freshEvidence.reduce((latest, item) => {
      if (!latest) return item;
      const comparison = compareEvidence(item, latest);
      return comparison === null || comparison > 0 ? item : latest;
    }, null)?.taskId || null;
    return !freshEvidence.length;
  });
  if (requireHostReceipts) {
    for (const item of receiptCandidates.filter(candidate => !validHostReceipt(candidate))) {
      delete creditedTaskIds[item.profile];
      if (!missingProfiles.includes(item.profile)) missingProfiles.push(item.profile);
    }
  }
  const gateTaskId = creditedTaskIds['quality-gate-reviewer'] || null;
  const gateEvidence = completed.find(item => item.taskId === gateTaskId) || null;
  const creditedReviews = policy.reviewProfiles
    .map(profile => ({ profile, evidence: completed.find(item => item.taskId === creditedTaskIds[profile]) || null }))
    .filter(item => item.evidence);
  const reviewCandidates = [...new Set(creditedReviews.map(item => reportCandidate(item.evidence.report)).filter(Boolean))];
  const gateCandidate = reportCandidate(gateEvidence?.report);
  const gateReportRows = Array.isArray(gateEvidence?.report?.reports) ? gateEvidence.report.reports : [];
  const gateConsistencyReasons = [];
  if (gateEvidence) {
    if (creditedReviews.length !== policy.reviewProfiles.length) gateConsistencyReasons.push('required-review-missing');
    if (reviewCandidates.length !== 1 || gateCandidate !== reviewCandidates[0]) gateConsistencyReasons.push('candidate-mismatch');
    if (expectedCandidate?.digest) {
      if (gateEvidence.report?.candidate?.artifact_digest !== expectedCandidate.digest) gateConsistencyReasons.push('host-gate-digest-mismatch');
      for (const { profile, evidence: reviewEvidence } of creditedReviews) {
        if (reviewEvidence.report?.scope?.artifact_digest !== expectedCandidate.digest) {
          gateConsistencyReasons.push(`host-review-digest-mismatch:${profile}`);
        }
      }
    }
    for (const { profile, evidence: reviewEvidence } of creditedReviews) {
      const expectedKind = REVIEW_KIND_BY_PROFILE[profile];
      const row = gateReportRows.find(item => item?.review_kind === expectedKind);
      if (!row || row.status !== 'current' || row.verdict !== reviewEvidence.report.verdict) {
        gateConsistencyReasons.push(`report-mismatch:${expectedKind}`);
      }
    }
  }
  if (gateEvidence && gateConsistencyReasons.length) {
    delete creditedTaskIds['quality-gate-reviewer'];
    if (!missingProfiles.includes('quality-gate-reviewer')) missingProfiles.push('quality-gate-reviewer');
    if (!rejectedProfiles.includes('quality-gate-reviewer')) rejectedProfiles.push('quality-gate-reviewer');
  }
  const finalApprovedProfiles = approvedProfiles.filter(profile => !missingProfiles.includes(profile));
  const approvedGateTaskId = creditedTaskIds['quality-gate-reviewer'] || null;
  return {
    workflowId: id,
    satisfied: missingProfiles.length === 0,
    requiredProfiles: [...policy.requiredProfiles],
    completedProfiles,
    approvedProfiles: finalApprovedProfiles,
    rejectedProfiles,
    missingProfiles,
    missingWriteProfiles: policy.writeProfiles.filter(profile => missingProfiles.includes(profile)),
    missingReviewProfiles: policy.reviewProfiles.filter(profile => missingProfiles.includes(profile)),
    missingGateProfiles: policy.gateProfiles.filter(profile => missingProfiles.includes(profile)),
    staleProfiles,
    latestWriteTaskId: latestWrite?.taskId || null,
    creditedTaskIds,
    approvedGateTaskId,
    gateConsistency: { satisfied: gateConsistencyReasons.length === 0 && Boolean(approvedGateTaskId), reasons: gateConsistencyReasons },
    hostReceipts: {
      required: requireHostReceipts,
      satisfied: !requireHostReceipts || missingReceiptTaskIds.length === 0,
      observedTaskIds: completed.filter(validHostReceipt).map(item => item.taskId),
      missingTaskIds: missingReceiptTaskIds,
      executionAttested: false,
      limitation: 'Receipts attest to host-observed Hermes records and log bytes, not the truth of command-exit claims inside Worker-authored text.',
    },
  };
}

export function catalogPrompt() {
  const workflows = WORKFLOWS.map(item => (
    `- ${item.id}: ${item.name} — ${item.graph.join(' → ')} (필수 프로필: ${item.policy.requiredProfiles.join(', ')})`
  )).join('\n');
  const skills = Object.entries(PRAETORIUM_SKILLS).map(([name, description]) => `- ${name}: ${description}`).join('\n');
  const workers = Object.entries(WORKER_PROFILES).map(([name, meta]) => `- ${name}: ${meta.label}`).join('\n');
  return `[PRAETORIUM WORKFLOW CATALOG]\n${workflows}\n\n[PRAETORIUM OPERATING SKILLS]\n${skills}\n\n[PRAETORIUM WORKER PROFILES]\n${workers}`;
}
