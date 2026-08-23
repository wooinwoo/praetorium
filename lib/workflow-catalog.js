export const WORKER_PROFILES = Object.freeze({
  'codex-implementer': { label: '구현 워커', kind: 'write' },
  'convention-reviewer': { label: '컨벤션 리뷰어', kind: 'review' },
  'security-reviewer': { label: '보안 리뷰어', kind: 'review' },
  'adversarial-reviewer': { label: '적대적 검증 리뷰어', kind: 'review' },
  'test-gap-reviewer': { label: '테스트 갭 리뷰어', kind: 'review' },
  'architecture-reviewer': { label: '아키텍처 리뷰어', kind: 'review' },
  'performance-reviewer': { label: '성능 리뷰어', kind: 'review' },
  'release-reviewer': { label: '릴리스 리뷰어', kind: 'review' },
  remediator: { label: '수정 워커', kind: 'write' },
  'quality-gate-reviewer': { label: '품질 게이트', kind: 'gate' },
});

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

export const WORKFLOWS = Object.freeze([
  {
    id: 'quick-fix',
    name: '빠른 수정',
    description: '작고 국소적인 결함을 고치고 핵심 회귀만 빠르게 검증합니다.',
    graph: [
      '범위 확인', '구현+테스트', '컨벤션·테스트갭·적대적 검증(병렬)',
      '지적 수정(최대 2회)', '영향 리뷰 재실행', '품질 게이트',
    ],
  },
  {
    id: 'standard-feature',
    name: '표준 기능 개발',
    description: '요구·설계·구현·다중 리뷰·수정 루프를 거치는 기본 개발 플로우입니다.',
    graph: [
      '요구 분석', '설계와 작업 분할', '독립 구현(병렬)', '통합·테스트',
      '컨벤션·테스트갭·적대적 검증(병렬)', '지적 수정(최대 2회)',
      '영향 리뷰 재실행', '품질 게이트', 'Owner 결과 보고',
    ],
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
  },
  {
    id: 'research-planning',
    name: '조사·기획',
    description: '여러 조사 트랙을 병렬화하고 출처 교차검증 후 의사결정 문서를 만듭니다.',
    graph: [
      '질문·선정 기준 확정', '독립 조사 트랙(병렬)', '출처·시점 교차검증',
      '종합·우선순위화', '적대적 검증', '문서화', 'Owner 보고',
    ],
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
  },
  {
    id: 'skill-development',
    name: '스킬 개발',
    description: '반복 실패를 근거로 새 스킬을 만들고 평가·카나리·롤백 가능하게 활성화합니다.',
    graph: [
      '행동 증거 수집', '스킬/도구/정책 문제 분류', '스킬 제안', '구현',
      '정상·적대적 평가', '카나리 적용', 'Owner 활성화 승인', '관찰·롤백',
    ],
  },
]);

export function workflowById(id) {
  return WORKFLOWS.find(workflow => workflow.id === id) || null;
}

export function catalogPrompt() {
  const workflows = WORKFLOWS.map(item => `- ${item.id}: ${item.name} — ${item.graph.join(' → ')}`).join('\n');
  const skills = Object.entries(PRAETORIUM_SKILLS).map(([name, description]) => `- ${name}: ${description}`).join('\n');
  const workers = Object.entries(WORKER_PROFILES).map(([name, meta]) => `- ${name}: ${meta.label}`).join('\n');
  return `[PRAETORIUM WORKFLOW CATALOG]\n${workflows}\n\n[PRAETORIUM OPERATING SKILLS]\n${skills}\n\n[PRAETORIUM WORKER PROFILES]\n${workers}`;
}
