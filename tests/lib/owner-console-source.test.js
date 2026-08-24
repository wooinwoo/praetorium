import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = async path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('Owner console exposes decision-grade authority fields and exact evidence matrices', async () => {
  const js = await source('js/owner-console.js');
  for (const field of ['approvalKind', 'effect', 'target', 'writeScope', 'planDigest', 'candidateDigest', 'throughWave', 'plannedActions']) {
    assert.match(js, new RegExp(`\\b${field}\\b`), field);
  }
  assert.match(js, /goal\?\.finalAudit/);
  assert.match(js, /SUCCESS CRITERION/);
  assert.match(js, /REQUIRED PROFILE/);
  assert.match(js, /CREDITED TASK/);
  assert.match(js, /FRESHNESS/);
  assert.match(js, /GATE VERDICT/);
  assert.match(js, /executionAttested === true/);
});

test('Owner console keeps stale trace, locks mutations, and labels queued interventions honestly', async () => {
  const [html, js] = await Promise.all([source('index.html'), source('js/owner-console.js')]);
  assert.match(html, /id="sync-banner"/);
  assert.match(html, /data-trace-filter="decision"/);
  assert.match(html, /data-trace-filter="worker"/);
  assert.match(html, /data-trace-filter="gate"/);
  assert.match(html, /data-trace-filter="failure"/);
  assert.match(js, /기존 trace 보존 중/);
  assert.match(js, /function controlPlaneUnavailable/);
  assert.match(js, /ACCEPTED \/ QUEUED/);
  assert.match(js, /Worker 반영 여부는 다음 공개 체크포인트에서 확인하세요/);
  assert.match(js, /pause_requested: \['Owner가 Worker 일시정지 요청'/);
  assert.match(js, /resumed_by_owner: \['Owner가 Worker 재개'/);
});

test('Owner console renders queue position, collapsible waves, and dependency flow labels', async () => {
  const js = await source('js/owner-console.js');
  assert.match(js, /state\.summary\?\.queuedGoals/);
  assert.match(js, /goal\.queuePosition/);
  assert.match(js, /data-wave-toggle/);
  assert.match(js, /blocked by:/);
  assert.match(js, /unlocks:/);
  assert.match(js, /messageMode === 'conversation' && director\?\.status === 'running'/);
  assert.match(js, /현재 Goal 뒤 Director 대기열에 안전하게 추가됩니다/);
});

test('Owner console hydrates the full durable Goal history without discarding stale trace', async () => {
  const js = await source('js/owner-console.js');
  assert.match(js, /function refreshSelectedGoalDetail/);
  assert.match(js, /\/goals\/\$\{encodeURIComponent\(goalId\)\}/);
  assert.match(js, /Array\.isArray\(goal\.runs\)/);
  assert.match(js, /Goal 전체 이력 동기화에 실패해 기존 trace를 유지합니다/);
  assert.match(js, /state\.goalDetailError = error\.message/);
});
