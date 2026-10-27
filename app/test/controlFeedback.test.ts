import { afterEach, describe, expect, it, vi } from 'vitest';
import { browseReadout, createControlFeedbackState, createFeedbackPublisher } from '../src/state/controlFeedback';
import { visibleClips, visibleFolders } from '../src/ws/browse/browseModel';
import type { LibraryClip } from '../src/engine';

afterEach(() => vi.useRealTimers());
const selection = (path = 'a') => ({ path, frames: 250, frame: 125, marks: { in: 25, out: 250 } });
const input = () => ({ folder: 'root', folders: ['root', 'other'], paths: ['a', 'b'], selection: selection() });

describe('read-only CT feedback', () => {
  it('uses raw integer frames and an exclusive OUT, without exposing paths', () => {
    const result = browseReadout(input());
    expect(result.values).toEqual({ folder: { text: '1/2', norm: 0 }, clip: { text: '1/2', norm: 0 },
      frame: { text: '125 f', norm: 125 / 249 }, in: { text: '25 f', norm: 25 / 249 },
      out: { text: '250 f', norm: 1 }, transpose: { text: '25 f', norm: 25 / 249 } });
    expect(JSON.stringify(result.values)).not.toContain('root');
  });
  it('clamps boundaries and omits absent or invalid marks', () => {
    const state = input(); state.selection.frame = 500; state.selection.marks = { in: -4, out: 999 };
    expect(browseReadout(state).values.frame).toEqual({ text: '249 f', norm: 1 });
    expect(browseReadout(state).values.out).toEqual({ text: '250 f', norm: 1 });
    expect(browseReadout({ ...state, selection: { ...state.selection, marks: undefined } }).values.in).toBeUndefined();
    expect(browseReadout({ ...state, selection: { ...state.selection, marks: { in: 40, out: 30 } } }).values.in).toBeUndefined();
  });
  it('uses the real filtered/sorted grid and expanded folder order', () => {
    const clips = [
      { path: 'a', name: 'Alpha', rating: 2, tags: [], probe: { codec: 'h264', durationSec: 3 } },
      { path: 'b', name: 'Beta', rating: 5, tags: ['motion'], probe: { codec: 'h264', durationSec: 8 } },
    ] as LibraryClip[];
    const source = input();
    const read = (q: string, chips: string[], sort: 'name' | 'duration') => browseReadout({ ...source, paths: visibleClips(clips, q, chips, sort).map(c => c.path) }).values;
    expect(read('', [], 'duration').clip?.text).toBe('2/2');
    expect(read('Alpha', [], 'name').clip?.text).toBe('1/1');
    expect(read('', ['motion'], 'name').clip).toBeUndefined();
    const tree = [{ path: 'root', children: [{ path: 'child', children: [] }] }, { path: 'other', children: [] }];
    expect(browseReadout({ ...source, folder: 'other', folders: visibleFolders(tree as never, { root: true }) }).values.folder?.text).toBe('3/3');
    expect(browseReadout({ ...source, folder: 'child', folders: visibleFolders(tree as never, {}) }).values.folder).toBeUndefined();
  });
  it('clears source values during loading and prevents stale zoom after selection changes', () => {
    const state = createControlFeedbackState(); let current: ReturnType<typeof input>['selection'] | undefined = selection();
    state.browse(() => browseReadout({ ...input(), selection: current }));
    state.zoom(() => ({ identity: 'raw:a', factor: 2.5 }));
    expect(state.snapshot('browse', 0, 0).values.zoom?.text).toBe('2.5x');
    current = undefined;
    expect(state.snapshot('browse', 0, 0).values).toEqual({ folder: { text: '1/2', norm: 0 } });
    current = { ...selection('b'), marks: undefined } as never;
    const values = state.snapshot('browse', 0, 0).values;
    expect(values.clip?.text).toBe('2/2'); expect(values.in).toBeUndefined(); expect(values.zoom).toBeUndefined();
  });
  it('clears on producer unmount without an old cleanup deleting a newer owner', () => {
    const state = createControlFeedbackState(), changed = vi.fn(); state.subscribe(changed);
    const old = state.browse(() => browseReadout(input()));
    const next = state.browse(() => browseReadout({ ...input(), selection: selection('b') }));
    old(); expect(state.snapshot('browse', 0, 0).values.clip?.text).toBe('2/2');
    const oldZoom = state.zoom(() => ({ identity: 'raw:a', factor: 2 }));
    const newZoom = state.zoom(() => ({ identity: 'raw:b', factor: 4 }));
    oldZoom(); expect(state.snapshot('browse', 0, 0).values.zoom?.text).toBe('4x');
    newZoom(); expect(state.snapshot('browse', 0, 0).values.zoom).toBeUndefined();
    next(); expect(state.snapshot('browse', 0, 0).values).toEqual({}); expect(changed).toHaveBeenCalledTimes(6);
  });
  it('uses bounded arrangement frames only on the three arrangement workspaces', () => {
    const state = createControlFeedbackState(); state.browse(() => browseReadout(input()));
    for (const workspace of ['mosh', 'node', 'render'] as const) {
      expect(state.snapshot(workspace, 500, 300).values).toEqual({ frame: { text: '299 f', norm: 1 } });
      expect(state.snapshot(workspace, 15, 0).values).toEqual({});
    }
    for (const workspace of ['home', 'settings'] as const) expect(state.snapshot(workspace, 125, 300).values).toEqual({});
  });
  it('reports the active block ordinal and omits empty or invalid selections', () => {
    const state = createControlFeedbackState();
    expect(state.snapshot('mosh', 0, 300, { index: 1, count: 4 }).values.block).toEqual({ text: '2/4', norm: 1 / 3 });
    expect(state.snapshot('mosh', 0, 300, { index: 2, count: 4 }).values.block?.text).toBe('3/4');
    expect(state.snapshot('mosh', 0, 0, { index: -1, count: 0 }).values.block).toBeUndefined();
    expect(state.snapshot('browse', 0, 300, { index: 1, count: 4 }).values.block).toBeUndefined();
  });
  it('suppresses identical snapshots and sends the latest trailing value at most every 50ms', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const state = createControlFeedbackState(), send = vi.fn(); let frame = 0;
    const publisher = createFeedbackPublisher(() => state.snapshot('mosh', frame, 500), send);
    publisher.changed();
    for (let i = 1; i <= 49; i++) { vi.advanceTimersByTime(1); frame = i; publisher.changed(); }
    expect(send).toHaveBeenCalledTimes(1); vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.lastCall?.[0].values.frame.text).toBe('49 f');
    publisher.changed(); vi.advanceTimersByTime(50); expect(send).toHaveBeenCalledTimes(2);
    frame = 70; publisher.changed(); expect(send).toHaveBeenCalledTimes(3);
    frame = 71; publisher.changed(); publisher.dispose(); vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('reads cleared owner/workspace on the trailing edge instead of sending queued old marks', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const state = createControlFeedbackState(), send = vi.fn(); let ws: 'browse' | 'home' = 'browse';
    const release = state.browse(() => browseReadout(input()));
    const publisher = createFeedbackPublisher(() => state.snapshot(ws, 0, 0), send);
    state.subscribe(publisher.changed); publisher.changed(); vi.advanceTimersByTime(5);
    release(); ws = 'home'; publisher.changed(); vi.advanceTimersByTime(45);
    expect(send.mock.lastCall?.[0]).toEqual({ workspace: 'home', values: {} });
    publisher.dispose();
  });
});
