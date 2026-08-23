import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractDirectorAnalysis, extractDirectorControl, inferRequestMode,
  validateDirectorAnalysis, validateDirectorControl,
} from '../../lib/director-actions.js';

function control(overrides = {}) {
  return {
    schema: 'director-action.v1', mode: 'delegate', workflow_id: 'standard-feature', state: 'executing',
    requirements: ['observable result'], decisions: ['separate implementation and review'],
    actions: [{
      id: 'implement', title: 'Implement', target: 'codex-implementer', task: 'Implement the bounded feature.',
      skills: [], dependencies: [], write_scope: ['src/'], acceptance: ['tests pass'], wake_on: ['completion'],
    }],
    owner_decision: { required: false, question: null, options: [], evidence: [] },
    ...overrides,
  };
}

describe('Director action control', () => {
  it('classifies execution requests before conversational question patterns', () => {
    assert.equal(inferRequestMode('이 공고들 조사해줄래?'), 'delegate');
    assert.equal(inferRequestMode('지금 워커 몇 개야?'), 'conversation');
    assert.equal(inferRequestMode('ㅎㅇ'), 'conversation');
    assert.equal(inferRequestMode('do the thing'), 'delegate');
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

  it('validates an approved workflow and worker graph', () => {
    const value = control({ actions: [
      control().actions[0],
      { id: 'review', title: 'Review', target: 'adversarial-reviewer', task: 'Falsify behavior.', skills: ['adversarial-review'], dependencies: ['implement'], write_scope: ['read-only'], acceptance: ['verdict'], wake_on: ['finding'] },
    ] });
    const parsed = validateDirectorControl(value, { requiredMode: 'delegate' });
    assert.equal(parsed.actions.length, 2);
    assert.deepEqual(parsed.actions[1].dependencies, ['implement']);
  });

  it('rejects direct execution answers without durable actions', () => {
    assert.throws(() => validateDirectorControl(control({ mode: 'conversation', workflow_id: null, actions: [] }), { requiredMode: 'delegate' }), /must be delegated/);
    assert.throws(() => validateDirectorControl(control({ actions: [] }), { requiredMode: 'delegate' }), /at least one/);
  });

  it('rejects unknown workers, skills, and forward dependencies', () => {
    assert.throws(() => validateDirectorControl(control({ actions: [{ ...control().actions[0], target: 'random-agent' }] })), /Unapproved worker/);
    assert.throws(() => validateDirectorControl(control({ actions: [{ ...control().actions[0], skills: ['magic'] }] })), /Unapproved Praetorium skill/);
    assert.throws(() => validateDirectorControl(control({ actions: [
      { ...control().actions[0], dependencies: ['review'] },
      { ...control().actions[0], id: 'review' },
    ] })), /must appear earlier/);
  });
});
