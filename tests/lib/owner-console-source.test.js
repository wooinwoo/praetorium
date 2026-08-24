import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = async path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const { _test } = await import('../../js/owner-console.js');

test('Owner console exposes decision-grade authority fields and exact evidence matrices', async () => {
  const js = await source('js/owner-console.js');
  for (const field of ['approvalKind', 'effect', 'target', 'writeScope', 'planDigest', 'candidateDigest', 'throughWave', 'plannedActions']) {
    assert.match(js, new RegExp(`\\b${field}\\b`), field);
  }
  assert.match(js, /goal\?\.finalAudit/);
  assert.match(js, /성공 조건/);
  assert.match(js, /필수 프로필/);
  assert.match(js, /인정된 작업/);
  assert.match(js, /최신 여부/);
  assert.match(js, /게이트 판정/);
  assert.match(js, /executionAttested === true/);
});

test('Owner console keeps stale trace, locks mutations, and labels queued interventions honestly', async () => {
  const [html, js] = await Promise.all([source('index.html'), source('js/owner-console.js')]);
  assert.match(html, /id="sync-banner"/);
  assert.match(html, /data-trace-filter="decision"/);
  assert.match(html, /data-trace-filter="worker"/);
  assert.match(html, /data-trace-filter="gate"/);
  assert.match(html, /data-trace-filter="failure"/);
  assert.match(js, /기존 실행 기록 보존 중/);
  assert.match(js, /function controlPlaneUnavailable/);
  assert.match(js, /접수됨 · 워커 확인 대기/);
  assert.match(js, /워커 확인됨/);
  assert.match(js, /details\.praetoriumRecord\?\.interventions/);
  assert.match(js, /아직 워커가 재출력한 근거는 없습니다/);
  assert.match(js, /접수는 요청을 저장했다는 뜻입니다/);
  assert.match(js, /pause_requested: \['오너가 워커 일시정지 요청'/);
  assert.match(js, /resumed_by_owner: \['오너가 워커 재개'/);
});

test('Owner console renders queue position, collapsible waves, and dependency flow labels', async () => {
  const js = await source('js/owner-console.js');
  assert.match(js, /state\.summary\?\.queuedGoals/);
  assert.match(js, /goal\.queuePosition/);
  assert.match(js, /data-wave-toggle/);
  assert.match(js, /선행 작업:/);
  assert.match(js, /완료 후 시작:/);
  assert.match(js, /messageMode === 'conversation' && director\?\.status === 'running'/);
  assert.match(js, /현재 목표 뒤 디렉터 대기열에 안전하게 추가됩니다/);
});

test('Owner console hydrates the full durable Goal history without discarding stale trace', async () => {
  const js = await source('js/owner-console.js');
  assert.match(js, /function refreshSelectedGoalDetail/);
  assert.match(js, /\/goals\/\$\{encodeURIComponent\(goalId\)\}/);
  assert.match(js, /Array\.isArray\(goal\.runs\)/);
  assert.match(js, /목표 전체 이력 동기화에 실패해 기존 실행 기록을 유지합니다/);
  assert.match(js, /state\.goalDetailError = error\.message/);
});

test('Owner console orders selectable active, queued, and recent Goals and preserves the selected Goal id', async () => {
  const [html, js] = await Promise.all([source('index.html'), source('js/owner-console.js')]);
  assert.match(html, /id="goal-switcher"/);
  assert.match(html, /id="goal-submit-receipt"/);
  assert.match(js, /selectedGoalId/);
  assert.match(js, /result\?\.goalId/);
  assert.match(js, /result\.queuePosition/);
  assert.match(js, /접수됨 · 대기/);
  const ordered = _test.orderGoalsForSelector([
    { id: 'recent', status: 'completed', updatedAt: '2026-08-24T00:00:00Z' },
    { id: 'queue-2', status: 'queued', queuePosition: 2, createdAt: '2026-08-24T02:00:00Z' },
    { id: 'active', status: 'executing', updatedAt: '2026-08-24T01:00:00Z' },
    { id: 'queue-1', status: 'queued', queuePosition: 1, createdAt: '2026-08-24T03:00:00Z' },
  ], new Set(['active']));
  assert.deepEqual(ordered.map(goal => goal.id), ['active', 'queue-1', 'queue-2', 'recent']);
});

test('Owner attention excludes autonomous review and prioritizes failed or paused work', () => {
  assert.equal(_test.taskNeedsOwnerAttention({ status: 'review' }), false);
  assert.equal(_test.taskNeedsOwnerAttention({ status: 'failed' }), true);
  assert.equal(_test.taskNeedsOwnerAttention({ status: 'running' }, { pausedByOwner: true }), true);
  assert.ok(_test.taskOperationalPriority({ status: 'failed' }) < _test.taskOperationalPriority({ status: 'running' }));
  assert.ok(_test.taskOperationalPriority({ status: 'blocked' }) < _test.taskOperationalPriority({ status: 'review' }));
});

test('Owner console distinguishes active inference from genuinely stale supervision', () => {
  const nowMs = Date.parse('2026-08-25T00:10:00Z');
  const inference = _test.deriveSupervisionHealth({
    active: true,
    inferenceActive: true,
    inferenceStartedAt: nowMs - 180000,
    checkpointAt: nowMs - 121000,
    tickAt: nowMs - 10000,
    nextDelayMs: 10000,
    nowMs,
  });
  assert.equal(inference.stalled, false);
  assert.equal(inference.label, '판단 진행 중');
  assert.equal(inference.tone, 'reviewing');
  assert.match(inference.detail, /판단 3분/);
  const genuinelyStale = _test.deriveSupervisionHealth({
    active: true,
    inferenceActive: true,
    checkpointAt: nowMs - 601000,
    tickAt: nowMs - 601000,
    nowMs,
  });
  assert.equal(genuinelyStale.stalled, true);
  assert.equal(genuinelyStale.tone, 'failed');
  const workerHealthy = _test.deriveSupervisionHealth({
    active: true,
    inferenceActive: false,
    checkpointAt: nowMs - 300000,
    tickAt: nowMs - 10000,
    nextDelayMs: 60000,
    nowMs,
  });
  assert.equal(workerHealthy.stalled, false);
});

test('Owner console bounds long trace DOM and keeps wave collapse independent from category filters', async () => {
  const js = await source('js/owner-console.js');
  const tail = _test.visibleTraceTail(Array.from({ length: 400 }, (_, index) => index), 160);
  assert.equal(tail.omitted, 240);
  assert.equal(tail.visible.length, 160);
  assert.equal(tail.visible[0], 240);
  assert.match(js, /data-load-older-trace/);
  assert.doesNotMatch(js, /concealed: !expanded && state\.traceFilters/);
});

test('Owner console provides readable evidence text and modal semantics on narrow screens', async () => {
  const [html, css, js] = await Promise.all([source('index.html'), source('css/owner-console.css'), source('js/owner-console.js')]);
  assert.match(html, /aria-describedby="inspector-subtitle"/);
  assert.match(js, /pane\.setAttribute\('role', 'dialog'\)/);
  assert.match(js, /pane\.setAttribute\('aria-modal', 'true'\)/);
  assert.match(js, /function trapInspectorFocus/);
  assert.match(js, /Math\.max\(1, Math\.min\(1\.35/);
  assert.match(css, /\.raw-worker-log pre[\s\S]*font: 12px\/1\.6/);
  assert.match(js, /아직 판단 턴을 시작하지 않았습니다/);
});

test('Owner Goal controls expose only state-appropriate minimal interventions', () => {
  const queued = _test.goalControlOptions({ id: 'g-queued', status: 'queued', queuePosition: 2 }, new Set());
  assert.deepEqual(queued.map(({ action, position }) => [action, position || null]), [
    ['reorder', 'front'], ['reorder', 'back'], ['defer', null], ['cancel', null],
  ]);

  const awaiting = _test.goalControlOptions({ id: 'g-owner', status: 'awaiting_owner' }, new Set(['g-owner']));
  assert.deepEqual(awaiting.map(({ action }) => action), ['cancel']);
  assert.deepEqual(_test.goalControlOptions({ id: 'g-owner', status: 'awaiting_owner' }, new Set()), []);
  assert.deepEqual(_test.goalControlOptions({ id: 'g-blocked', status: 'blocked' }).map(({ action }) => action), ['retry', 'cancel']);
  assert.deepEqual(_test.goalControlOptions({ id: 'g-failed', status: 'failed' }).map(({ action }) => action), ['retry', 'cancel']);
  const cancelled = { id: 'g-cancelled', status: 'failed', phase: 'cancelled', terminalReason: 'owner_cancelled' };
  assert.equal(_test.goalSemanticStatus(cancelled), 'cancelled');
  assert.deepEqual(_test.goalControlOptions(cancelled).map(({ action }) => action), []);
  assert.deepEqual(_test.goalControlOptions({ id: 'g-running', status: 'executing' }, new Set(['g-running'])), []);
});

test('Owner intervention receipts distinguish delivery, failure, acceptance, and Worker observation', () => {
  assert.equal(_test.interventionReceiptState({ status: 'delivery_pending' }).label, '전달 대기');
  assert.equal(_test.interventionReceiptState({ status: 'delivery_failed', deliveryError: 'offline' }).label, '전달 실패');
  assert.equal(_test.interventionReceiptState({ status: 'accepted_queued' }).label, '접수됨 · 워커 확인 대기');
  assert.equal(_test.interventionReceiptState({ status: 'worker_observed', workerObserved: true }).label, '워커 확인됨');
});

test('Owner Goal controls confirm exact destructive scope and preserve server rejection text', async () => {
  const [js, css] = await Promise.all([source('js/owner-console.js'), source('css/owner-console.css')]);
  const prompt = _test.goalCancelConfirmation({ id: 'g-cancel', objective: '결제 API 완성', status: 'blocked' });
  assert.match(prompt, /결제 API 완성/);
  assert.match(prompt, /진행 중단/);
  assert.match(js, /window\.confirm\(goalCancelConfirmation\(goal\)\)/);
  assert.match(js, /\/goals\/\$\{encodeURIComponent\(goalId\)\}\/control/);
  assert.match(js, /data-goal-control-menu/);
  assert.match(js, /data-goal-control=/);
  assert.match(js, /function goalControlBusy/);
  assert.match(js, /toast\(error\.message, 'error', \{ raw: true \}\)/);
  assert.match(js, /message: String\(error\?\.message \|\| error\)/);
  assert.match(css, /\.goal-control-menu > summary/);
  assert.match(css, /\.goal-control-actions[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.goal-control-actions \{ grid-template-columns: 1fr; \}/);
  assert.equal(_test.goalControlSuccessMessage('reorder', { queuePosition: 1, previousPosition: 3 }), '대기열 #1로 이동했습니다 · 이전 #3.');
});

test('Owner console keeps the Goal, public judgement, current Wave, and gate hierarchy above overlay activity', async () => {
  const [html, css, js] = await Promise.all([source('index.html'), source('css/owner-console.css'), source('js/owner-console.js')]);
  assert.match(html, /class="mission-sticky"/);
  assert.match(html, /디렉터 공개 판단/);
  assert.match(html, /현재 작업 묶음/);
  assert.match(html, /완료 게이트/);
  assert.match(html, /실행 활동/);
  assert.match(html, /data-panel-section="goal-queue"/);
  assert.match(html, /id="trace-splitter"[\s\S]*role="separator"[\s\S]*aria-orientation="horizontal"/);
  assert.match(html, /id="inspector-splitter"[\s\S]*role="separator"[\s\S]*aria-orientation="vertical"/);
  assert.match(html, /id="composer-scope"/);
  assert.match(js, /const labels = \['명세 확인', '계획', '구현', '전문 리뷰', '품질 게이트', '완료'\]/);
  assert.match(js, /function renderCurrentWave/);
  assert.match(js, /function renderGateRunway/);
  assert.match(js, /function initPanelSplitter/);
  assert.match(js, /setPointerCapture/);
  assert.match(js, /releasePointerCapture/);
  assert.match(js, /splitter\.addEventListener\('dblclick'/);
  assert.match(js, /SPLITTER_KEYBOARD_STEP/);
  assert.match(js, /dimensions: \{ activityHeight: DEFAULT_ACTIVITY_HEIGHT, inspectorWidth: DEFAULT_INSPECTOR_WIDTH \}/);
  assert.match(css, /\.inspector-splitter[\s\S]*cursor: ew-resize/);
  assert.match(css, /\.trace-splitter[\s\S]*cursor: ns-resize/);
  assert.match(css, /body\.inspector-fullscreen \.command-pane/);
});

test('Owner console persists collapse, size, detail, wave, conversation, and evidence view preferences', async () => {
  const js = await source('js/owner-console.js');
  assert.match(js, /praetorium-owner-console-ui-v4/);
  assert.match(js, /detailExpansion/);
  assert.match(js, /waveExpansion/);
  assert.match(js, /workerViews/);
  assert.match(js, /rawLogs/);
  assert.match(js, /conversationOpen/);
  assert.match(js, /data-detail-key/);
  assert.equal(_test.detailDefaultOpen('현재 감독 단계'), true);
  assert.equal(_test.detailDefaultOpen('완료 기준'), false);
  assert.equal(_test.detailDefaultOpen('누적 검증 증거'), false);
});

test('Worker detail separates public checkpoints, lifecycle, commands, raw evidence, and intervention history', async () => {
  const [js, css] = await Promise.all([source('js/owner-console.js'), source('css/owner-console.css')]);
  assert.match(js, /\['checkpoints', '체크포인트'/);
  assert.match(js, /\['activity', '활동'/);
  assert.match(js, /\['commands', '명령·결과'/);
  assert.match(js, /\['evidence', '증거 원문'/);
  assert.match(js, /내부 사고 과정 원문이 아닙니다/);
  assert.match(js, /function interventionHistoryHtml/);
  assert.match(js, /intervention\.message \|\| intervention\.body/);
  assert.doesNotMatch(js, /state\.rawLogOpen \?\? task\.status === 'running'/);
  assert.match(css, /\.worker-stream-tabs/);
  assert.match(css, /\.intervention-timeline/);
});

test('Director public checkpoint story reads facts through Owner decision without mislabeling review as blocked', () => {
  assert.equal(_test.traceStatus('review'), 'reviewing');
  assert.equal(_test.checkpointStage('analyzing'), 'facts');
  assert.equal(_test.checkpointStage('directing'), 'judgement');
  assert.equal(_test.checkpointStage('materializing'), 'delegation');
  assert.equal(_test.checkpointStage('executing'), 'progress');
  assert.equal(_test.checkpointStage('awaiting_owner'), 'owner');
  assert.equal(_test.goalEventBelongsInSummary({ kind: 'task', phase: 'worker_progress' }), false);
  assert.equal(_test.goalEventBelongsInSummary({ kind: 'owner_decision', phase: 'awaiting_owner' }), true);
});

test('Owner console clamps repeated objectives and uses a neutral graphite palette with one blue accent', async () => {
  const [html, css, js] = await Promise.all([source('index.html'), source('css/owner-console.css'), source('js/owner-console.js')]);
  assert.match(html, /id="mission-objective-toggle"[\s\S]*목표 전체 보기/);
  assert.match(js, /missionCopy\?\.classList\.remove\('objective-expanded'\)/);
  assert.match(js, /detailGroup\('목표 원문'/);
  assert.match(css, /--blue: #5b9cf6/);
  assert.match(css, /\.mission-copy h1[\s\S]*-webkit-line-clamp: 2/);
  assert.match(css, /\.inspector-hero\.goal-hero h3[\s\S]*-webkit-line-clamp: 2/);
  assert.match(css, /\.current-focus[\s\S]*grid-template-columns: \.9fr 1\.35fr 1\.15fr/);
  assert.doesNotMatch(css, /--accent:\s*#8b7cf6/);
});

test('Owner console exposes a visible theme state and real light-theme tokens', async () => {
  const [html, css, js] = await Promise.all([source('index.html'), source('css/owner-console.css'), source('js/owner-console.js')]);
  assert.match(html, /id="theme-toggle-label">다크</);
  assert.match(js, /\$\('theme-toggle-label'\)\.textContent/);
  assert.match(css, /:root\[data-theme="light"\]/);
  assert.match(css, /--rail-bg:/);
});

test('Primary operational labels are shown in Korean while internal status keys stay stable', async () => {
  const [html, js] = await Promise.all([source('index.html'), source('js/owner-console.js')]);
  for (const copy of ['목표 대기열', '디렉터 공개 판단', '현재 작업 묶음', '완료 게이트', '실행 활동', '받는 곳', '전체 화면']) assert.match(html, new RegExp(copy));
  for (const copy of ['전달 대기', '전달 실패', '접수됨 · 워커 확인 대기', '워커 확인됨', '오너 개입']) assert.match(js, new RegExp(copy));
  assert.doesNotMatch(html, />\s*(?:Worker|Gate|TO|FOLLOW LIVE|PIN|S\/M\/L)\s*</);
  assert.equal(
    _test.localizeOperationalCopy('Director 자동 평가 실패 · Owner 판단 대기 · Worker Wave checkpoint'),
    '디렉터 자동 평가 실패 · 오너 판단 대기 · 워커 작업 묶음 체크포인트',
  );
  assert.equal(_test.directorDisplayName('Project Director 2'), '프로젝트 디렉터 2');
  assert.equal(_test.directorDisplayName('Skill Director'), '스킬 디렉터');
});

test('Background polling ignores scheduler heartbeat churn but notices visible state changes', async () => {
  const [js, css] = await Promise.all([source('js/owner-console.js'), source('css/owner-console.css')]);
  const base = {
    directors: [{ id: 'project-director-1', status: 'running' }],
    sessions: { total: 1, workers: 1, directors: 0 },
    scheduler: {
      active: true,
      effectiveCap: 4,
      nextDelayMs: 3000,
      lastTickAt: '2026-08-25T00:00:00Z',
      boards: [{ directorId: 'project-director-1', lastTickAt: '2026-08-25T00:00:00Z', dispatchCount: 8 }],
    },
  };
  const heartbeatOnly = structuredClone(base);
  heartbeatOnly.scheduler.lastTickAt = '2026-08-25T00:00:03Z';
  heartbeatOnly.scheduler.boards[0].lastTickAt = '2026-08-25T00:00:03Z';
  heartbeatOnly.scheduler.boards[0].dispatchCount = 9;
  assert.equal(
    _test.consoleViewFingerprint(base, [{ id: 't1', status: 'running' }], null),
    _test.consoleViewFingerprint(heartbeatOnly, [{ id: 't1', status: 'running' }], null),
  );
  assert.notEqual(
    _test.consoleViewFingerprint(base, [{ id: 't1', status: 'running' }], null),
    _test.consoleViewFingerprint(base, [{ id: 't1', status: 'done' }], null),
  );
  assert.notEqual(
    _test.consoleViewFingerprint(base, [{ id: 't1', status: 'running' }], null),
    _test.consoleViewFingerprint({ ...base, sessions: { total: 2, workers: 2, directors: 0 } }, [{ id: 't1', status: 'running' }], null),
  );
  assert.match(js, /state\.refreshing = !quiet/);
  assert.match(js, /nextFingerprint !== state\.renderFingerprint/);
  assert.match(js, /else refreshLiveIndicators\(\)/);
  assert.match(css, /\.mission-context \{ flex-wrap: wrap/);
  assert.match(css, /#session-count \{ max-width: 220px/);
});

test('Stable poll rendering preserves DOM roots, inspector position, and trace scroll', async () => {
  const js = await source('js/owner-console.js');
  assert.match(js, /const renderedHtml = new WeakMap\(\)/);
  assert.match(js, /renderedHtml\.get\(element\) === html/);
  assert.match(js, /const changed = updateHtml\(inspector, html\)/);
  assert.match(js, /if \(changed && scroller\) requestAnimationFrame/);
  assert.match(js, /const previousTop = scroller\?\.scrollTop \|\| 0/);
  assert.match(js, /scroller\.scrollTop = previousTop/);
  assert.match(js, /const previousScrollLeft = list\.scrollLeft/);
  assert.match(js, /list\.scrollLeft = previousScrollLeft/);
  assert.equal(_test.sameJson({ task: { id: 't1', status: 'running' } }, { task: { id: 't1', status: 'running' } }), true);
  assert.equal(_test.sameJson({ task: { id: 't1', status: 'running' } }, { task: { id: 't1', status: 'done' } }), false);
});

test('Owner console uses conditional compact polling and avoids hidden or unneeded evidence reads', async () => {
  const js = await source('js/owner-console.js');
  assert.match(js, /view: 'compact'/);
  assert.match(js, /query\.set\('revision', state\.consoleRevision\)/);
  assert.match(js, /allowNotModified: true/);
  assert.match(js, /response\.status === 304/);
  assert.match(js, /snapshot\.notModified/);
  assert.match(js, /expectedRevision && state\.goalDetailRevision === expectedRevision/);
  assert.match(js, /function taskInspectorNeedsRefresh/);
  assert.match(js, /if \(taskInspectorNeedsRefresh\(\)\) void refreshSelectedTask\(\)/);
  assert.match(js, /visibilitychange/);
  assert.match(js, /if \(!document\.hidden\) void loadConsole\(\{ quiet: true \}\)/);
});
