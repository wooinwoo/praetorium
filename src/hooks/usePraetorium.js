import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';

const POLL_MS = 3000;
const terminalTaskStates = new Set(['done', 'completed', 'succeeded', 'success', 'blocked', 'archived', 'failed', 'cancelled']);

export function useStoredState(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initialValue : JSON.parse(stored);
    } catch {
      return initialValue;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* local preference only */ }
  }, [key, value]);
  return [value, setValue];
}

function directorGoals(summary, director, history = []) {
  if (!summary || !director) return [];
  const merged = new Map([...history, ...(summary.goals || [])].map(goal => [goal.id, goal]));
  return [...merged.values()]
    .filter(goal => goal.directorId === director.id
      || (director.kind === 'project' && goal.projectId && goal.projectId === director.projectId))
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
}

export function withFullRunOutputs(summary, outputs) {
  if (!summary?.recentRuns?.length || !outputs?.size) return summary;
  return {
    ...summary,
    recentRuns: summary.recentRuns.map(run => outputs.has(run.id)
      ? { ...run, output: outputs.get(run.id), outputTruncated: false }
      : run),
  };
}

export function runNeedsFullOutput(run, outputs) {
  const preview = run?.outputTruncated === true
    || (run?.outputTruncated == null && String(run?.output || '').endsWith('…'));
  return Boolean(preview && !outputs?.has(run.id));
}

