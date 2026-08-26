import { Component, useCallback, useEffect, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Settings from './components/Settings.jsx';
import Workspace from './components/Workspace.jsx';
import { Icon, Splitter, Status } from './components/common.jsx';
import { usePraetorium, useStoredState } from './hooks/usePraetorium.js';

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

function AppShell() {
  const [activeTab, setActiveTab] = useState('trace');
  const data = usePraetorium({ taskPollingEnabled: activeTab !== 'director' });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useStoredState('praetorium.theme', 'dark');
  const [scale, setScale] = useStoredState('praetorium.scale', 1);
  const [railWidth, setRailWidth] = useStoredState('praetorium.railWidth', 268);
  const [inspectorWidth, setInspectorWidth] = useStoredState('praetorium.inspectorWidth', 336);
  const [inspectorOpen, setInspectorOpen] = useStoredState('praetorium.inspectorOpen', false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty('--ui-scale', String(scale));
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d0f13' : '#f4f5f7');
  }, [theme, scale]);
  useEffect(() => { setActiveTab('trace'); }, [data.selectedGoalId, data.selectedDirectorId]);

  const projectName = data.selectedDirector?.name || 'Praetorium';
  const sessionCount = data.summary?.sessions?.total || 0;
  const connected = !data.errors.summary && Boolean(data.summary);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  return <div className="app-shell" style={{ '--rail-width': `${railWidth}px`, '--inspector-width': `${inspectorWidth}px` }}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Icon name="layers" size={18} /></span><strong>PRAETORIUM</strong><span className="brand-divider" /><span className="breadcrumb"><b>{projectName}</b><small>{data.selectedDirector?.runtime === 'wsl' ? `WSL · ${data.selectedDirector.distro || 'Ubuntu'}` : 'Local'}</small></span></div>
      <div className="topbar-actions">
        <span className={`connection ${connected ? 'online' : 'offline'}`}><i />{connected ? '로컬 연결' : '연결 끊김'}</span>
        <span className="session-state"><Icon name="activity" /><b>{sessionCount}</b> running</span>
        <div className="scale-control" aria-label="화면 글자 크기"><button type="button" onClick={() => setScale(value => Math.max(.9, +(value - .05).toFixed(2)))} aria-label="글자 축소">−</button><button type="button" onClick={() => setScale(1)} title="100%로 초기화">{Math.round(scale * 100)}%</button><button type="button" onClick={() => setScale(value => Math.min(1.25, +(value + .05).toFixed(2)))} aria-label="글자 확대">+</button></div>
        <button type="button" className="icon-button" onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? '라이트 모드' : '다크 모드'}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
        <button type="button" className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="환경 관리"><Icon name="settings" /></button>
      </div>
    </header>

    {data.errors.summary && <div className="global-error" role="alert"><span><strong>로컬 서버 동기화 실패</strong>{data.errors.summary}</span><button type="button" onClick={data.refresh}>다시 시도</button></div>}

    <div className="operator-grid">
      <Sidebar summary={data.summary} selectedDirector={data.selectedDirector} selectedGoal={data.selectedGoal} goals={data.goals} onDirector={data.selectDirector} onGoal={data.selectGoal} onSettings={() => setSettingsOpen(true)} />
      <Splitter label="왼쪽 사이드바 너비" side="left" value={railWidth} min={220} max={420} onChange={setRailWidth} onReset={() => setRailWidth(268)} />
      <section className={`workspace-shell ${inspectorOpen ? '' : 'inspector-closed'}`}>
        <Workspace
          activeTab={activeTab}
          setActiveTab={setActiveTab}
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
          refresh={data.refresh}
          inspectorOpen={inspectorOpen}
          setInspectorOpen={setInspectorOpen}
          inspectorWidth={inspectorWidth}
          setInspectorWidth={setInspectorWidth}
        />
      </section>
    </div>
    <Settings open={settingsOpen} onClose={closeSettings} onChanged={data.refresh} />
  </div>;
}

export default function App() {
  return <AppErrorBoundary><AppShell /></AppErrorBoundary>;
}
