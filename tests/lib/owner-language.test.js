import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectorService, _test as directorTest } from '../../lib/director-service.js';
import { buildSupervisionPrompt } from '../../lib/goal-supervisor.js';
import {
  ownerCommunicationContract, ownerCommunicationLanguage, workerRoleBoundary,
} from '../../lib/owner-language.js';

function service() {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'praetorium-owner-language-'));
  return new DirectorService({
    runtime: {
      listTasks: async () => [],
      dispatch: async () => ({ json: { spawned: 0 } }),
    },
    stateFile: join(stateDirectory, 'directors.json'),
    projectsRoot: 'C:\\projects',
    getProjects: () => [{ id: 'alpha', name: 'Alpha', path: 'C:\\projects\\alpha' }],
  });
}

function action() {
  return {
    id: 'implement', title: '결제 API 구현', target: 'codex-implementer', effect: 'workspace_write',
    task: '결제 API를 구현하고 테스트하세요.', skills: [], dependencies: [], writeScope: ['src/'],
    acceptance: ['테스트 통과'], wakeOn: ['completion'],
  };
}

describe('Owner communication language', () => {
  it('selects Korean for Hangul input and preserves English machine markers', () => {
    assert.equal(ownerCommunicationLanguage('결제 API를 완성해줘'), 'ko');
    assert.equal(ownerCommunicationLanguage('Complete the payment API'), 'en');

    const contract = ownerCommunicationContract('결제 API를 완성해줘');
    assert.match(contract, /Owner communication language: Korean \(ko\)/);
    assert.match(contract, /PLAN\/OBSERVED\/DECISION\/VERIFY/);
    assert.match(contract, /JSON keys, schema names/);
    assert.match(workerRoleBoundary('결제 API를 완성해줘'), /다른 reviewer 또는 quality gate를 대신 수행했거나 통과했다고 주장하지 마세요/);
  });

  it('injects Korean into Director turns while keeping English requests compatible', () => {
    const svc = service();
    const korean = svc._contextualPrompt({
      id: 'run-ko', projectId: 'alpha', prompt: '로그인 버그를 고쳐줘', requestedMode: 'delegate',
    }, '', { stage: 'combined' });
    const english = svc._contextualPrompt({
      id: 'run-en', projectId: 'alpha', prompt: 'Fix the login bug', requestedMode: 'delegate',
    }, '', { stage: 'combined' });

    assert.match(korean, /Owner communication language: Korean \(ko\)/);
    assert.match(korean, /Worker titles\/tasks\/acceptance criteria/);
    assert.match(korean, /"schema":"director-action\.v1"/);
    assert.match(english, /Owner communication language: English \(en\)/);
    assert.doesNotMatch(english, /Owner communication language: Korean/);
  });

  it('injects Korean and a strict role boundary into every Worker assignment', () => {
    const body = directorTest.taskBody(
      { id: 'goal-ko', objective: '결제 API를 완성해줘', successCriteria: ['테스트 통과'], ownerAnswers: [] },
      { prompt: '결제 API를 완성해줘' },
      { workflowId: 'quick-fix', requirements: [] },
      action(),
      1,
    );

    assert.match(body, /Owner communication language: Korean \(ko\)/);
    assert.match(body, /\[ROLE BOUNDARY\]/);
    assert.match(body, /다른 reviewer 또는 quality gate를 대신 수행했거나 통과했다고 주장하지 마세요/);
    assert.match(body, /- PLAN:.*- OBSERVED:.*- DECISION:.*- VERIFY:/s);

    const intervention = directorTest.interventionTransport('iv_ko', '이 테스트를 먼저 실행해줘');
    assert.match(intervention.message, /DECISION 또는 VERIFY 체크포인트/);
    assert.match(intervention.message, /\[PRAETORIUM INTERVENTION iv_ko\]/);
  });

  it('retains the Korean contract on fresh durable Goal supervision turns', () => {
    const prompt = buildSupervisionPrompt({
      goal: {
        id: 'goal-ko', objective: '결제 API를 완성해줘', status: 'evaluating', phase: 'assessing_evidence',
        workflowId: 'quick-fix', successCriteria: ['테스트 통과'], constraints: [], requirements: [],
        ownerAnswers: [], waves: [], taskRecords: [], cycleCount: 1, maxCycles: 12,
        remediationCount: 0, maxRemediationLoops: 2, publicDecisions: [],
      },
      evidence: [],
      gateAudit: { satisfied: false, missingProfiles: ['quality-gate-reviewer'] },
      catalog: '[CATALOG]',
      reason: 'worker_wave_completed',
    });
    const snapshot = JSON.parse(prompt.split('[DURABLE GOAL SNAPSHOT]\n')[1]);

    assert.match(prompt, /Owner communication language: Korean \(ko\)/);
    assert.match(prompt, /final report/);
    assert.equal(snapshot.communication_language, 'ko');
  });

  it('keeps every installed Director and Worker role aligned with language and role boundaries', () => {
    const profiles = ['project-director', 'skill-director', 'implementer', 'remediator', 'reviewer', 'quality-gate'];
    for (const profile of profiles) {
      const source = readFileSync(join(process.cwd(), '.agents', 'hermes-profiles', 'souls', `${profile}.SOUL.md`), 'utf8');
      assert.match(source, /OWNER COMMUNICATION LANGUAGE/, profile);
      if (!profile.endsWith('director')) assert.match(source, /assigned (?:role|quality-gate decision|specialist review)/, profile);
    }
  });

  it('keeps the packaged Director profile aligned with autonomous Owner chat routing', () => {
    const soul = readFileSync(join(process.cwd(), '.agents', 'hermes-profiles', 'souls', 'project-director.SOUL.md'), 'utf8');
    const skill = readFileSync(join(process.cwd(), '.agents', 'skills', 'project-director', 'SKILL.md'), 'utf8');
    const contract = readFileSync(join(process.cwd(), '.agents', 'skill-references', 'director-contract.md'), 'utf8');
    for (const source of [soul, skill, contract]) {
      assert.match(source, /Owner[^\n]*`auto`/);
      assert.match(source, /reliable bounded answer/);
      assert.match(source, /unavailable capabilit/);
      assert.match(source, /delegate/);
    }
    assert.match(skill, /direct conversation creates no durable Goal/i);
    assert.match(contract, /Auto creates a Goal only after the Director selects delegation/);
  });
});
