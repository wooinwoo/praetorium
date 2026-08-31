import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Empty, ErrorNotice, Icon } from './common.jsx';

const FALLBACK_CODEX_COMPATIBILITY = '>=0.149.0 <1.0.0';

function firstLine(value, fallback = '확인되지 않음') {
  return String(value || '').split(/\r?\n/).find(Boolean) || fallback;
}

function compatibleCodex(target) {
  if (typeof target.codex?.compatible === 'boolean') return target.codex.compatible;
  const match = String(target.codex?.version || '').match(/^\s*codex-cli\s+(\d+)\.(\d+)\.(\d+)\s*$/m);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  return major === 0 && (minor > 149 || (minor === 149 && patch >= 0));
}

function runtimeChecks(target, profileTotal, requiredProfileIds) {
  const checks = [];
  if (target.kind === 'wsl') {
    checks.push({
      label: 'WSL 런타임',
      detail: `${target.state || '상태 미확인'} · WSL ${target.wslVersion || '버전 미확인'}`,
      state: target.wslVersion === 2,
    });
  }
  checks.push(
    {
      label: 'Hermes',
      detail: firstLine(target.hermes?.version, target.hermes?.installed ? target.hermes.path : '설치되지 않음'),
      state: Boolean(target.hermes?.pinned),
    },
    {
      label: 'Codex CLI',
      detail: `${firstLine(target.codex?.version, '설치되지 않음')} · 지원 ${target.codex?.compatibility || FALLBACK_CODEX_COMPATIBILITY}`,
      state: compatibleCodex(target),
    },
    {
      label: 'Codex app-server',
      detail: target.codex?.appServer === undefined ? '이전 서버에서 진단 정보 없음' : 'Worker 실행 프로토콜',
      state: target.codex?.appServer,
    },
    {
      label: 'Codex 로그인',
      detail: target.codex?.authenticated ? '로컬 계정 인증됨' : '로그인 필요',
      state: Boolean(target.codex?.authenticated),
    },
    {
      label: '역할 프로필',
      detail: `${target.profiles?.length || 0} / ${profileTotal}개`,
      state: typeof target.profilesReady === 'boolean'
        ? target.profilesReady
        : requiredProfileIds.length === profileTotal && requiredProfileIds.every(id => target.profiles?.includes(id)),
    },
  );
  return checks;
}

function RuntimeTarget({ target, profileTotal, requiredProfileIds }) {
  const checks = runtimeChecks(target, profileTotal, requiredProfileIds);
  const legacyPolicy = !target.ready && target.codex?.compatible === undefined && compatibleCodex(target)
    && target.hermes?.pinned && target.codex?.authenticated && checks.at(-1)?.state
    && target.error === '고정된 Hermes와 Codex 런타임 준비가 필요합니다.';
  const state = target.ready ? 'ready' : legacyPolicy ? 'restart' : 'blocked';
  const stateLabel = target.ready ? '준비됨' : legacyPolicy ? '재진단 필요' : '확인 필요';
  const message = legacyPolicy
    ? `${firstLine(target.codex?.version)}은 지원 범위입니다. Praetorium을 안전하게 다시 연 뒤 app-server와 역할 프로필을 새 정책으로 재진단하세요.`
    : target.error;

  return <article className={`runtime-target runtime-target-${state}`}>
    <header>
      <span className="runtime-icon"><Icon name="terminal" /></span>
      <span className="runtime-identity">
        <strong>{target.label || target.id}</strong>
        <small>{target.kind === 'wsl' ? `${target.user || '사용자 미확인'} · ${target.home || '홈 경로 미확인'}` : target.hermes?.path || '로컬 실행 환경'}</small>
      </span>
      <span className={`runtime-state runtime-state-${state}`}><i />{stateLabel}</span>
    </header>
    {message && <p className="runtime-message">{message}</p>}
    <ul className="runtime-checks">
      {checks.map(check => <li key={check.label} className={check.state === true ? 'passed' : check.state === false ? 'failed' : 'unknown'}>
        <span className="runtime-check-icon"><Icon name={check.state === false ? 'x' : 'check'} size={13} /></span>
        <span><strong>{check.label}</strong><small>{check.detail}</small></span>
        <em>{check.state === true ? '통과' : check.state === false ? '확인 필요' : '미진단'}</em>
      </li>)}
    </ul>
    {target.setupCommand && <details className="runtime-command"><summary>{legacyPolicy ? '재진단 후 문제가 계속되면 복구 명령 보기' : '복구 명령 보기'}</summary><span>{target.setupLabel || '터미널'}</span><pre>{target.setupCommand}</pre></details>}
  </article>;
}

