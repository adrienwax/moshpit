import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, Fragment } from 'react';
import { MoshpitError } from '@moshpit/engine';
import { toast, toastError } from '../src/qol/qol';
import { clearNotifications, copyNotificationDetails, dismissNotification, HISTORY_LIMIT, markNotificationsRead, notifications, recordNotification, REPEAT_WINDOW_MS } from '../src/qol/notifications';

const input = { title: 'Decode failed', details: '{"source":"clip-a","frame":12}', kind: 'err' as const };
beforeEach(() => { vi.useFakeTimers(); clearNotifications(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.runAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('session notification history', () => {
  it('retains structured worker errors after the brief toast expires and unrelated success arrives', () => {
    const err = new MoshpitError('WORKER_CRASHED', { reason: 'crashed', sourceId: 'clip-a' });
    toastError(err);
    const saved = notifications.get()[0];
    expect(saved.details).toBe(JSON.stringify(err.toJSON(), null, 2));
    vi.advanceTimersByTime(60_000);
    toast('Saved project', { kind: 'ok' });
    expect(notifications.get()).toContainEqual(saved);
    expect(notifications.get()[0].title).toBe('Saved project');
  });
  it('snapshots formatted toast text, without retaining markup or callbacks', () => {
    toast(h(Fragment, null, h('b', null, 'Conform changed'), ' ', h('span', null, 'Re-import to retry.')), { action: { label: 'Retry', run: vi.fn() } });
    expect(notifications.get()[0].details).toBe('Conform changed Re-import to retry.');
    expect(notifications.get()[0]).not.toHaveProperty('action');
  });
  it('toast tag replacement and the three-toast display cap never erase history', () => {
    for (let i = 0; i < 8; i++) toast(`Operation ${i}`, { tag: 'same-tag' });
    vi.runAllTimers();
    expect(notifications.get()).toHaveLength(8);
  });
  it('deduplicates exact repeats in a rolling ten-second flood, increments count and reopens unread state', () => {
    const id = recordNotification(input, 100);
    markNotificationsRead();
    recordNotification({ ...input, title: 'Another message' }, 120);
    recordNotification(input, 200);
    expect(notifications.get()).toHaveLength(2);
    expect(notifications.get()[0]).toMatchObject({ id, firstAt: 100, lastAt: 200, count: 2, read: false });
  });
  it('keeps different contexts and later recurrences distinct', () => {
    recordNotification(input, 100);
    recordNotification({ ...input, details: '{"source":"clip-b","frame":12}' }, 200);
    recordNotification(input, 101 + REPEAT_WINDOW_MS);
    expect(notifications.get()).toHaveLength(3);
  });
  it('bounds history by most recent activity and retains a repeated old error when trimming', () => {
    const id = recordNotification(input, 0);
    for (let i = 1; i < HISTORY_LIMIT; i++) recordNotification({ ...input, title: `Saved ${i}`, kind: 'ok' }, i);
    recordNotification(input, HISTORY_LIMIT);
    recordNotification({ ...input, title: 'Latest message' }, HISTORY_LIMIT + 1);
    expect(notifications.get()).toHaveLength(HISTORY_LIMIT);
    expect(notifications.get()[1]).toMatchObject({ id, count: 2 });
    expect(notifications.get().find(item => item.title === 'Saved 1')).toBeUndefined();
  });
  it('marks one item read, dismisses one and explicitly clears retained history', () => {
    const a = recordNotification(input);
    const b = recordNotification({ ...input, title: 'Second' });
    markNotificationsRead(a);
    expect(notifications.get().find(item => item.id === a)?.read).toBe(true);
    expect(notifications.get().find(item => item.id === b)?.read).toBe(false);
    dismissNotification(a);
    expect(notifications.get().map(item => item.id)).toEqual([b]);
    clearNotifications();
    vi.runAllTimers();
    expect(notifications.get()).toEqual([]);
  });
  it('retains cyclic or bigint contexts without turning error reporting into another error', () => {
    const context: Record<string, unknown> = { counter: 12n };
    context.self = context;
    expect(() => toastError(new MoshpitError('INTERNAL', context))).not.toThrow();
    expect(JSON.parse(notifications.get()[0].details).context).toEqual({ counter: '12', self: '[Circular]' });
  });
  it('does not log cancellation as an error', () => {
    toastError(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    expect(notifications.get()).toEqual([]);
  });
  it('does not copy automatically; explicit copy writes the full retained payload', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const id = recordNotification(input);
    markNotificationsRead(id);
    expect(writeText).not.toHaveBeenCalled();
    expect(await copyNotificationDetails(notifications.get()[0].details)).toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(input.details);
  });
  it('reports clipboard rejection or absence without recursively creating notifications', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    expect(await copyNotificationDetails(input.details)).toBe(false);
    vi.stubGlobal('navigator', {});
    expect(await copyNotificationDetails(input.details)).toBe(false);
    expect(notifications.get()).toEqual([]);
  });
});