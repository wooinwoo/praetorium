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
  const [hook, model, workspace, forms] = await Promise.all([
    source('src/hooks/usePraetorium.js'), source('src/domain/operator-model.js'), source('src/components/Workspace.jsx'), source('src/components/forms.jsx'),
  ]);
  assert.match(hook, /setErrors\(current => \(\{ \.\.\.current, trace: trace\.reason\.message \}\)\)/);
  assert.doesNotMatch(hook, /setTaskTrace\(null\)[\s\S]{0,160}trace\.reason/);
  assert.match(workspace, /기존 기록을 보존합니다/);
  assert.match(workspace, /record\.interventions\.map/);
  assert.match(model, /Worker 확인됨/);
  assert.match(model, /Hermes 접수됨 · Worker 확인 대기/);
  assert.match(model, /자동 재시도 예정 · 다시 보내지 마세요/);
  assert.match(forms, /terminalStates|disabled/);
});

test('React console rejects stale Worker responses and pauses hidden evidence polling', async () => {
  const [app, apiClient, hook, settings, workspace] = await Promise.all([
    source('src/App.jsx'), source('src/lib/api.js'), source('src/hooks/usePraetorium.js'), source('src/components/Settings.jsx'), source('src/components/Workspace.jsx'),
  ]);
  assert.match(apiClient, /\['GET', 'HEAD'\]\.includes\(method\) \? 10000/);
  assert.match(apiClient, /error\.name === 'AbortError' && timedOut/);
  assert.match(app, /taskPollingEnabled: activeTab !== 'director'/);
  assert.match(hook, /requestId !== taskRequest\.current \|\| signal\.aborted/);
  assert.match(hook, /5000, taskPollingEnabled/);
  assert.match(settings, /role="dialog" aria-modal="true"/);
  assert.match(settings, /event\.key !== 'Tab'/);
  assert.match(settings, /lastFocusRef\.current\?\.focus/);
  assert.match(workspace, /Worker 목록 동기화 실패/);
  assert.match(workspace, /selectedEntry\?\.type === 'task'/);
  assert.match(workspace, /goals\/\$\{encodeURIComponent\(goal\.id\)\}\/control/);
  assert.match(workspace, /공개 체크포인트/);
  assert.match(workspace, /수명주기 증거/);
  assert.match(workspace, /최종 결과·검증/);
  assert.match(workspace, /detail\?\.latest_summary/);
  assert.match(hook, /taskEvidenceSettled/);
  for (const status of ['succeeded', 'success', 'blocked']) assert.match(hook, new RegExp(`'${status}'`));
});

