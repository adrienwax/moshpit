import { useRef, useState } from 'react';
import { SharedResizeHandle } from '../../../shared/ui/ResizeHandle';
import { useStore } from '../state/store';
import { clearNotifications, copyNotificationDetails, dismissNotification, HISTORY_LIMIT, markNotificationsRead, notifications, type NotificationRecord } from './notifications';
import './notifications.css';

const labels = { info: 'Info', ok: 'Done', warn: 'Warning', err: 'Error' };
const icons = { info: 'i', ok: '✓', warn: '!', err: '!' };
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });

function NotificationRow({ item }: { item: NotificationRecord }) {
  const [copyState, setCopyState] = useState('');
  const [copying, setCopying] = useState(false);
  return <details className={`notification-entry ${item.kind}${item.read ? '' : ' unread'}`}
    onToggle={event => { if (event.currentTarget.open) markNotificationsRead(item.id); }}>
    <summary>
      <time dateTime={new Date(item.lastAt).toISOString()}>{time(item.lastAt)}</time>
      <span className="notification-severity" aria-label={labels[item.kind]}>{icons[item.kind]}</span>
      <span className="notification-title">{item.title}</span>
      {item.count > 1 && <span className="notification-count" aria-label={`${item.count} occurrences`}>×{item.count}</span>}
      <span className="notification-chevron" aria-hidden>⌄</span>
    </summary>
    <div className="notification-details">
      <div className="notification-actions">
        <span>{labels[item.kind]}{item.count > 1 ? ` · First ${time(item.firstAt)} · Latest ${time(item.lastAt)}` : ''}</span>
        <button disabled={copying} onClick={async () => {
          setCopying(true);
          const copied = await copyNotificationDetails(item.details);
          setCopyState(copied ? 'Copied' : 'Could not copy. Select the details below to copy manually.');
          setCopying(false);
        }}>Copy details</button>
        <button onClick={() => dismissNotification(item.id)}>Dismiss</button>
        <span role="status">{copyState}</span>
      </div>
      <pre tabIndex={0} role="textbox" aria-readonly="true" aria-label="Notification details">{item.details}</pre>
    </div>
  </details>;
}

/** A shell dock, not a floating overlay: opening it reserves space below the workspace. */
export function NotificationHistory() {
  const items = useStore(notifications, value => value);
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(220);
  const body = useRef<HTMLDivElement>(null);
  const unread = items.filter(item => !item.read).length;
  const errors = items.filter(item => item.kind === 'err').length;
  return <section className={`notification-history${open ? ' expanded' : ''}`} aria-label="Notification history">
    {open && <SharedResizeHandle orientation="horizontal" label="Resize notification history" className="notification-resize"
      onResizeStart={element => {
        const scale = element.getBoundingClientRect().width / element.offsetWidth || 1;
        const start = (body.current?.getBoundingClientRect().height ?? height * scale) / scale;
        const max = Math.max(100, window.innerHeight / scale * .42 - 36);
        return (_dx, dy) => setHeight(Math.max(100, Math.min(max, start - dy / scale)));
      }} />}
    <header className="notification-header">
      {open && <>
        <span className="notification-retention">Latest {HISTORY_LIMIT} · This session</span>
        {unread > 0 && <button onClick={() => markNotificationsRead()}>Mark all read</button>}
        <button disabled={!items.length} onClick={clearNotifications}>Clear history</button>
      </>}
      <button className="notification-toggle" aria-expanded={open} aria-controls="notification-log"
        onClick={() => { if (!open) markNotificationsRead(); setOpen(!open); }}>
        <span aria-hidden>☷</span> Notifications
        {unread > 0 && <span className="notification-new">{unread} new</span>}
        {errors > 0 && <span className="notification-errors">{errors} {errors === 1 ? 'error' : 'errors'}</span>}
        <span aria-hidden>{open ? '⌄' : '⌃'}</span>
      </button>
    </header>
    {open && <div id="notification-log" className="notification-log" ref={body} style={{ height }}>
      {items.length ? items.map(item => <NotificationRow key={item.id} item={item} />)
        : <p className="notification-empty">No notifications. New messages will stay here until cleared or this session ends.</p>}
    </div>}
  </section>;
}