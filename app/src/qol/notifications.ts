import { Children, isValidElement, type ReactNode } from 'react';
import { createStore } from '../state/store';

export type NotificationKind = 'info' | 'ok' | 'warn' | 'err';
export interface NotificationRecord {
  id: number;
  title: string;
  details: string;
  kind: NotificationKind;
  firstAt: number;
  lastAt: number;
  count: number;
  read: boolean;
}
export const HISTORY_LIMIT = 100;
export const REPEAT_WINDOW_MS = 10_000;
// Session-only, independent of toast timers, project history and workspace navigation.
// Snapshot strings only: never retain React trees, retry callbacks or project references.
export const notifications = createStore<NotificationRecord[]>([]);
let nextId = 0;

export function notificationText(node: ReactNode): string {
  return Children.toArray(node).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    if (isValidElement<{ children?: ReactNode }>(child)) return notificationText(child.props.children);
    return '';
  }).join(' ').replace(/\s+/g, ' ').trim();
}

export function recordNotification(input: Pick<NotificationRecord, 'title' | 'details' | 'kind'>, now = Date.now()) {
  const previous = notifications.get();
  // A tag alone is not identity: the same operation may fail with different contexts.
  const match = previous.find(item => now >= item.lastAt && now - item.lastAt <= REPEAT_WINDOW_MS &&
    item.kind === input.kind && item.title === input.title && item.details === input.details);
  const item: NotificationRecord = match
    ? { ...match, lastAt: now, count: match.count + 1, read: false }
    : { ...input, id: ++nextId, firstAt: now, lastAt: now, count: 1, read: false };
  notifications.set([item, ...previous.filter(record => record.id !== item.id)].slice(0, HISTORY_LIMIT));
  return item.id;
}
export const clearNotifications = () => notifications.set([]);
export const dismissNotification = (id: number) => notifications.set(items => items.filter(item => item.id !== id));
export const markNotificationsRead = (id?: number) => notifications.set(items => items.map(item =>
  (id === undefined || item.id === id) && !item.read ? { ...item, read: true } : item));

/** Never announce clipboard success until the user-requested write has succeeded. */
export async function copyNotificationDetails(details: string): Promise<boolean> {
  try {
    if (!globalThis.navigator?.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(details);
    return true;
  } catch { return false; }
}
/** Error contexts may contain cycles or bigint; reporting an error must not throw another one. */
export function notificationDetails(value: unknown): string {
  const ancestors: object[] = [];
  try {
    return JSON.stringify(value, function (_key, child) {
      if (typeof child === 'bigint') return String(child);
      if (!child || typeof child !== 'object') return child;
      while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
      if (ancestors.includes(child)) return '[Circular]';
      ancestors.push(child);
      return child;
    }, 2) ?? String(value);
  } catch { return 'Details could not be serialized. The notification title describes the failure.'; }
}