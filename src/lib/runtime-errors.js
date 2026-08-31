export function runtimeNeedsAttention(value) {
  return /런타임(?:이 준비되지 않았습니다| 준비 실패:)/.test(String(value ?? ''));
}
