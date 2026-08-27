import { Component, useCallback, useEffect, useRef, useState } from 'react';
import NotificationCenter from './components/NotificationCenter.jsx';
import Sidebar from './components/Sidebar.jsx';
import Settings from './components/Settings.jsx';
import Workspace from './components/Workspace.jsx';
import { Icon, Splitter, Status } from './components/common.jsx';
import { usePraetorium, useStoredState } from './hooks/usePraetorium.js';
import { useOperatorNotifications } from './hooks/useOperatorNotifications.js';

class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <main className="fatal-error"><strong>화면을 표시하지 못했습니다.</strong><p>{this.state.error.message}</p><button type="button" onClick={() => location.reload()}>앱 다시 불러오기</button></main>;
  }
}

function navigationFromLocation() {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const directorId = params.get('directorId');
  const goalId = params.get('goalId');
  const taskId = params.get('taskId');
  if (!directorId && !goalId && !taskId) return null;
  return { directorId, goalId, taskId, kind: taskId ? 'worker' : 'goal' };
}

function AppShell() {
  const data = usePraetorium({
    taskPollingEnabled: true,
    projectMessagesEnabled: true,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useStoredState('praetorium.theme', 'dark');
  const [scale, setScale] = useStoredState('praetorium.scale', 1);
  const [railWidth, setRailWidth] = useStoredState('praetorium.railWidth', 248);
  const [workerRoomWidth, setWorkerRoomWidth] = useStoredState('praetorium.workerRoomWidth', 620);
  const [inspectorWidth, setInspectorWidth] = useStoredState('praetorium.inspectorWidth', 312);
  const [activityHeight, setActivityHeight] = useStoredState('praetorium.activityHeight', 112);
  const [inspectorOpen, setInspectorOpen] = useStoredState('praetorium.inspectorOpen', false);
  const [pendingNavigation, setPendingNavigation] = useState(navigationFromLocation);
  const pendingGoalRequest = useRef('');

  const openNotification = useCallback(item => {
    if (['connection_lost', 'runtime_error'].includes(item.kind)) {
      setSettingsOpen(true);
      return;
    }
    setPendingNavigation(item);
    if (item.directorId && item.directorId !== data.selectedDirectorId) data.selectDirector(item.directorId);
  }, [data.selectDirector, data.selectedDirectorId]);
  const notifications = useOperatorNotifications({
    summary: data.summary,
    summaryError: data.errors.summary,
    runtimeError: data.errors.board || data.boardStatus?.error,
    onNavigate: openNotification,
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty('--ui-scale', String(scale));
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d0f13' : '#f4f5f7');
  }, [theme, scale]);
  useEffect(() => {
    if (pendingNavigation?.directorId && pendingNavigation.directorId !== data.selectedDirectorId) {
      data.selectDirector(pendingNavigation.directorId);
    }
  }, [data.selectDirector, data.selectedDirectorId, pendingNavigation]);
  useEffect(() => {
    if (!pendingNavigation || (pendingNavigation.directorId && pendingNavigation.directorId !== data.selectedDirectorId)) return;
    if (pendingNavigation.goalId && pendingNavigation.goalId !== data.selectedGoalId) {
      const requestKey = `${data.selectedDirectorId}:${pendingNavigation.goalId}`;
      if (pendingGoalRequest.current === requestKey) return;
      pendingGoalRequest.current = requestKey;
      void data.revealGoal(pendingNavigation.goalId).then(opened => {
        if (!opened) {
          pendingGoalRequest.current = '';
          setPendingNavigation(null);
        }
      });
      return;
    }
    pendingGoalRequest.current = '';
    setPendingNavigation(null);
    if (pendingNavigation.taskId) {
      data.selectTask(pendingNavigation.taskId);
    }
  }, [data.revealGoal, data.selectTask, data.selectedDirectorId, data.selectedGoalId, pendingNavigation]);

  const projectName = data.selectedDirector?.name || 'Praetorium';
  const sessionCount = data.summary?.sessions?.total || 0;
  const connected = !data.errors.summary && Boolean(data.summary);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  return <div className="app-shell" style={{ '--rail-width': `${railWidth}px`, '--inspector-width': `${inspectorWidth}px` }}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Icon name="layers" size={18} /></span><strong>PRAETORIUM</strong><span className="brand-divider" /><span className="breadcrumb"><b>{projectName}</b><small>{data.selectedDirector?.runtime === 'wsl' ? `WSL · ${data.selectedDirector.distro || 'Ubuntu'}` : 'Local'}</small></span></div>
      <div className="topbar-actions">
        <span className={`connection ${connected ? 'online' : 'offline'}`}><i />{connected ? '로컬 연결' : '연결 끊김'}</span>
        {sessionCount > 0 && <span className="session-state" title="현재 실행 프로세스 세션"><Icon name="activity" /><b>{sessionCount}</b> 세션</span>}
        <div className="scale-control" aria-label="화면 글자 크기"><button type="button" onClick={() => setScale(value => Math.max(.9, +(value - .05).toFixed(2)))} aria-label="글자 축소">−</button><button type="button" onClick={() => setScale(1)} title="100%로 초기화">{Math.round(scale * 100)}%</button><button type="button" onClick={() => setScale(value => Math.min(1.25, +(value + .05).toFixed(2)))} aria-label="글자 확대">+</button></div>
        <NotificationCenter notifications={notifications} onOpen={openNotification} />
        <button type="button" className="icon-button" onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? '라이트 모드' : '다크 모드'}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
        <button type="button" className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="환경 관리"><Icon name="settings" /></button>
      </div>
    </header>

    {data.errors.summary && <div className="global-error" role="alert"><span><strong>로컬 서버 동기화 실패</strong>{data.errors.summary}</span><button type="button" onClick={data.refresh}>다시 시도</button></div>}

    <div className="operator-grid">
      <Sidebar summary={data.summary} selectedDirector={data.selectedDirector} selectedGoal={data.selectedGoal} goals={data.goals} query={data.goalSearch} onQuery={data.setGoalSearch} historyFilter={data.historyFilter} onHistoryFilter={data.setHistoryFilter} history={data.goalHistory} onLoadMore={data.loadMoreGoals} onDirector={data.selectDirector} onGoal={data.selectGoal} onSettings={() => setSettingsOpen(true)} />
      <Splitter label="왼쪽 사이드바 너비" side="left" value={railWidth} min={220} max={420} onChange={setRailWidth} onReset={() => setRailWidth(248)} />
      <section className={`workspace-shell ${inspectorOpen ? '' : 'inspector-closed'}`}>
        <Workspace
          director={data.selectedDirector}
          goal={data.selectedGoal}
          goalDetail={data.goalDetail}
          summary={data.summary}
          board={data.board}
          selectedTaskId={data.selectedTaskId}
          selectTask={data.selectTask}
          selectGoal={data.selectGoal}
          taskDetail={data.taskDetail}
          taskTrace={data.taskTrace}
          errors={data.errors}
          lastSyncedAt={data.lastSyncedAt}
          liveActivity={data.liveActivity}
          refresh={data.refresh}
          projectMessages={data.projectMessages}
          loadMoreProjectMessages={data.loadMoreProjectMessages}
          inspectorOpen={inspectorOpen}
          setInspectorOpen={setInspectorOpen}
          inspectorWidth={inspectorWidth}
          setInspectorWidth={setInspectorWidth}
          activityHeight={activityHeight}
          setActivityHeight={setActivityHeight}
          workerRoomWidth={workerRoomWidth}
          setWorkerRoomWidth={setWorkerRoomWidth}
        />
      </section>
    </div>
    <Settings open={settingsOpen} onClose={closeSettings} onChanged={data.refresh} />
  </div>;
}

export default function App() {
  return <AppErrorBoundary><AppShell /></AppErrorBoundary>;
}