function usePoll(load, dependencies, intervalMs = POLL_MS, enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let timer;
    const tick = async () => {
      await load(controller.signal).catch(() => {});
      if (!controller.signal.aborted) timer = window.setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  // load is required to be memoized by its owner.
  }, [...dependencies, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function usePraetorium({ taskPollingEnabled = true, projectMessagesEnabled = false } = {}) {
  const [selectedDirectorId, setSelectedDirectorId] = useStoredState('praetorium.director', '');
  const [selectedGoalId, setSelectedGoalId] = useStoredState('praetorium.goal', '');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [summary, setSummary] = useState(null);
  const [board, setBoard] = useState([]);
  const [boardStatus, setBoardStatus] = useState(null);
  const [goalDetail, setGoalDetail] = useState(null);
  const [taskDetail, setTaskDetail] = useState(null);
  const [taskTrace, setTaskTrace] = useState(null);
  const [goalSearch, setGoalSearch] = useState('');
  const [historyFilter, setHistoryFilter] = useState('all');
  const [goalHistory, setGoalHistory] = useState({ items: [], total: 0, nextOffset: 0, hasMore: false, loading: false, error: '' });
  const [projectMessages, setProjectMessages] = useState({ items: [], total: 0, nextOffset: 0, hasMore: false, loading: false, error: '' });
  const [errors, setErrors] = useState({});
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const summaryRequest = useRef(0);
  const taskRequest = useRef(0);
  const historyRequest = useRef(0);
  const messageRequest = useRef(0);
  const projectPageIds = useRef(new Set());
  const selectedGoalIdRef = useRef(selectedGoalId);
  const fullRunOutputs = useRef(new Map());
  selectedGoalIdRef.current = selectedGoalId;

  const selectedDirector = useMemo(
    () => summary?.directors?.find(item => item.id === selectedDirectorId) || summary?.directors?.[0] || null,
    [summary, selectedDirectorId],
  );
  const goals = useMemo(() => directorGoals(summary, selectedDirector, goalHistory.items), [summary, selectedDirector, goalHistory.items]);
  const selectedGoal = useMemo(
    () => goals.find(item => item.id === selectedGoalId) || goals[0] || null,
    [goals, selectedGoalId],
  );
  const selectedTaskStatus = taskDetail?.task?.id === selectedTaskId
    ? taskDetail.task.status
    : board.find(task => task.id === selectedTaskId)?.status;
  const taskEvidenceSettled = (terminalTaskStates.has(selectedTaskStatus) || summary?.terminalTaskStates?.includes(selectedTaskStatus))
    && taskDetail?.task?.id === selectedTaskId
    && taskTrace?.taskId === selectedTaskId;

  const loadSummary = useCallback(async signal => {
    const requestId = ++summaryRequest.current;
    try {
      const query = new URLSearchParams({ view: 'compact' });
      if (selectedDirectorId) query.set('directorId', selectedDirectorId);
      const next = await api(`/api/directors?${query}`, { signal });
      if (requestId !== summaryRequest.current) return;
      setSummary(withFullRunOutputs(next, fullRunOutputs.current));
      setLastSyncedAt(new Date());
      setErrors(current => ({ ...current, summary: null }));
      if (!selectedDirectorId || !next.directors?.some(item => item.id === selectedDirectorId)) {
        setSelectedDirectorId(next.selectedDirectorId || next.directors?.[0]?.id || '');
      }

      const clippedRuns = (next.recentRuns || []).filter(run => runNeedsFullOutput(run, fullRunOutputs.current));
      if (!clippedRuns.length) return;
      const details = await Promise.allSettled(clippedRuns.map(run => api(`/api/directors/runs/${encodeURIComponent(run.id)}`, { signal })));
      if (signal.aborted || requestId !== summaryRequest.current) return;
      const resolved = new Map();
      details.forEach((result, index) => {
        if (result.status !== 'fulfilled' || typeof result.value?.output !== 'string') return;
        const run = result.value;
        resolved.set(clippedRuns[index].id, run.output);
        if (!['queued', 'running'].includes(run.status)) fullRunOutputs.current.set(clippedRuns[index].id, run.output);
      });
      setSummary(current => withFullRunOutputs(current, resolved));
    } catch (error) {
      if (error.name !== 'AbortError') setErrors(current => ({ ...current, summary: error.message }));
      throw error;
    }
  }, [selectedDirectorId, setSelectedDirectorId, refreshToken]);
  usePoll(loadSummary, [loadSummary]);

  const fetchGoalHistory = useCallback(async ({ offset = 0, append = false, signal } = {}) => {
    if (!selectedDirector?.id) return;
    const requestId = ++historyRequest.current;
    setGoalHistory(current => ({ ...current, loading: true, error: '' }));
    try {
      const query = new URLSearchParams({
        offset: String(offset), limit: '24', query: goalSearch.trim(), filter: historyFilter,
      });
      const next = await api(`/api/directors/${encodeURIComponent(selectedDirector.id)}/goals?${query}`, { signal });
      if (requestId !== historyRequest.current || signal?.aborted) return;
      setGoalHistory(current => {
        let items = append
          ? [...new Map([...current.items, ...(next.items || [])].map(goal => [goal.id, goal])).values()]
          : (next.items || []);
        const selected = current.items.find(goal => goal.id === selectedGoalIdRef.current);
        if (!append && selected && !items.some(goal => goal.id === selected.id)) items = [selected, ...items];
        const nextOffset = Number.isFinite(Number(next.nextOffset))
          ? Number(next.nextOffset)
          : offset + (next.items || []).length;
        return { items, total: next.total || 0, nextOffset, hasMore: Boolean(next.hasMore), loading: false, error: '' };
      });
    } catch (error) {
      if (error.name !== 'AbortError' && requestId === historyRequest.current) {
        setGoalHistory(current => ({ ...current, loading: false, error: error.message }));
      }
    }
  }, [selectedDirector?.id, goalSearch, historyFilter]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void fetchGoalHistory({ signal: controller.signal }), 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [fetchGoalHistory]);

  const loadMoreGoals = useCallback(() => {
    if (goalHistory.loading || !goalHistory.hasMore) return;
    void fetchGoalHistory({ offset: goalHistory.nextOffset, append: true });
  }, [fetchGoalHistory, goalHistory.hasMore, goalHistory.loading, goalHistory.nextOffset]);

  const fetchProjectMessages = useCallback(async ({ offset = 0, append = false, preserve = false, signal } = {}) => {
    if (!selectedDirector?.id) return;
    const requestId = ++messageRequest.current;
    setProjectMessages(current => ({
      ...(append || preserve ? current : { items: [], total: 0, nextOffset: 0, hasMore: false }),
      loading: preserve ? current.loading : true,
      error: '',
    }));
    try {
      const query = new URLSearchParams({ offset: String(offset), limit: '20' });
      if (projectPageIds.current.size) query.set('known', [...projectPageIds.current].join(','));
      const next = await api(`/api/directors/${encodeURIComponent(selectedDirector.id)}/messages?${query}`, { signal });
      if (requestId !== messageRequest.current || signal?.aborted) return;
      const page = next.items || [];
      const pageIds = new Set(page.map(run => run.id));
      const removedIds = new Set(next.removedIds || []);
      if (!append) projectPageIds.current = pageIds;
      setProjectMessages(current => {
        const items = append
          ? [...new Map([...current.items, ...page].map(run => [run.id, run])).values()]
          : preserve
            ? [...page, ...current.items.filter(run => !pageIds.has(run.id) && !removedIds.has(run.id))]
            : page;
        const nextOffset = append
          ? Number.isFinite(Number(next.nextOffset)) ? Number(next.nextOffset) : offset + page.length
          : Math.max(current.nextOffset || 0, page.length);
        return { items, total: next.total || 0, nextOffset, hasMore: items.length < (next.total || 0), loading: false, error: '' };
      });
    } catch (error) {
      if (error.name !== 'AbortError' && requestId === messageRequest.current) {
        setProjectMessages(current => ({ ...current, loading: false, error: error.message }));
      }
    }
  }, [selectedDirector?.id, refreshToken]);

  const pollProjectMessages = useCallback(
    signal => fetchProjectMessages({ preserve: true, signal }),
    [fetchProjectMessages],
  );
  usePoll(pollProjectMessages, [pollProjectMessages], POLL_MS, projectMessagesEnabled);

  const loadMoreProjectMessages = useCallback(() => {
    if (projectMessages.loading || !projectMessages.hasMore) return;
    void fetchProjectMessages({ offset: projectMessages.nextOffset, append: true });
  }, [fetchProjectMessages, projectMessages.hasMore, projectMessages.loading, projectMessages.nextOffset]);

  useEffect(() => {
    if (!selectedGoalId || !goals.some(item => item.id === selectedGoalId)) {
      const active = goals.find(item => item.id === selectedDirector?.activeGoalId) || goals[0];
      setSelectedGoalId(active?.id || '');
    }
  }, [goals, selectedDirector, selectedGoalId, setSelectedGoalId]);

  const loadBoard = useCallback(async signal => {
    if (!selectedDirector?.id || !selectedDirector.cwd) {
      setBoard([]);
      setBoardStatus(null);
      return;
    }
    try {
      const next = await api(`/api/directors/${encodeURIComponent(selectedDirector.id)}/board`, { signal });
      setBoard(next.tasks || []);
      setBoardStatus(next.status || null);
      setErrors(current => ({ ...current, board: null }));
    } catch (error) {
      if (error.name !== 'AbortError') setErrors(current => ({ ...current, board: error.message }));
      throw error;
    }
  }, [selectedDirector?.id, selectedDirector?.cwd, refreshToken]);
  usePoll(loadBoard, [loadBoard]);

  const loadGoal = useCallback(async signal => {
    if (!selectedDirector?.id || !selectedGoal?.id) {
      setGoalDetail(null);
      return;
    }
    try {
      const next = await api(`/api/directors/${encodeURIComponent(selectedDirector.id)}/goals/${encodeURIComponent(selectedGoal.id)}`, { signal });
      setGoalDetail(next);
      setErrors(current => ({ ...current, goal: null }));
    } catch (error) {
      if (error.name !== 'AbortError') setErrors(current => ({ ...current, goal: error.message }));
      throw error;
    }
  }, [selectedDirector?.id, selectedGoal?.id, selectedGoal?.detailRevision, refreshToken]);
  usePoll(loadGoal, [loadGoal]);

  const loadTask = useCallback(async signal => {
    if (!taskPollingEnabled) return;
    if (taskEvidenceSettled) return;
    if (!selectedDirector?.id || !selectedTaskId) {
      setTaskDetail(null);
      setTaskTrace(null);
      return;
    }
    const requestId = ++taskRequest.current;
    const base = `/api/directors/${encodeURIComponent(selectedDirector.id)}/tasks/${encodeURIComponent(selectedTaskId)}`;
    const [details, trace] = await Promise.allSettled([api(base, { signal }), api(`${base}/trace`, { signal })]);
    if (requestId !== taskRequest.current || signal.aborted) return;
    if (details.status === 'fulfilled') {
      setTaskDetail(details.value);
      setErrors(current => ({ ...current, task: null }));
    } else if (details.reason?.name !== 'AbortError') {
      setErrors(current => ({ ...current, task: details.reason.message }));
    }
    if (trace.status === 'fulfilled') {
      setTaskTrace(trace.value);
      setErrors(current => ({ ...current, trace: null }));
    } else if (trace.reason?.name !== 'AbortError') {
      setErrors(current => ({ ...current, trace: trace.reason.message }));
    }
  }, [selectedDirector?.id, selectedTaskId, refreshToken, taskPollingEnabled, taskEvidenceSettled]);
  usePoll(loadTask, [loadTask, taskPollingEnabled], 5000, taskPollingEnabled);

  const refresh = useCallback(() => setRefreshToken(value => value + 1), []);
  const selectDirector = useCallback(id => {
    taskRequest.current += 1;
    setSelectedDirectorId(id);
    setSelectedGoalId('');
    setSelectedTaskId('');
    setBoard([]);
    setGoalDetail(null);
    setTaskDetail(null);
    setTaskTrace(null);
    setGoalHistory({ items: [], total: 0, nextOffset: 0, hasMore: false, loading: false, error: '' });
    setProjectMessages({ items: [], total: 0, nextOffset: 0, hasMore: false, loading: false, error: '' });
    projectPageIds.current = new Set();
  }, [setSelectedDirectorId, setSelectedGoalId]);
  const selectGoal = useCallback(id => {
    taskRequest.current += 1;
    setSelectedGoalId(id);
    setSelectedTaskId('');
    setGoalDetail(null);
    setTaskDetail(null);
    setTaskTrace(null);
  }, [setSelectedGoalId]);
  const revealGoal = useCallback(async id => {
    if (!id || !selectedDirector?.id) return false;
    if (!goals.some(goal => goal.id === id)) {
      try {
        const goal = await api(`/api/directors/${encodeURIComponent(selectedDirector.id)}/goals/${encodeURIComponent(id)}`);
        if (!goal?.id) return false;
        setGoalHistory(current => ({ ...current, items: [...new Map([[goal.id, goal], ...current.items.map(item => [item.id, item])]).values()] }));
      } catch (error) {
        setErrors(current => ({ ...current, goal: error.message }));
        return false;
      }
    }
    selectGoal(id);
    return true;
  }, [goals, selectGoal, selectedDirector?.id]);
  const selectTask = useCallback(id => {
    taskRequest.current += 1;
    setSelectedTaskId(id);
    setTaskDetail(null);
    setTaskTrace(null);
    setErrors(current => ({ ...current, task: null, trace: null }));
  }, []);

  return {
    summary, board, boardStatus, goalDetail, taskDetail, taskTrace, errors, lastSyncedAt,
    selectedDirector, selectedDirectorId, selectedGoal, selectedGoalId, selectedTaskId, goals,
    goalSearch, setGoalSearch, historyFilter, setHistoryFilter, goalHistory, loadMoreGoals,
    projectMessages, loadMoreProjectMessages,
    selectDirector, selectGoal, revealGoal, selectTask, refresh,
  };
}
