import { useCallback, useEffect, useRef, useState } from 'react';

const EVENT_TYPES = ['ready', 'run', 'goal', 'output', 'tick', 'resync'];
const MAX_ACTIVITY_EVENTS = 120;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function directorActivityMessage(type, envelope = {}) {
  const activity = envelope.activity || {};
  const checkpoint = activity.checkpoint;
  if (checkpoint?.message) return checkpoint.message;
  if (type === 'run') {
    const phase = activity.phase || activity.status || '준비';
    return `Director 단계 · ${String(phase).replaceAll('_', ' ')}`;
  }
  if (type === 'goal') {
    if (activity.ownerActionRequired) return 'Owner 결정이 필요합니다.';
    const phase = activity.phase || activity.status || '동기화';
    return `Goal 상태 · ${String(phase).replaceAll('_', ' ')}`;
  }
  if (type === 'output') {
    const characters = finite(activity.chunkCharacters);
    return characters == null ? 'Director 응답을 수신하고 있습니다.' : `Director 응답 수신 · ${characters.toLocaleString()}자`;
  }
  if (type === 'tick') {
    const parts = [
      finite(activity.running) == null ? '' : `실행 ${activity.running}`,
      finite(activity.ready) == null ? '' : `대기 ${activity.ready}`,
      finite(activity.spawnedCount) ? `신규 ${activity.spawnedCount}` : '',
      activity.awaitingOwner ? 'Owner 결정 대기' : '',
    ].filter(Boolean);
    return parts.length ? `감독 동기화 · ${parts.join(' · ')}` : '감독 상태를 동기화했습니다.';
  }
  if (type === 'resync') return `실시간 이벤트 ${finite(envelope.droppedEvents) || 0}개 누락 · 전체 상태 재동기화`;
  return '실시간 활동 스트림을 연결했습니다.';
}

function activityTone(type, envelope) {
  const status = envelope?.activity?.status;
  if (type === 'resync' || ['failed', 'error'].includes(status)) return 'failed';
  if (envelope?.activity?.ownerActionRequired || status === 'awaiting_owner') return 'attention';
  if (['completed', 'done', 'success', 'succeeded'].includes(status)) return 'done';
  return type === 'ready' ? 'idle' : 'running';
}

function normalize(type, envelope) {
  return {
    id: `${type}:${envelope.sequence ?? 'ready'}:${envelope.runId || envelope.goalId || envelope.at || Date.now()}`,
    type,
    at: envelope.at || new Date().toISOString(),
    runId: envelope.runId || null,
    goalId: envelope.goalId || null,
    phase: envelope.activity?.phase || envelope.activity?.supervisionState || envelope.activity?.status || type,
    message: directorActivityMessage(type, envelope),
    tone: activityTone(type, envelope),
    raw: envelope,
  };
}

export function useDirectorActivity({ directorId, enabled = true, onRefresh } = {}) {
  const [state, setState] = useState({ connected: false, events: [], lastEventAt: null, error: '' });
  const refreshRef = useRef(onRefresh);
  const outputTimer = useRef(null);
  const pendingOutput = useRef(null);
  const refreshTimer = useRef(null);
  const refreshMode = useRef(null);
  refreshRef.current = onRefresh;

  const append = useCallback((type, envelope) => {
    const item = normalize(type, envelope);
    setState(current => {
      const previous = current.events.at(-1);
      const replaceOutput = type === 'output' && previous?.type === 'output' && previous.runId === item.runId;
      const events = replaceOutput
        ? [...current.events.slice(0, -1), item]
        : [...current.events, item].slice(-MAX_ACTIVITY_EVENTS);
      return { connected: true, events, lastEventAt: item.at, error: '' };
    });
  }, []);

  useEffect(() => {
    if (!directorId || !enabled || typeof EventSource === 'undefined') {
      setState(current => enabled
        ? { connected: false, events: [], lastEventAt: null, error: directorId ? '이 환경은 실시간 스트림을 지원하지 않습니다.' : '' }
        : { ...current, connected: false, error: '' });
      return undefined;
    }
    setState({ connected: false, events: [], lastEventAt: null, error: '' });
    const source = new EventSource(`/api/directors/${encodeURIComponent(directorId)}/activity`);
    const scheduleRefresh = mode => {
      refreshMode.current = mode === 'full' || refreshMode.current === 'full' ? 'full' : 'summary';
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        const selectedMode = refreshMode.current;
        refreshMode.current = null;
        refreshRef.current?.(selectedMode);
      }, refreshMode.current === 'full' ? 0 : 140);
    };
    const listeners = new Map();
    for (const type of EVENT_TYPES) {
      const listener = event => {
        let envelope;
        try { envelope = JSON.parse(event.data); }
        catch { return; }
        if (envelope.directorId && envelope.directorId !== directorId) return;
        if (type === 'output') {
          pendingOutput.current = envelope;
          if (!outputTimer.current) {
            outputTimer.current = window.setTimeout(() => {
              outputTimer.current = null;
              if (pendingOutput.current) append('output', pendingOutput.current);
              pendingOutput.current = null;
            }, 180);
          }
          return;
        }
        append(type, envelope);
        if (type === 'ready' || type === 'resync') scheduleRefresh('full');
        else scheduleRefresh('summary');
      };
      listeners.set(type, listener);
      source.addEventListener(type, listener);
    }
    source.onopen = () => setState(current => ({ ...current, connected: true, error: '' }));
    source.onerror = () => setState(current => ({ ...current, connected: false, error: '실시간 연결을 다시 시도하고 있습니다.' }));
    return () => {
      for (const [type, listener] of listeners) source.removeEventListener(type, listener);
      source.close();
      window.clearTimeout(outputTimer.current);
      window.clearTimeout(refreshTimer.current);
      outputTimer.current = null;
      refreshTimer.current = null;
      refreshMode.current = null;
      pendingOutput.current = null;
    };
  }, [append, directorId, enabled]);

  return state;
}
