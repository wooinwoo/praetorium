import { useMemo } from 'react';
import { orderQueuedGoals } from '../domain/operator-model.js';
import { Icon, initials, relativeTime, Status, statusTone, statusText } from './common.jsx';

function GoalRow({ goal, selected, active, onSelect }) {
  const label = goal.objective || `Goal ${goal.id.slice(-6)}`;
  const stateLabel = active ? `${statusText(goal.status)} · 활성 목표` : statusText(goal.status);
  const accessibleLabel = `${label} · ${stateLabel}${goal.queuePosition ? ` · 대기열 #${goal.queuePosition}` : ''}`;
  return <button type="button" className={`goal-row ${selected ? 'selected' : ''}`} onClick={() => onSelect(goal.id)} title={label} aria-label={accessibleLabel}>
    <span className={`goal-state ${statusTone(goal.status)}`}><i /></span>
    <span className="goal-copy"><strong>{label}</strong><small>{stateLabel}{goal.queuePosition ? ` · 대기열 #${goal.queuePosition}` : ''}{goal.updatedAt ? ` · ${relativeTime(goal.updatedAt)}` : ''}</small></span>
  </button>;
}

export default function Sidebar({ summary, selectedDirector, selectedGoal, goals, query, onQuery, historyFilter, onHistoryFilter, history, onLoadMore, onDirector, onGoal, onSettings, dockSide = 'left', onDockStart, onDockEnd, onDockToggle, onCollapse }) {
  const visibleGoals = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return goals;
    return goals.filter(goal => `${goal.objective} ${goal.id}`.toLowerCase().includes(value));
  }, [goals, query]);
  const activeIds = new Set(summary?.activeGoals || []);
  const activeGoalByDirector = new Map((summary?.goals || [])
    .filter(goal => activeIds.has(goal.id))
    .map(goal => [goal.directorId, goal]));
  const active = visibleGoals.filter(goal => activeIds.has(goal.id));
  const queued = orderQueuedGoals(visibleGoals.filter(goal => goal.status === 'queued'));
  const recent = visibleGoals.filter(goal => !activeIds.has(goal.id) && goal.status !== 'queued')
    .filter(goal => historyFilter === 'all' || (historyFilter === 'completed' ? goal.status === 'completed' : ['blocked', 'failed'].includes(goal.status)));

  return <aside className="sidebar" aria-label="프로젝트와 디렉터" data-dock={dockSide}>
    <header className="sidebar-panel-header">
      <span><Icon name="layers" /><strong>프로젝트 목록</strong></span>
      <span><span className="panel-drag-handle" draggable="true" role="button" tabIndex="0" title="끌어서 좌우 이동 · 클릭하면 반대쪽 배치" aria-label="프로젝트 목록 위치 바꾸기" onDragStart={onDockStart} onDragEnd={onDockEnd} onClick={onDockToggle} onKeyDown={event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); onDockToggle?.(); } }}><Icon name="grip" /></span><button type="button" className="icon-button panel-collapse" onClick={onCollapse} aria-label="프로젝트 목록 접기"><Icon name="chevron" /></button></span>
    </header>
    <div className="sidebar-scroll">
      <section className="nav-section director-section">
        <header><span>프로젝트 룸</span><small>{summary?.directors?.length || 0}</small></header>
        <div className="director-switcher">
          {(summary?.directors || []).map(director => <button type="button" key={director.id} className={director.id === selectedDirector?.id ? 'selected' : ''} onClick={() => onDirector(director.id)} title={director.name}>
            <span className="director-avatar">{initials(director.name)}</span>
            <span><strong>{director.name}</strong><small><span>{director.kind === 'project' ? (director.runtime === 'wsl' ? `WSL · ${director.distro || 'Ubuntu'}` : 'Windows 프로젝트') : 'Skill Director'}</span><Status value={activeGoalByDirector.get(director.id)?.status === 'awaiting_owner' ? 'awaiting_owner' : activeGoalByDirector.has(director.id) ? 'running' : director.status} dot /></small></span>
          </button>)}
        </div>
      </section>

      {!!active.length && <section className="nav-section">
        <header><span>현재 작업</span><small>{active.length}</small></header>
        {active.map(goal => <GoalRow key={goal.id} goal={goal} active selected={goal.id === selectedGoal?.id} onSelect={onGoal} />)}
      </section>}

      <details className="work-history">
        <summary><span><Icon name="branch" /><strong>작업 기록</strong></span><small>{(history?.total ?? recent.length) + queued.length}</small></summary>
        <div className="sidebar-search"><Icon name="search" /><input value={query} onChange={event => onQuery(event.target.value)} placeholder="작업·ID 검색" aria-label="작업 기록 검색" /></div>
        {!!queued.length && <section className="nav-section">
          <header><span>대기열</span><small>{queued.length}</small></header>
          {queued.map(goal => <GoalRow key={goal.id} goal={goal} selected={goal.id === selectedGoal?.id} onSelect={onGoal} />)}
        </section>}
        <section className="nav-section recent-section">
          <header><span>지난 작업</span><small>{history?.total ?? recent.length}</small></header>
          <div className="history-filters" role="group" aria-label="기록 상태 필터">
            {[['all', '전체'], ['completed', '완료'], ['problems', '문제']].map(([value, label]) => <button type="button" key={value} className={historyFilter === value ? 'selected' : ''} onClick={() => onHistoryFilter(value)}>{label}</button>)}
          </div>
          {recent.map(goal => <GoalRow key={goal.id} goal={goal} selected={goal.id === selectedGoal?.id} onSelect={onGoal} />)}
          {!recent.length && <p className="nav-empty">{history?.loading ? '기록을 불러오는 중…' : '조건에 맞는 기록이 없습니다.'}</p>}
          {history?.error && <p className="history-error">기록을 불러오지 못했습니다.</p>}
          {history?.hasMore && <button type="button" className="history-more" disabled={history.loading} onClick={onLoadMore}>{history.loading ? '불러오는 중…' : `이전 기록 더 보기 · ${recent.length}/${history.total}`}</button>}
        </section>
      </details>
    </div>

    <footer className="sidebar-footer">
      <div><span className={`presence ${summary?.scheduler?.running ? 'online' : ''}`} /><span><strong>로컬 스케줄러</strong><small>{summary?.scheduler?.lastError || (summary?.scheduler?.running ? '감독 중' : '중지됨')}</small></span></div>
      <button type="button" className="icon-button" onClick={onSettings} aria-label="설정 열기"><Icon name="settings" /></button>
    </footer>
  </aside>;
}
