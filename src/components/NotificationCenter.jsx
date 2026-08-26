import { useEffect, useRef, useState } from 'react';
import { Icon, relativeTime } from './common.jsx';

const kindLabel = {
  owner_decision: '결정', goal_completed: 'Goal', goal_problem: '문제',
  workers_completed: 'Worker', connection_lost: '연결', runtime_error: 'Runtime',
};

export default function NotificationCenter({ notifications, onOpen }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = event => {
      if (event.key === 'Escape' || (event.type === 'pointerdown' && !rootRef.current?.contains(event.target))) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close); };
  }, [open]);

  const openItem = item => {
    notifications.markRead(item.id);
    setOpen(false);
    onOpen(item);
  };
  return <div ref={rootRef} className="notification-center">
    <button type="button" className={`icon-button notification-trigger ${open ? 'selected' : ''}`} aria-label={`알림${notifications.unread ? ` ${notifications.unread}개 읽지 않음` : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Icon name="bell" />{notifications.unread > 0 && <b>{notifications.unread > 99 ? '99+' : notifications.unread}</b>}
    </button>
    {open && <section className="notification-panel" role="dialog" aria-label="알림 센터">
      <header><span><strong>알림</strong><small>{notifications.unread ? `${notifications.unread}개 안 읽음` : '모두 확인함'}</small></span><span>{notifications.unread > 0 && <button type="button" onClick={notifications.markAllRead}>모두 읽음</button>}{notifications.items.length > 0 && <button type="button" onClick={notifications.clearAll}>비우기</button>}</span></header>
      {['prompt', 'denied'].includes(notifications.permission) && <div className="notification-permission"><span><strong>Windows 알림</strong><small>앱이 뒤에 있을 때 중요한 변경을 알려줍니다.</small></span><button type="button" onClick={notifications.enableNative}>켜기</button></div>}
      <div className="notification-list">
        {!notifications.items.length && <div className="notification-empty"><Icon name="bell" /><strong>새 알림이 없습니다.</strong><span>결정 요청, 완료, 실패, 연결 문제를 여기에 모읍니다.</span></div>}
        {notifications.items.map(item => <button type="button" key={item.id} className={`notification-item tone-${item.tone || 'neutral'} ${item.read ? '' : 'unread'}`} onClick={() => openItem(item)}>
          <span className="notification-dot" /><span><small>{kindLabel[item.kind] || 'Praetorium'} · {relativeTime(item.createdAt)}</small><strong>{item.title}</strong><p>{item.body}</p></span><Icon name="chevron" />
        </button>)}
      </div>
    </section>}
  </div>;
}