export default function Settings({ open, initialTab = 'projects', onClose, onChanged }) {
  const sheetRef = useRef(null);
  const closeRef = useRef(null);
  const lastFocusRef = useRef(null);
  const [tab, setTab] = useState('projects');
  const [data, setData] = useState({ projects: [], runtimes: null, profiles: [], console: null });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const load = async force => {
    setDiagnosing(true);
    try {
      const [projects, runtimes, profiles, console] = await Promise.all([
        api('/api/projects'), api(`/api/runtimes${force ? '?force=true' : ''}`), api('/api/profiles'), api('/api/directors?view=compact'),
      ]);
      setData({ projects, runtimes, profiles, console });
      setError('');
    } catch (nextError) { setError(nextError.message); }
    finally { setDiagnosing(false); }
  };
  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    void load(false);
  }, [initialTab, open]);
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
  const runtimeTargets = targets.filter(item => !item.system);
  const systemTargetCount = targets.length - runtimeTargets.length;
  const readyTargetCount = runtimeTargets.filter(item => item.ready).length;
  const profileTotal = data.runtimes?.profileTotal || data.profiles.length;
  const requiredProfileIds = data.profiles.map(profile => profile.id);

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
        {tab === 'runtimes' && <div className="runtime-list" aria-busy={diagnosing}>
          <header><span><h3>실행 환경</h3><p aria-live="polite">{diagnosing ? 'Hermes·Codex·로그인·프로필을 진단하는 중…' : `${runtimeTargets.length}개 중 ${readyTargetCount}개 준비됨`}</p></span><button type="button" className="secondary-button" disabled={diagnosing} onClick={() => load(true)}><Icon name="refresh" />{diagnosing ? '진단 중…' : '다시 진단'}</button></header>
          {runtimeTargets.map(target => <RuntimeTarget key={target.id} target={target} profileTotal={profileTotal} requiredProfileIds={requiredProfileIds} />)}
          {!runtimeTargets.length && !diagnosing && <Empty icon="terminal" title="실행 환경을 찾지 못했습니다">Windows에서 WSL 상태를 확인한 뒤 다시 진단하세요.</Empty>}
          {systemTargetCount > 0 && <p className="runtime-system-note">Praetorium 실행 대상이 아닌 시스템 배포판 {systemTargetCount}개는 숨겼습니다.</p>}
        </div>}
        {tab === 'profiles' && <div className="profile-grid">{data.profiles.map(profile => <article key={profile.id}><span className="profile-icon"><Icon name="user" /></span><small>{profile.kind || 'WORKER'}</small><h3>{profile.name || profile.label || profile.id}</h3><p>{profile.description || profile.summary || '역할에 맞는 작업과 검증을 수행합니다.'}</p><code>{profile.id}</code></article>)}</div>}
        {tab === 'skills' && <div className="skills-panel"><header><h3>운영 스킬</h3><p>역할이 실제 작업을 수행하고 검증하는 재사용 절차입니다.</p></header><div className="skill-grid">{Object.entries(data.console?.skills || {}).map(([name, description]) => <article key={name}><span className="profile-icon"><Icon name="layers" /></span><code>{name}</code><p>{description}</p></article>)}</div><header><h3>작업 플로우</h3><p>디렉터가 목표 위험과 변경 성격에 따라 선택합니다.</p></header><div className="workflow-list">{(data.console?.workflows || []).map(workflow => <article key={workflow.id}><span><strong>{workflow.name}</strong><small>{workflow.description}</small></span><div>{(workflow.graph || []).map(step => <em key={step}>{step}</em>)}</div></article>)}</div></div>}
      </div>
    </section>
  </div>;
}
