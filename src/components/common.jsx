import { useRef } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { statusText, statusTone } from '../domain/operator-model.js';
import { timestampDate, timestampMs } from '../lib/time.js';

export { statusText, statusTone };

const paths = {
  activity: '<path d="M4 13h3l2-7 4 12 2-5h5"/>',
  arrow: '<path d="m9 18 6-6-6-6"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
  branch: '<path d="M6 3v12a3 3 0 0 0 3 3h6"/><circle cx="6" cy="3" r="2"/><circle cx="17" cy="18" r="2"/><circle cx="17" cy="7" r="2"/><path d="M6 8h7a4 4 0 0 0 4-4"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  command: '<path d="m7 8-4 4 4 4M11 16h10"/>',
  folder: '<path d="M3 6h6l2 2h10v10H3z"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 15-5-5L5 20"/>',
  layers: '<path d="m12 3-9 5 9 5 9-5-9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
  message: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>',
  moon: '<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 9a7 7 0 0 1 11.5-2L20 12M4 12l2.4 5a7 7 0 0 0 11.5-2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  terminal: '<path d="m5 7 5 5-5 5M13 17h6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
};

export function Icon({ name, size = 16 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: paths[name] || paths.activity }} />;
}

export function Status({ value, dot = true }) {
  return <span className={`status status-${statusTone(value)}`}>{dot && <i />}{statusText(value)}</span>;
}

function ExternalLink({ href, children }) {
  const open = event => {
    if (!window.__TAURI_INTERNALS__) return;
    event.preventDefault();
    void openUrl(href).catch(error => console.error('Failed to open external link', error));
  };
  return <a href={href} target="_blank" rel="noreferrer" onClick={open}>{children}</a>;
}

function inlineContent(value, keyPrefix) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<]+)/g;
  return String(value).split(pattern).filter(Boolean).map((part, index) => {
    const key = `${keyPrefix}:${index}`;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={key}>{part.slice(2, -2)}</strong>;
    const markdownLink = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (markdownLink) return <ExternalLink key={key} href={markdownLink[2]}>{markdownLink[1]}</ExternalLink>;
    if (/^https?:\/\//.test(part)) return <ExternalLink key={key} href={part}>{part}</ExternalLink>;
    return part;
  });
}

export function RichText({ children }) {
  const blocks = [];
  let list = [];
  let listType = '';
  let code = null;
  const flushList = () => {
    if (!list.length) return;
    const List = listType || 'ul';
    blocks.push(<List key={`list:${blocks.length}`}>{list}</List>);
    list = [];
    listType = '';
  };
  const flushCode = () => {
    if (code === null) return;
    blocks.push(<pre className="rich-code" key={`code:${blocks.length}`}><code>{code.join('\n')}</code></pre>);
    code = null;
  };
  String(children || '').split('\n').forEach((raw, index) => {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      if (code === null) { flushList(); code = []; } else flushCode();
      return;
    }
    if (code !== null) { code.push(raw); return; }
    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)/);
    if (bullet || ordered) {
      const nextType = ordered ? 'ol' : 'ul';
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      const content = (bullet || ordered)[1];
      list.push(<li key={`item:${index}`}>{inlineContent(content, `item:${index}`)}</li>);
      return;
    }
    flushList();
    if (!line.trim()) {
      if (blocks.length && blocks.at(-1)?.type !== 'span') blocks.push(<span className="rich-gap" key={`gap:${index}`} />);
      return;
    }
    const heading = line.match(/^\s*#{1,4}\s+(.+)/);
    if (heading) blocks.push(<strong className="rich-heading" key={`heading:${index}`}>{inlineContent(heading[1], `heading:${index}`)}</strong>);
    else if (/^\s*>/.test(line)) blocks.push(<blockquote key={`quote:${index}`}>{inlineContent(line.replace(/^\s*>\s?/, ''), `quote:${index}`)}</blockquote>);
    else blocks.push(<p key={`line:${index}`}>{inlineContent(line, `line:${index}`)}</p>);
  });
  flushList();
  flushCode();
  return <div className="rich-text">{blocks}</div>;
}

export function formatClock(value) {
  if (!value) return '—';
  const date = timestampDate(value);
  if (!date) return '—';
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}

export function relativeTime(value) {
  const ms = Date.now() - timestampMs(value);
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

export function initials(value = '') {
  const clean = String(value).trim();
  if (!clean) return 'D';
  return clean.split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase();
}

export function Splitter({ label, side, value, min, max, onChange, onReset, orientation = 'vertical', ref }) {
  const drag = useRef(null);
  const horizontal = orientation === 'horizontal';
  const paneWidth = splitter => {
    if (horizontal) return value;
    const pane = side === 'left' ? splitter.previousElementSibling : splitter.nextElementSibling;
    return pane?.getBoundingClientRect().width || value;
  };
  const begin = event => {
    drag.current = { position: horizontal ? event.clientY : event.clientX, value: paneWidth(event.currentTarget) };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = event => {
    if (!drag.current) return;
    const delta = (horizontal ? event.clientY : event.clientX) - drag.current.position;
    onChange(Math.max(min, Math.min(max, drag.current.value + (side === 'right' ? -delta : delta))));
  };
  return <button
    ref={ref}
    type="button"
    className={`splitter splitter-${side} ${horizontal ? 'splitter-horizontal' : ''}`}
    role="separator"
    aria-label={label}
    aria-orientation={orientation}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={Math.round(value)}
    onPointerDown={begin}
    onPointerMove={move}
    onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { drag.current = null; }}
    onDoubleClick={onReset}
    onKeyDown={event => {
      const keys = horizontal ? ['ArrowUp', 'ArrowDown', 'Home'] : ['ArrowLeft', 'ArrowRight', 'Home'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') return onReset();
      const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
      onChange(Math.max(min, Math.min(max, paneWidth(event.currentTarget) + (side === 'right' ? -direction : direction) * 16)));
    }}
  />;
}

export function Empty({ icon = 'activity', title, children }) {
  return <div className="empty-state"><span><Icon name={icon} size={20} /></span><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

export function ErrorNotice({ title = '불러오지 못했습니다', children, onRetry, retryLabel = '다시 시도' }) {
  return <div className="error-notice" role="alert"><strong>{title}</strong><span>{children}</span>{onRetry && <button type="button" onClick={onRetry}>{retryLabel}</button>}</div>;
}
