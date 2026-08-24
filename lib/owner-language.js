const HANGUL_PATTERN = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;

export function ownerCommunicationLanguage(value) {
  return HANGUL_PATTERN.test(String(value || '')) ? 'ko' : 'en';
}

export function ownerCommunicationContract(value) {
  const language = ownerCommunicationLanguage(value);
  const languageName = language === 'ko' ? 'Korean (ko)' : 'English (en)';
  return [
    '[OWNER COMMUNICATION LANGUAGE]',
    `Owner communication language: ${languageName}.`,
    `Write every Owner-visible natural-language value in ${language === 'ko' ? 'Korean' : 'English'}: public summaries, analysis and control explanation strings, Owner questions/options/evidence, Worker titles/tasks/acceptance criteria, PLAN/OBSERVED/DECISION/VERIFY bodies, kanban completion or block summaries, and the final report.`,
    'Keep machine contracts unchanged in English: JSON keys, schema names, tags, workflow/profile/skill IDs, effect/state/verdict/decision enum values, and the literal PLAN/OBSERVED/DECISION/VERIFY prefixes. Paths, commands, code, API names, and product proper nouns may remain verbatim.',
    'Keep all JSON valid. Never translate a key, schema identifier, marker, or enumerated token.',
  ].join('\n');
}

export function workerRoleBoundary(value) {
  return ownerCommunicationLanguage(value) === 'ko'
    ? '[ROLE BOUNDARY]\n현재 배정된 action과 역할만 수행하고 그 결과만 보고하세요. 다른 reviewer 또는 quality gate를 대신 수행했거나 통과했다고 주장하지 마세요. Director가 필요한 독립 검토와 게이트를 별도의 fresh Worker로 배정합니다.'
    : '[ROLE BOUNDARY]\nPerform and report only the assigned action and role. Do not claim that another reviewer or quality gate was performed or passed. The Director assigns required independent reviews and gates to separate fresh Workers.';
}
