import { useMemo, useState } from 'react';
import { Icon, initials, relativeTime, Status, statusTone, statusText } from './common.jsx';

function GoalRow({ goal, selected, active, onSelect }) {
  const label = goal.objective || `Goal ${goal.id.slice(-6)}`;
  return <button type="button" className={`goal-row ${selected ? 'selected' : ''}`} onClick={() => onSelect(goal.id)} title={label} aria-label={label}>
    <span className={`goal-state ${statusTone(goal.status)}`}><i /></span>
    <span className="goal-copy"><strong>{label}</strong><small>{active ? '활성 목표' : statusText(goal.status)}{goal.queuePosition ? ` · 대기열 #${goal.queuePosition}` : ''}{goal.updatedAt ? ` · ${relativeTime(goal.updatedAt)}` : ''}</small></span>
  </button>;
}

export default function Sidebar({ summary, selectedDirector, selectedGoal, goals, onDirector, onGoal, onSettings }) {
  const [query, setQuery] = useState('');
  const visibleGoals = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return goals;
    return goals.filter(goal => `${goal.objective} ${goal.id}`.toLowerCase().includes(value));
  }, [goals, query]);
  const activeIds = new Set(summary?.activeGoals || []);
  const active = visibleGoals.filter(goal => activeIds.has(goal.id));
  const queued = visibleGoals.filter(goal => goal.status === 'queued');
  const recent = visibleGoals.filter(goal => !activeIds.has(goal.id) && goal.status !== 'queued');

  return <aside className="sidebar" aria-label="디렉터와 목표">
    <div className="sidebar-search"><Icon name="search" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Goal 검색" aria-label="Goal 검색" /></div>

    <div className="sidebar-scroll">
      <section className="nav-section director-section">
        <header><span>Directors</span><small>{summary?.directors?.length || 0}</small></header>
        <div className="director-switcher">
          {(summary?.directors || []).map(director => <button type="button" key={director.id} className={director.id === selectedDirector?.id ? 'selected' : ''} onClick={() => onDirector(director.id)} title={director.name}>
            <span className="director-avatar">{initials(director.name)}</span>
            <span><strong>{director.name}</strong><small><span>{director.kind === 'project' ? (director.runtime === 'wsl' ? `WSL · ${director.distro || 'Ubuntu'}` : 'Windows 프로젝트') : 'Skill Director'}</span><Status value={director.status} dot /></small></span>
          </button>)}
        </div>
      </section>

      {!!active.length && <section className="nav-section">
        <header><span>Now</span><small>{active.length}</small></header>
        {active.map(goal => <GoalRow key={goal.id} goal={goal} active selected={goal.id === selectedGoal?.id} onSelect={onGoal} />)}
      </section>}

      {!!queued.length && <section className="nav-section">
        <header><span>Queue</span><small>{queued.length}</small></header>
        {queued.map(goal => <GoalRow key={goal.id} goal={goal} selected={goal.id === selectedGoal?.id} onSelect={onGoal} />)}
      </section>}

      {!!recent.length && <section className="nav-section recent-section">
        <header><span>Recent</span><small>{recent.length}</small></header>
        {recent.map(goal => <GoalRow key={goal.id} goal={goal} selected={goal.id === selectedGoal?.id} onSelect={onGoal} />)}
      </section>}
      {!visibleGoals.length && <p className="nav-empty">표시할 Goal이 없습니다.</p>}
    </div>

    <footer className="sidebar-footer">
      <div><span className={`presence ${summary?.scheduler?.running ? 'online' : ''}`} /><span><strong>로컬 스케줄러</strong><small>{summary?.scheduler?.lastError || (summary?.scheduler?.running ? '감독 중' : '중지됨')}</small></span></div>
      <button type="button" className="icon-button" onClick={onSettings} aria-label="설정 열기"><Icon name="settings" /></button>
    </footer>
  </aside>;
}
