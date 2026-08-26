import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { ErrorNotice, Icon, Status } from './common.jsx';

export default function Settings({ open, onClose, onChanged }) {
  const sheetRef = useRef(null);
  const closeRef = useRef(null);
  const lastFocusRef = useRef(null);
  const [tab, setTab] = useState('projects');
  const [data, setData] = useState({ projects: [], runtimes: null, profiles: [], console: null });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async force => {
    try {
      const [projects, runtimes, profiles, console] = await Promise.all([
        api('/api/projects'), api(`/api/runtimes${force ? '?force=true' : ''}`), api('/api/profiles'), api('/api/directors?view=compact'),
      ]);
      setData({ projects, runtimes, profiles, console });
      setError('');
    } catch (nextError) { setError(nextError.message); }
  };
  useEffect(() => { if (open) void load(false); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    lastFocusRef.current = document.activeElement;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const handleKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(sheetRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])') || [])]
        .filter(element => element.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handleKey);
      lastFocusRef.current?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;

  const addProject = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setBusy(true);
    try {
      await api('/api/projects', { method: 'POST', body: Object.fromEntries(formData) });
      form.reset();
      await load(true);
      onChanged();
    } catch (nextError) { setError(nextError.message); }
    finally { setBusy(false); }
  };
  const removeProject = async project => {
    if (!window.confirm(`“${project.name}” 프로젝트 배정을 제거할까요? 실행 중인 작업이 있으면 서버가 거부합니다.`)) return;
    setBusy(true);
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      await load(true);
      onChanged();
    } catch (nextError) { setError(nextError.message); }
    finally { setBusy(false); }
  };
  const discoverProjects = async event => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    try {
      await api('/api/projects/discover', { method: 'POST', body });
      await load(true);
      onChanged();
    } catch (nextError) { setError(nextError.message); }
    finally { setBusy(false); }
  };
  const targets = data.runtimes?.targets || [];
  const wslTargets = targets.filter(item => item.kind === 'wsl' && !item.system);

  return <div className="settings-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={sheetRef} className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header><span><small>LOCAL ENVIRONMENT</small><h2 id="settings-title">Praetorium 설정</h2></span><button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="설정 닫기"><Icon name="x" /></button></header>
      <nav aria-label="설정 구역">
        {['projects', 'runtimes', 'profiles', 'skills'].map(id => <button type="button" key={id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}>{id === 'projects' ? '프로젝트' : id === 'runtimes' ? '실행 환경' : id === 'profiles' ? '역할 프로필' : '스킬·플로우'}</button>)}
      </nav>
      <div className="settings-content">
        {error && <ErrorNotice onRetry={() => load(true)}>{error}</ErrorNotice>}
        {tab === 'projects' && <div className="settings-projects">
          <div className="settings-list">{data.projects.map(project => <article key={project.id}><span className="project-mark"><Icon name="folder" /></span><span><strong>{project.name}</strong><small>{project.runtime === 'wsl' ? `WSL · ${project.distro}` : 'Windows'} · {project.path}</small></span><button type="button" className="text-button danger" disabled={busy} onClick={() => removeProject(project)}>배정 제거</button></article>)}{!data.projects.length && <p className="settings-empty">연결된 프로젝트가 없습니다.</p>}</div>
          <div className="project-tools"><form className="project-form" onSubmit={addProject}><h3>프로젝트 연결</h3><label><span>이름</span><input required name="name" placeholder="AgencyPro" /></label><label><span>실행 환경</span><select name="runtime"><option value="windows">Windows</option><option value="wsl">WSL2</option></select></label><label><span>WSL 배포판</span><select name="distro"><option value="">선택 안 함</option>{wslTargets.map(target => <option value={target.distro} key={target.id}>{target.distro}{target.ready ? ' · 준비됨' : ' · 설정 필요'}</option>)}</select></label><label><span>절대 경로</span><input required name="path" placeholder="/home/user/projects/app" /></label><button className="primary-button" type="submit" disabled={busy}>{busy ? '확인 중…' : '연결'}</button></form>
          <form className="project-form discovery-form" onSubmit={discoverProjects}><h3>로컬 Git 자동 연결</h3><label><span>실행 환경</span><select name="runtime"><option value="windows">Windows</option><option value="wsl">WSL2</option></select></label><label><span>WSL 배포판</span><select name="distro"><option value="">선택 안 함</option>{wslTargets.map(target => <option value={target.distro} key={target.id}>{target.distro}</option>)}</select></label><label><span>검색 루트</span><input required name="root" placeholder="/home/user/projects" /></label><button className="secondary-button" type="submit" disabled={busy}><Icon name="search" />Git 저장소 찾기</button></form></div>
        </div>}
        {tab === 'runtimes' && <div className="runtime-list"><header><span><h3>실행 환경</h3><p>Hermes와 Codex 준비 상태를 로컬에서 확인합니다.</p></span><button type="button" className="secondary-button" onClick={() => load(true)}><Icon name="refresh" />다시 진단</button></header>{targets.map(target => <article key={target.id}><span className="runtime-icon"><Icon name="terminal" /></span><span><strong>{target.label || target.id}</strong><small>{target.error || target.home || target.kind}</small></span><Status value={target.ready ? 'done' : 'blocked'} /><em>{target.ready ? '준비됨' : '설정 필요'}</em>{target.setupCommand && <details><summary>설정 명령 보기</summary><pre>{target.setupCommand}</pre></details>}</article>)}</div>}
        {tab === 'profiles' && <div className="profile-grid">{data.profiles.map(profile => <article key={profile.id}><span className="profile-icon"><Icon name="user" /></span><small>{profile.kind || 'WORKER'}</small><h3>{profile.name || profile.label || profile.id}</h3><p>{profile.description || profile.summary || '역할에 맞는 작업과 검증을 수행합니다.'}</p><code>{profile.id}</code></article>)}</div>}
        {tab === 'skills' && <div className="skills-panel"><header><h3>운영 스킬</h3><p>역할이 실제 작업을 수행하고 검증하는 재사용 절차입니다.</p></header><div className="skill-grid">{Object.entries(data.console?.skills || {}).map(([name, description]) => <article key={name}><span className="profile-icon"><Icon name="layers" /></span><code>{name}</code><p>{description}</p></article>)}</div><header><h3>작업 플로우</h3><p>디렉터가 목표 위험과 변경 성격에 따라 선택합니다.</p></header><div className="workflow-list">{(data.console?.workflows || []).map(workflow => <article key={workflow.id}><span><strong>{workflow.name}</strong><small>{workflow.description}</small></span><div>{(workflow.graph || []).map(step => <em key={step}>{step}</em>)}</div></article>)}</div></div>}
      </div>
    </section>
  </div>;
}
