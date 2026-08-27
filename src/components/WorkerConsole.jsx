import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../lib/api.js';
import {
  interventionReceiptText, taskDisplayStatus, taskIsTerminal, taskPausedByOwner, textValue,
} from '../domain/operator-model.js';
import { DirectorGuidance, WorkerIntervention } from './forms.jsx';
import { ErrorNotice, formatClock, Icon, relativeTime, Status, statusText } from './common.jsx';

const EVIDENCE_PAGE_SIZE = 20;
const MAX_STREAM_BUFFER = 2_000_000;
const MAX_TERMINAL_WRITE_CHUNK = 64_000;

// xterm is a read-only renderer here, not a PTY. Preserve visual SGR colour/style
// while removing terminal capabilities that can mutate title, clipboard or device state.
export function sanitizeTerminalOutput(value) {
  const allowedSgrParameters = new Set([
    0, 1, 3, 4, 22, 23, 24, 31, 32, 33, 34, 35, 36, 37, 39, 91, 92, 93, 94, 95, 96, 97,
  ]);
  return String(value ?? '')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x9d[\s\S]*?(?:\x07|\x9c|$)/g, '')
    .replace(/\x1bP[\s\S]*?(?:\x1b\\|$)/g, '')
    .replace(/\x90[\s\S]*?(?:\x9c|$)/g, '')
    .replace(/\x1b(?:X|\^|_)[\s\S]*?(?:\x1b\\|$)/g, '')
    .replace(/[\x98\x9e\x9f][\s\S]*?(?:\x9c|$)/g, '')
    .replace(/\x9b[0-?]*[ -/]*(?:[@-~]|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-ln-~]/g, '')
    .replace(/\x1b\[([0-?]*[ -/]*)m/g, (_match, parameterText) => {
      if (!/^(?:\d{0,3})(?:;\d{0,3})*$/.test(parameterText)) return '';
      const parameters = (parameterText || '0').split(';').map(part => Number(part || 0));
      if (parameters.some(parameter => !allowedSgrParameters.has(parameter))) return '';
      return `\x1b[${parameters.join(';')}m`;
    })
    .replace(/\x1b\[[0-?]*[ -/]*$/g, '')
    .replace(/\x1b(?!\[)(?:[ -/]*[@-~])?/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f]/g, '');
}

function decodeEvent(event) {
  try { return JSON.parse(event.data); }
  catch { return { text: event.data || '' }; }
}

function payloadText(payload, append = false) {
  if (typeof payload === 'string') return payload;
  const fields = append ? ['chunk', 'text', 'data', 'log'] : ['log', 'text', 'chunk', 'data'];
  for (const field of fields) if (typeof payload?.[field] === 'string') return payload[field];
  return '';
}

function streamAge(observedAt) {
  return observedAt ? `출력 ${relativeTime(observedAt)}` : '출력 대기';
}

function receiptState(record) {
  const receipt = record?.interventions?.at(-1);
  return receipt ? interventionReceiptText(receipt) : '지시 없음';
}

function terminalFontSize() {
  const scale = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
  return Math.max(12, Math.min(17, 13 * scale));
}

function EvidenceDrawer({ task, detail, displayStatus, onToggle }) {
  const drawerRef = useRef(null);
  const [commentLimit, setCommentLimit] = useState(EVIDENCE_PAGE_SIZE);
  const [eventLimit, setEventLimit] = useState(EVIDENCE_PAGE_SIZE);
  useEffect(() => {
    if (drawerRef.current) drawerRef.current.open = false;
    setCommentLimit(EVIDENCE_PAGE_SIZE);
    setEventLimit(EVIDENCE_PAGE_SIZE);
  }, [task?.id]);

  const raw = detail?.task || task;
  const allComments = Array.isArray(detail?.comments) ? detail.comments : [];
  const allEvents = Array.isArray(detail?.events) ? detail.events : [];
  const comments = allComments.slice(-commentLimit);
  const events = allEvents.slice(-eventLimit);
  const omittedComments = Math.max(0, allComments.length - comments.length);
  const omittedEvents = Math.max(0, allEvents.length - events.length);
  const runs = detail?.runs || [];
  const latestSummary = detail?.latest_summary || detail?.latestSummary || raw?.summary;
  const validation = detail?.validation || raw?.validation || runs.at(-1)?.validation || null;
  const validationSummary = textValue(validation?.summary || validation?.report || validation?.result || validation);
  const finalEvidence = detail?.report || raw?.report || raw?.result || runs.at(-1)?.report
    || runs.at(-1)?.output || runs.at(-1)?.result || latestSummary || validationSummary;
  const count = allComments.length + allEvents.length + (finalEvidence ? 1 : 0);

  return <details ref={drawerRef} className="worker-evidence-drawer" onToggle={onToggle}>
    <summary aria-label="Worker 근거 열기"><Icon name="panel" /><span>근거</span>{count > 0 && <b>{count}</b>}</summary>
    <aside className="worker-evidence-drawer-body" aria-label="Worker 공개 근거">
      <header><span><strong>공개 근거</strong><small>Worker가 외부화한 기록</small></span><Status value={displayStatus} /></header>
      <section className="worker-terminal-summary">
        <strong>현재 체크포인트</strong>
        <p>{textValue(latestSummary || raw?.checkpoint || raw?.description) || '아직 Worker가 외부화한 체크포인트가 없습니다.'}</p>
        <dl><div><dt>시작</dt><dd>{task?.started_at || task?.startedAt ? `${formatClock(task.started_at || task.startedAt)} · ${relativeTime(task.started_at || task.startedAt)}` : '아직 시작하지 않음'}</dd></div><div><dt>담당</dt><dd>{task?.assignee || task?.profile || '미배정'}</dd></div></dl>
      </section>
      <section><header className="section-title"><span><Icon name="message" />공개 체크포인트</span><small>{comments.length} / {allComments.length}</small></header><div className="evidence-list">{omittedComments > 0 && <button type="button" className="evidence-more" onClick={() => setCommentLimit(limit => limit + EVIDENCE_PAGE_SIZE)}>이전 {Math.min(EVIDENCE_PAGE_SIZE, omittedComments)}개 보기</button>}{comments.map((comment, index) => { const at = comment.createdAt || comment.created_at || comment.at; return <article key={comment.id || `${at}:${index}`}><header><strong>{comment.author || 'Worker'}</strong><time dateTime={at || undefined}>{formatClock(at)}</time></header><p>{textValue(comment.body || comment.message || comment)}</p></article>; })}{!comments.length && <p className="evidence-empty">공개 체크포인트가 아직 없습니다.</p>}</div></section>
      <section><header className="section-title"><span><Icon name="activity" />수명주기 증거</span><small>{events.length} / {allEvents.length}</small></header><div className="evidence-list">{omittedEvents > 0 && <button type="button" className="evidence-more" onClick={() => setEventLimit(limit => limit + EVIDENCE_PAGE_SIZE)}>이전 {Math.min(EVIDENCE_PAGE_SIZE, omittedEvents)}개 보기</button>}{events.map((event, index) => { const at = event.createdAt || event.created_at || event.at; return <article key={event.id || `${at}:${index}`}><header><strong>{statusText(event.status || event.phase || event.type || event.kind)}</strong><time dateTime={at || undefined}>{formatClock(at)}</time></header><p>{textValue(event.message || event.details || event.payload || event)}</p></article>; })}{!events.length && <p className="evidence-empty">수명주기 이벤트가 아직 없습니다.</p>}</div></section>
      <section className="final-evidence"><header className="section-title"><span><Icon name="check" />최종 결과·검증</span><small>{runs.length ? `${runs.length} runs` : ''}</small></header><p>{textValue(finalEvidence) || '최종 결과나 구조화 검증이 아직 없습니다.'}</p>{validation && <div className="validation-evidence"><strong>구조화 검증</strong>{validationSummary && <p>{validationSummary}</p>}<details><summary>검증 원문 보기</summary><pre>{typeof validation === 'string' ? validation : JSON.stringify(validation, null, 2)}</pre></details></div>}</section>
    </aside>
  </details>;
}

export default function WorkerConsole({ directorId, goalId, task, detail, trace, detailError, traceError, onRefresh }) {
  const terminalHostRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const rawLogRef = useRef('');
  const renderedLogRef = useRef('');
  const desiredLogRef = useRef('');
  const terminalWritePendingRef = useRef(false);
  const terminalForceResetRef = useRef(false);
  const followLogRef = useRef(true);
  const fallbackLogRef = useRef('');
  const sseInitializedRef = useRef(false);
  const [terminalReady, setTerminalReady] = useState(false);
  const [followLog, setFollowLog] = useState(true);
  const [streamState, setStreamState] = useState('fallback');
  const [streamStatus, setStreamStatus] = useState(null);
  const [streamObservedAt, setStreamObservedAt] = useState(null);
  const [mode, setMode] = useState('observe');
  const [controlRequest, setControlRequest] = useState('');
  const [controlError, setControlError] = useState('');

  const record = detail?.praetoriumRecord;
  const observedTask = {
    ...task,
    status: record?.status || task?.status,
    pausedByOwner: record?.pausedByOwner ?? task?.pausedByOwner,
    pausePending: record?.pausePending ?? task?.pausePending,
    resumePending: record?.resumePending ?? task?.resumePending,
  };
  const displayStatus = taskDisplayStatus(observedTask, record);
  const pausedByOwner = taskPausedByOwner(observedTask, record);
  const workerTerminal = taskIsTerminal(observedTask, record);
  const pausePending = Boolean(observedTask.pausePending || controlRequest === 'pause');
  const resumePending = Boolean(observedTask.resumePending || controlRequest === 'resume');
  const controlAction = observedTask.status === 'running' && !pausePending ? 'pause' : pausedByOwner && !resumePending ? 'resume' : null;
  const controlLabel = pausePending ? '정지 요청 중' : resumePending ? '재개 요청 중' : pausedByOwner ? 'Owner가 일시정지' : workerTerminal ? '실행 종료' : 'Director 관리';
  const fallbackLog = trace?.log || (trace?.availability === 'not_started' ? 'Worker 실행 전 · 출력 없음' : '실행 출력을 불러오는 중…');
  fallbackLogRef.current = fallbackLog;
  const effectiveObservedAt = streamObservedAt || trace?.observedAt;

  const flushTerminal = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal || terminalWritePendingRef.current) return;
    const desired = desiredLogRef.current;
    let previous = renderedLogRef.current;
    if (terminalForceResetRef.current || !desired.startsWith(previous)) {
      terminal.reset();
      terminalForceResetRef.current = false;
      renderedLogRef.current = '';
      previous = '';
    }
    const chunk = desired.slice(previous.length, previous.length + MAX_TERMINAL_WRITE_CHUNK);
    if (!chunk) {
      if (followLogRef.current) terminal.scrollToBottom();
      return;
    }
    terminalWritePendingRef.current = true;
    const currentTerminal = terminal;
    terminal.write(chunk, () => {
      if (terminalRef.current !== currentTerminal) return;
      renderedLogRef.current = `${previous}${chunk}`;
      terminalWritePendingRef.current = false;
      if (followLogRef.current) currentTerminal.scrollToBottom();
      flushTerminal();
    });
  }, []);

  const renderLog = useCallback((raw, forceReset = false) => {
    rawLogRef.current = String(raw || '').slice(-MAX_STREAM_BUFFER);
    const safe = sanitizeTerminalOutput(rawLogRef.current);
    if (forceReset || !safe.startsWith(renderedLogRef.current)) terminalForceResetRef.current = true;
    desiredLogRef.current = safe;
    flushTerminal();
  }, [flushTerminal]);

  const appendLog = useCallback(chunk => {
    renderLog(`${rawLogRef.current}${String(chunk || '')}`);
  }, [renderLog]);

  useEffect(() => {
    if (!terminalHostRef.current) return undefined;
    const fit = new FitAddon();
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      drawBoldTextInBrightColors: false,
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: terminalFontSize(),
      lineHeight: 1.35,
      scrollback: 5000,
      screenReaderMode: true,
      theme: {
        background: '#0b0d11', foreground: '#b8c0cc', cursor: '#0b0d11', selectionBackground: '#4957a755',
        black: '#151922', red: '#ef7d7d', green: '#73d29d', yellow: '#e3bf75', blue: '#7f91f3',
        magenta: '#c999e9', cyan: '#71c5d7', white: '#d7dce5', brightBlack: '#657080', brightWhite: '#f4f6fa',
      },
    });
    terminal.loadAddon(fit);
    terminal.open(terminalHostRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const scrollDisposable = terminal.onScroll(viewportY => {
      const following = viewportY >= terminal.buffer.active.baseY - 1;
      followLogRef.current = following;
      setFollowLog(following);
    });
    const resizeObserver = new ResizeObserver(() => { try { fit.fit(); } catch { /* host can be between layouts */ } });
    resizeObserver.observe(terminalHostRef.current);
    const scaleObserver = new MutationObserver(() => {
      terminal.options.fontSize = terminalFontSize();
      requestAnimationFrame(() => { try { fit.fit(); } catch { /* scale can change during layout */ } });
    });
    scaleObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    requestAnimationFrame(() => { try { fit.fit(); } catch { /* first layout may not be ready */ } });
    setTerminalReady(true);
    return () => {
      resizeObserver.disconnect();
      scaleObserver.disconnect();
      scrollDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      terminalWritePendingRef.current = false;
    };
  }, []);

  useEffect(() => {
    setMode('observe');
    setControlRequest('');
    setControlError('');
    setStreamState('fallback');
    setStreamStatus(null);
    setStreamObservedAt(null);
    sseInitializedRef.current = false;
    followLogRef.current = true;
    setFollowLog(true);
    rawLogRef.current = '';
    desiredLogRef.current = '';
    terminalForceResetRef.current = true;
    flushTerminal();
  }, [flushTerminal, task?.id]);

  useEffect(() => {
    if (controlRequest === 'pause' && (task?.pausePending || record?.pausePending || pausedByOwner)) setControlRequest('');
    if (controlRequest === 'resume' && (task?.resumePending || record?.resumePending || !pausedByOwner)) setControlRequest('');
  }, [controlRequest, pausedByOwner, record?.pausePending, record?.resumePending, task?.pausePending, task?.resumePending]);

  useEffect(() => {
    if (!terminalReady || streamState === 'live') return;
    renderLog(fallbackLog);
  }, [fallbackLog, renderLog, streamState, terminalReady]);

  useEffect(() => {
    if (!directorId || !task?.id || typeof EventSource === 'undefined') {
      setStreamState('fallback');
      return undefined;
    }
    const url = `/api/directors/${encodeURIComponent(directorId)}/tasks/${encodeURIComponent(task.id)}/trace-stream`;
    const source = new EventSource(url);
    sseInitializedRef.current = false;
    const snapshot = event => {
      const payload = decodeEvent(event);
      sseInitializedRef.current = true;
      setStreamState('live');
      setStreamObservedAt(payload.observedAt || payload.at || new Date().toISOString());
      renderLog(payloadText(payload), true);
    };
    const append = event => {
      const payload = decodeEvent(event);
      if (!sseInitializedRef.current) {
        sseInitializedRef.current = true;
        rawLogRef.current = '';
        renderedLogRef.current = '';
        terminalRef.current?.reset();
      }
      setStreamState('live');
      setStreamObservedAt(payload.observedAt || payload.at || new Date().toISOString());
      appendLog(payloadText(payload, true));
    };
    const reset = event => {
      const payload = decodeEvent(event);
      sseInitializedRef.current = true;
      setStreamState('live');
      setStreamObservedAt(payload.observedAt || payload.at || new Date().toISOString());
      renderLog(payloadText(payload), true);
    };
    const status = event => {
      const payload = decodeEvent(event);
      const availability = payload.error ? 'error' : payload.availability || payload.state || null;
      const unavailable = ['error', 'unavailable'].includes(availability);
      setStreamState(unavailable ? 'fallback' : 'live');
      setStreamStatus(availability);
      setStreamObservedAt(payload.observedAt || payload.at || new Date().toISOString());
      if (unavailable) renderLog(fallbackLogRef.current, true);
    };
    source.addEventListener('snapshot', snapshot);
    source.addEventListener('append', append);
    source.addEventListener('reset', reset);
    source.addEventListener('status', status);
    source.onopen = () => setStreamState('connecting');
    source.onerror = () => {
      setStreamState('fallback');
      renderLog(fallbackLogRef.current, true);
    };
    return () => source.close();
  }, [appendLog, directorId, renderLog, task?.id]);

  const requestControl = async action => {
    setControlRequest(action);
    setControlError('');
    try {
      await api(`/api/directors/${encodeURIComponent(directorId)}/tasks/${encodeURIComponent(task.id)}/control`, {
        method: 'POST', body: { action, reason: `Owner가 Worker Console에서 ${action === 'pause' ? '일시정지' : '재개'}를 요청했습니다.` },
      });
      await onRefresh?.();
    } catch (error) {
      setControlRequest('');
      setControlError(error.message);
    }
  };

  const streamLabel = traceError || streamState === 'fallback' ? '스냅샷'
    : streamState === 'connecting' ? '연결 중'
      : streamStatus === 'not_started' ? '실행 전'
        : streamStatus === 'error' || streamStatus === 'unavailable' ? '스트림 오류' : '실시간';
  const modeDescription = mode === 'observe' ? '입력 없는 읽기 전용 실행 출력입니다.'
    : mode === 'worker' ? '현재 작업 범위 안의 보정을 영속 기록 후 Worker에게 전달합니다.'
      : '목표·완료조건 충돌 여부를 Director가 판단하고 필요하면 재계획합니다.';
  const onDrawerToggle = () => requestAnimationFrame(() => { try { fitRef.current?.fit(); } catch { /* drawer transition */ } });

  if (!task) return <div className="workspace-empty"><strong>Worker를 선택하세요.</strong><span>현황이나 상단 Worker 탭에서 작업을 여세요.</span></div>;

  return <section className="worker-console">
    <header className="worker-console-header">
      <span className="worker-glyph"><Icon name="command" /></span>
      <span className="worker-console-title"><small>{task.assignee || task.profile || 'WORKER'}</small><h1>{task.title}</h1></span>
      <div className="worker-console-axes" aria-label="Worker 실행 상태">
        <span><small>실행</small><Status value={displayStatus} /></span>
        <span className={`axis-stream ${streamState}`}><small>스트림</small><strong><i />{streamLabel}</strong></span>
        <span className={pausePending || resumePending || pausedByOwner ? 'attention' : ''}><small>제어</small><strong>{controlLabel}</strong></span>
        <span><small>지시 영수증</small><strong title={receiptState(record)}>{receiptState(record)}</strong></span>
      </div>
      <div className="worker-console-actions">
        <small>{streamAge(effectiveObservedAt)}</small>
        {!followLog && <button type="button" className="text-button compact" onClick={() => { followLogRef.current = true; setFollowLog(true); terminalRef.current?.scrollToBottom(); }}>최신 출력</button>}
        {controlAction && <button type="button" className="secondary-button compact" disabled={Boolean(controlRequest)} onClick={() => requestControl(controlAction)}>{controlAction === 'pause' ? '일시정지' : '재개'}</button>}
        {(pausePending || resumePending) && <button type="button" className="secondary-button compact" disabled>{pausePending ? '정지 확인 대기' : '재개 확인 대기'}</button>}
      </div>
    </header>
    {detailError && <ErrorNotice title="Worker 상세 동기화 실패" onRetry={onRefresh}>{detailError}</ErrorNotice>}
    {controlError && <p className="worker-control-error form-error" role="alert">{controlError}</p>}
    <div className="worker-console-main">
      <section className="worker-output" aria-label="Worker 실행 출력">
        <header><span><Icon name="terminal" /><strong>실시간 출력</strong><em>읽기 전용 · PTY 아님</em></span><span>{traceError && <small role="alert">실시간 스트림 오류 · 저장된 스냅샷 표시</small>}<small>{followLog ? '최신 출력 따라가는 중' : '과거 출력 보는 중'}</small></span></header>
        <div ref={terminalHostRef} className="worker-xterm" aria-label="읽기 전용 Worker 로그" />
        <footer className={`worker-control-dock mode-${mode}`}>
          <div className="worker-control-mode" role="tablist" aria-label="Worker 제어 모드">
            <button type="button" role="tab" aria-selected={mode === 'observe'} className={mode === 'observe' ? 'selected' : ''} onClick={() => setMode('observe')}><Icon name="activity" />관찰</button>
            <button type="button" role="tab" aria-selected={mode === 'worker'} className={mode === 'worker' ? 'selected' : ''} disabled={workerTerminal} onClick={() => setMode('worker')}><Icon name="command" />Worker 보정</button>
            <button type="button" role="tab" aria-selected={mode === 'director'} className={mode === 'director' ? 'selected' : ''} disabled={!goalId || workerTerminal} onClick={() => setMode('director')}><span className="tab-avatar">D</span>Director 경유</button>
            <small>{modeDescription}</small>
          </div>
          {mode === 'worker' && <WorkerIntervention key={task.id} directorId={directorId} taskId={task.id} disabled={workerTerminal} onAccepted={onRefresh} />}
          {mode === 'director' && <DirectorGuidance key={`${goalId}:${task.id}`} directorId={directorId} goalId={goalId} taskId={task.id} taskTitle={task.title} disabled={!goalId || workerTerminal} onAccepted={onRefresh} />}
        </footer>
      </section>
      <EvidenceDrawer task={task} detail={detail} displayStatus={displayStatus} onToggle={onDrawerToggle} />
    </div>
  </section>;
}