test('Owner console renders queue position, collapsible waves, and dependency flow labels', async () => {
  const js = await source('js/owner-console.js');
  assert.match(js, /state\.summary\?\.queuedGoals/);
  assert.match(js, /goal\.queuePosition/);
  assert.match(js, /data-wave-toggle/);
  assert.match(js, /선행 작업:/);
  assert.match(js, /완료 후 시작:/);
  assert.match(js, /messageMode !== 'delegate' && director\?\.status === 'running'/);
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
  const [hook, sidebar, workspace] = await Promise.all([
    source('src/hooks/usePraetorium.js'), source('src/components/Sidebar.jsx'), source('src/components/Workspace.jsx'),
  ]);
  assert.match(hook, /selectedGoalId/);
  assert.match(hook, /\.sort\(\(a, b\) => Date\.parse\(b\.updatedAt/);
  assert.match(sidebar, /const active = visibleGoals\.filter/);
  assert.match(sidebar, /const queued = visibleGoals\.filter/);
  assert.match(sidebar, /const recent = visibleGoals\.filter/);
  assert.match(workspace, /accepted\?\.goalId/);
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
  const [js, workspace] = await Promise.all([source('js/owner-console.js'), source('src/components/Workspace.jsx')]);
  const tail = _test.visibleTraceTail(Array.from({ length: 400 }, (_, index) => index), 160);
  assert.equal(tail.omitted, 240);
  assert.equal(tail.visible.length, 160);
  assert.equal(tail.visible[0], 240);
  assert.match(js, /data-load-older-trace/);
  assert.doesNotMatch(js, /concealed: !expanded && state\.traceFilters/);
  assert.match(workspace, /trace\.slice\(-traceLimit\)/);
  assert.match(workspace, /이전 \{Math\.min\(160, omittedTrace\)\}개 불러오기/);
});

test('Owner console provides readable evidence text and removes hidden offscreen focus traps', async () => {
  const [app, workspace, css] = await Promise.all([
    source('src/App.jsx'), source('src/components/Workspace.jsx'), source('src/styles.css'),
  ]);
  assert.match(workspace, /aria-label="Inspector"/);
  assert.match(workspace, /증거 원문/);
  assert.match(workspace, /JSON\.stringify\(selectedEntry\.raw, null, 2\)/);
  assert.doesNotMatch(workspace, /trapInspectorFocus/);
  assert.match(app, /Math\.max\(\.9/);
  assert.match(app, /Math\.min\(1\.25/);
  assert.match(css, /font-size: calc\(16px \* var\(--ui-scale\)\)/);
  assert.match(css, /\.live-log pre, \.worker-log-full pre[\s\S]*overflow: auto/);
  assert.match(css, /\.live-log-pane[\s\S]*min-height: 0/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.primary-button, \.secondary-button, \.load-older, \.text-button \{ min-height: 44px; \}/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.director-composer select \{ height: 44px; \}/);
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

test('Owner console uses resizable rail and overview, Director chat, and Worker workspace tabs', async () => {
  const [html, app, common, sidebar, workspace, css] = await Promise.all([
    source('index.html'), source('src/App.jsx'), source('src/components/common.jsx'),
    source('src/components/Sidebar.jsx'), source('src/components/Workspace.jsx'), source('src/styles.css'),
  ]);
  assert.match(html, /class="skip-link" href="#workspace"/);
  assert.match(common, /role="separator"/);
  assert.match(common, /aria-orientation="vertical"/);
  assert.match(common, /setPointerCapture/);
  assert.match(common, /releasePointerCapture/);
  assert.match(common, /onDoubleClick=\{onReset\}/);
  assert.match(common, /ArrowLeft.*ArrowRight.*Home/);
  assert.match(app, /praetorium\.railWidth/);
  assert.match(app, /praetorium\.inspectorWidth/);
  assert.match(app, /praetorium\.inspectorOpen/);
  assert.match(workspace, /role="tablist"/);
  assert.match(workspace, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  assert.match(workspace, /role="tabpanel"/);
  assert.match(workspace, />현황</);
  assert.match(workspace, />디렉터</);
  assert.match(workspace, /worker-tabs/);
  assert.match(workspace, /Worker 원문 로그/);
  assert.match(workspace, /<Splitter label="세부 정보 너비"/);
  assert.match(workspace, /onClose=\{\(\) => setInspectorOpen\(false\)\}/);
  assert.match(workspace, /selectedEntry\.type === 'decision'/);
  assert.match(workspace, /const preview = String\(conclusion/);
  assert.match(workspace, /setSelectedEntry\(trace\.find\(entry => entry\.type === 'task' && entry\.taskId === id\)/);
  assert.match(workspace, /inspectorCloseRef\.current\?\.focus/);
  assert.match(workspace, /event\.key === 'Escape'/);
  assert.match(workspace, /!document\.querySelector\('\[role="dialog"\]'\)/);
  assert.match(sidebar, /aria-label=\{label\}/);
  assert.match(common, /className="rich-code"/);
  assert.match(common, /const ordered = line\.match/);
  assert.match(common, /<blockquote/);
  assert.match(common, /openUrl\(href\)/);
  assert.match(common, /event\.preventDefault\(\)/);
  assert.doesNotMatch(common, /location\.assign/);
  assert.match(css, /\.splitter[\s\S]*cursor: ew-resize/);
  assert.match(css, /\.workspace-shell[\s\S]*grid-template-rows: 48px minmax\(0, 1fr\)/);
  assert.match(css, /\.workspace-shell > \.splitter-right \{ grid-column: 2; grid-row: 2; \}/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.inspector \{ position: fixed;/);
  assert.match(css, /\.operator-grid \{[^}]*grid-template-columns: clamp\(220px, var\(--rail-width\), 34vw\)/);
  assert.doesNotMatch(css, /\.sidebar-search[^}]*display: none/);
  assert.equal(_test.workspaceViewKind('task:t-1'), 'task');
  assert.equal(_test.workspaceViewKind('unknown'), 'overview');
});

test('Director channel uses durable Goal-scoped chat and explicit decision or conclusion bubbles', async () => {
  const [forms, model, workspace, css] = await Promise.all([
    source('src/components/forms.jsx'), source('src/domain/operator-model.js'), source('src/components/Workspace.jsx'), source('src/styles.css'),
  ]);
  assert.match(forms, /useActionState/);
  assert.match(forms, /useOptimistic/);
  assert.match(forms, /role="log" aria-live="polite"/);
  assert.match(forms, /chatRef\.current\.scrollTop = chatRef\.current\.scrollHeight/);
  assert.match(forms, /latestMessage\?\.text/);
  assert.match(forms, /mode: 'auto'|defaultMode = 'auto'/);
  assert.match(forms, /!event\.nativeEvent\.isComposing/);
  assert.match(model, /goal\?\.ownerAnswers/);
  assert.match(model, /goal\?\.finalReport/);
  assert.match(model, /디렉터 최종 결론/);
  assert.match(css, /\.chat-message\.owner[\s\S]*grid-template-columns/);
  assert.match(css, /\.chat-copy[\s\S]*overflow-wrap: anywhere/);
});

test('Session status stays visible, activity opens on first run, and Alt+End follows nearest scroll owner', async () => {
  const [css, js] = await Promise.all([source('css/owner-console.css'), source('js/owner-console.js')]);
  assert.match(js, /collapsed: \{ 'active-goal': false, 'goal-queue': true, activity: false/);
  assert.match(js, /function nearestScrollSurface/);
  assert.match(js, /nearestScrollSurface\(document\.activeElement\)/);
  assert.match(js, /workflow-dialog'\)\.querySelector\('\.sheet-card'\)/);
  assert.match(css, /@media \(max-width: 1180px\)[\s\S]*#connection-state \{ display: none; \}/);
  assert.doesNotMatch(css, /\.topbar-actions \.signal:first-child \{ display: none; \}/);
  assert.doesNotMatch(css, /\.topbar-actions \.signal-copy \{ display: none; \}/);
});

test('Runtime management exposes WSL2 metadata, failures, and shell-specific recovery', async () => {
  const [js, css] = await Promise.all([source('js/owner-console.js'), source('css/owner-console.css')]);
  assert.match(js, /state\.wslError = result\.wslError \|\| null/);
  assert.match(js, /state\.runtimeProfileTotal = Number\.isInteger\(result\.profileTotal\)/);
  assert.match(js, /const hadSnapshot = state\.runtimesLoaded && state\.runtimes\.length > 0/);
  assert.match(js, /첫 진단을 백그라운드에서 진행 중/);
  assert.match(js, /state\.managementTab === 'runtimes'\) setManagementFeedback\(\)/);
  assert.match(js, /WSL 진단 실패/);
  assert.match(js, /target\.wslVersion === 1/);
  assert.match(js, /!target\.system && target\.wslVersion === 2/);
  assert.match(js, /target\.setupLabel/);
  assert.match(js, /<dt>배포판<\/dt>/);
  assert.match(css, /\.runtime-guide pre[\s\S]*overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.runtime-row \{ grid-template-columns: 44px minmax\(0, 1fr\)/);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.match(css, /\.panel-toggle\.icon i[\s\S]*border-right/);
});

test('Owner console persists collapse, sidebar size, workspace, detail, wave, and evidence view preferences', async () => {
  const js = await source('js/owner-console.js');
  assert.match(js, /praetorium-owner-console-ui-v4/);
  assert.match(js, /detailExpansion/);
  assert.match(js, /waveExpansion/);
  assert.match(js, /workerViews/);
  assert.match(js, /rawLogs/);
  assert.match(js, /workspaceView/);
  assert.match(js, /workspaceDirectorId/);
  assert.match(js, /initialWorkspaceTaskId/);
  assert.match(js, /sidebarWidth/);
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
  assert.match(js, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  assert.match(js, /tabindex="\$\{activeView === view \? 0 : -1\}"/);
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
  const [sidebar, css] = await Promise.all([source('src/components/Sidebar.jsx'), source('src/styles.css')]);
  assert.match(sidebar, /-webkit-line-clamp|goal\.objective/);
  assert.match(css, /--bg: #0d0f13/);
  assert.match(css, /--accent: #7c86f8/);
  assert.match(css, /\.goal-copy strong[\s\S]*-webkit-line-clamp: 2/);
  assert.match(css, /\.conclusion-preview strong[\s\S]*-webkit-line-clamp: 2/);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient/);
});

test('Owner console exposes a visible theme state and real light-theme tokens', async () => {
  const [app, css] = await Promise.all([source('src/App.jsx'), source('src/styles.css')]);
  assert.match(app, /praetorium\.theme/);
  assert.match(app, /document\.documentElement\.dataset\.theme = theme/);
  assert.match(app, /라이트 모드/);
  assert.match(css, /:root \{[\s\S]*color-scheme: dark/);
  assert.match(css, /:root\[data-theme="light"\]/);
  assert.match(css, /:root\[data-theme="light"\][\s\S]*--surface-1: #ffffff/);
});

test('Primary operational labels are shown in Korean while internal status keys stay stable', async () => {
  const [model, workspace, forms] = await Promise.all([
    source('src/domain/operator-model.js'), source('src/components/Workspace.jsx'), source('src/components/forms.jsx'),
  ]);
  for (const copy of ['대기', '실행 중', '판단 필요', '오너 판단', '검증']) assert.match(model, new RegExp(copy));
  for (const copy of ['디렉터 채팅', '오너 결정 필요', '공개 체크포인트', '명령·결과 원문']) assert.match(workspace, new RegExp(copy));
  for (const copy of ['Worker 위임', '답변만']) assert.match(forms, new RegExp(copy));
  for (const copy of ['접수됨', 'Worker 확인됨']) assert.match(model, new RegExp(copy));
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
  assert.match(css, /\.mission-context \{[\s\S]*flex-wrap: wrap/);
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

test('React console keeps durable history, scoped chat, completed Worker access, and operator alerts', async () => {
  const [app, hook, sidebar, workspace, notifications, notificationModel, css] = await Promise.all([
    source('src/App.jsx'), source('src/hooks/usePraetorium.js'), source('src/components/Sidebar.jsx'),
    source('src/components/Workspace.jsx'), source('src/hooks/useOperatorNotifications.js'),
    source('src/domain/notification-model.js'), source('src/styles.css'),
  ]);
  assert.match(hook, /\/goals\?\$\{query\}/);
  assert.match(hook, /\/messages\?\$\{query\}/);
  assert.match(sidebar, />History</);
  assert.match(sidebar, /이전 기록 더 보기/);
  assert.match(workspace, /channel-scope/);
  assert.match(workspace, /CompletedTasksMenu/);
  assert.match(workspace, /!terminalStates\.has\(task\.status\) \|\| activeTab ===/);
  assert.match(notifications, /!document\.hidden && document\.hasFocus\(\)/);
  assert.match(notifications, /show_operator_notification/);
  assert.match(notifications, /operator-notification-open/);
  assert.match(notifications, /summary\?\.notificationTasks/);
  assert.match(notificationModel, /deriveWorkerNotifications/);
  assert.match(notificationModel, /notificationGoals \|\|/);
  assert.match(app, /<NotificationCenter/);
  assert.match(css, /\.notification-panel/);
  assert.match(css, /\.topbar:has\(\.notification-panel\) \{ z-index: 80; \}/);
  assert.doesNotMatch(css, /@media \(max-width: 760px\) \{\n  \.operator-grid/);
  assert.match(hook, /preserve: true/);
  assert.match(hook, /\[\.\.\.dependencies, enabled\]/);
});
