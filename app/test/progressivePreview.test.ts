import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameResult } from '../src/engine';
import { progressivePreview } from '../src/components/progressivePreview';
import { FrameView } from '../src/components/FrameView';

// Persistent hook harness: real component request/cancellation paths, controlled scheduling.
// Independent browser review still covers React/DOM integration.
const hooks = vi.hoisted(() => ({
  at: 0, values: [] as any[], effects: new Map<number, { deps: unknown[]; cleanup?: () => void }>(),
  next: [] as { at: number; fn: () => void | (() => void); deps: unknown[] }[],
  playing: false, subscribers: new Set<() => void>(), frame: vi.fn(), restart: null as null | (() => void),
  draw: vi.fn(), doc: { settings: { working: { w: 1920, h: 1080 } }, timeline: {}, resources: {}, modulators: {}, freezes: [] },
}));
vi.mock('react', () => ({
  useRef: (initial: unknown) => {
    const at = hooks.at++;
    return hooks.values[at] ??= { current: at === 0 ? { width: 0, height: 0, getContext: () => ({ drawImage: hooks.draw }) } : initial };
  },
  useState: (initial: unknown) => {
    const at = hooks.at++;
    if (!(at in hooks.values)) hooks.values[at] = at === 4 ? 640 : initial;
    return [hooks.values[at], (next: any) => { hooks.values[at] = typeof next === 'function' ? next(hooks.values[at]) : next; }];
  },
  useMemo: (fn: () => unknown, deps: unknown[]) => {
    const at = hooks.at++, prev = hooks.values[at];
    if (!prev || deps.some((v, i) => v !== prev.deps[i])) hooks.values[at] = { value: fn(), deps };
    return hooks.values[at].value;
  },
  useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
    const at = hooks.at++, prev = hooks.effects.get(at);
    if (!prev || deps.some((v, i) => v !== prev.deps[i])) hooks.next.push({ at, fn, deps });
  },
}));
vi.mock('../src/engine', () => ({ engine: { frame: hooks.frame, onRestart: (fn: () => void) => { hooks.restart = fn; return () => { hooks.restart = null; }; } } }));
vi.mock('../src/state/ui', () => ({ useSettings: () => true, uiStore: {
  get: () => ({ playing: hooks.playing }), subscribe: (fn: () => void) => { hooks.subscribers.add(fn); return () => hooks.subscribers.delete(fn); },
} }));
vi.mock('../src/state/project', () => ({ useProject: (select: (doc: unknown) => unknown) => select(hooks.doc), getDoc: () => hooks.doc }));
vi.mock('../src/state/telemetry', () => ({ countDropped: vi.fn() }));
vi.mock('../src/qol/qol', () => ({ Loading: () => null, asError: (error: Error) => ({ humanMessage: error.message }) }));

function renderViewer(frame = 9, quality: 'auto' | 'full' = 'auto', onState = vi.fn()) {
  hooks.at = 0; hooks.next = [];
  FrameView({ target: { kind: 'output', frame }, quality, progressive: true, onState });
  for (const e of hooks.next) hooks.effects.get(e.at)?.cleanup?.();
  for (const e of hooks.next) hooks.effects.set(e.at, { deps: e.deps, cleanup: e.fn() || undefined });
}
function unmountViewer() { for (const effect of hooks.effects.values()) effect.cleanup?.(); hooks.effects.clear(); }

function result(state: 'EXACT' | 'PROXY'): FrameResult {
  return { image: { close: vi.fn() } as unknown as ImageBitmap, state, route: state === 'EXACT' ? 'master' : 'proxy' };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function setup() {
  const ac = new AbortController();
  const request = vi.fn(async (_stage: 'draft' | 'full') => result('PROXY'));
  const present = vi.fn((_frame: FrameResult, _stage: 'draft' | 'full') => true);
  const current = vi.fn(() => true);
  return { ac, request, present, current, options: { signal: ac.signal, request, present, current, fullOnly: false, playing: false } };
}
beforeEach(() => {
  vi.useFakeTimers(); hooks.at = 0; hooks.values = []; hooks.effects.clear(); hooks.next = [];
  hooks.playing = false; hooks.subscribers.clear(); hooks.frame.mockReset(); hooks.draw.mockReset();
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { unmountViewer(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('progressive Program preview scheduling', () => {
  it('presents the draft immediately, then refines only after the quiet period', async () => {
    const { options, request, present } = setup();
    const work = progressivePreview(options); await settle();
    expect(request.mock.calls).toEqual([['draft']]);
    expect(present.mock.calls[0][1]).toBe('draft');
    await vi.advanceTimersByTimeAsync(299); expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await work;
    expect(request.mock.calls).toEqual([['draft'], ['full']]);
    expect(present.mock.calls.map(call => call[1])).toEqual(['draft', 'full']);
  });

  it('waits for a slow draft before requesting refinement, avoiding serial-queue contention', async () => {
    const { options, request, present } = setup();
    let land!: (frame: FrameResult) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { land = resolve; }));
    const work = progressivePreview(options);
    await vi.advanceTimersByTimeAsync(500); expect(request).toHaveBeenCalledTimes(1);
    land(result('PROXY')); await settle();
    expect(present).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await work;
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('cancels refinement and its timer when a target is superseded between stages', async () => {
    const { ac, options, request } = setup();
    const work = progressivePreview(options); await settle(); ac.abort();
    await work; await vi.advanceTimersByTimeAsync(1000);
    expect(request.mock.calls).toEqual([['draft']]); expect(vi.getTimerCount()).toBe(0);
  });

  it('Full goes straight to master, while Auto playback does not start a master render', async () => {
    const full = setup(); await progressivePreview({ ...full.options, fullOnly: true, playing: true });
    expect(full.request.mock.calls).toEqual([['full']]);
    const playing = setup(); await progressivePreview({ ...playing.options, playing: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(playing.request.mock.calls).toEqual([['draft']]);
  });

  it('skips unnecessary refinement when the worker serves a cached exact master first', async () => {
    const { options, request } = setup(); request.mockResolvedValue(result('EXACT'));
    await progressivePreview(options); await vi.advanceTimersByTimeAsync(1000);
    expect(request.mock.calls).toEqual([['draft']]);
  });

  it('keeps a valid draft after refinement fails, and does not loop for an approximate master', async () => {
    const fail = setup(); const onRefineError = vi.fn();
    fail.request.mockResolvedValueOnce(result('PROXY')).mockRejectedValueOnce(new Error('full failed'));
    const first = progressivePreview({ ...fail.options, onRefineError });
    await vi.advanceTimersByTimeAsync(300); await first;
    expect(fail.present).toHaveBeenCalledTimes(1); expect(onRefineError).toHaveBeenCalledOnce();
    const proxyMaster = setup(); const second = progressivePreview(proxyMaster.options);
    await vi.advanceTimersByTimeAsync(300); await second; await vi.advanceTimersByTimeAsync(1000);
    expect(proxyMaster.request.mock.calls).toEqual([['draft'], ['full']]);
    expect(proxyMaster.present.mock.calls[1][0].state).toBe('PROXY');
  });

  it('does not refine a stale or unmounted draft', async () => {
    const { options, present, request } = setup(); present.mockReturnValue(false);
    await progressivePreview(options); await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(1);
    const moved = setup(); const work = progressivePreview(moved.options); await settle(); moved.current.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(300); await work;
    expect(moved.request).toHaveBeenCalledTimes(1);
  });
});

describe('progressive FrameView integration', () => {
  it('requests a fresh draft after a worker restart even if the prior frame was fully refined', async () => {
    hooks.frame.mockImplementation(async () => result('PROXY'));
    renderViewer(); await vi.advanceTimersByTimeAsync(300); await settle();
    expect(hooks.frame.mock.calls.map(call => call[1].quality)).toEqual(['auto', 'full']);
    hooks.restart?.(); renderViewer(); await settle();
    expect(hooks.frame.mock.calls.at(-1)?.[1]).toMatchObject({ quality: 'auto', interactive: true });
  });

  it('keeps original viewport size in draft requests and refines on pause without a frame change', async () => {
    hooks.playing = true; hooks.frame.mockImplementation(async () => result('PROXY'));
    renderViewer(); await settle(); await vi.advanceTimersByTimeAsync(500);
    expect(hooks.frame).toHaveBeenCalledTimes(1);
    expect(hooks.frame.mock.calls[0][1]).toMatchObject({ w: 640, h: 360, quality: 'auto', interactive: true });
    hooks.playing = false; hooks.subscribers.forEach(fn => fn()); renderViewer(); await settle();
    await vi.advanceTimersByTimeAsync(300);
    expect(hooks.frame.mock.calls.at(-1)?.[1]).toEqual({ w: 640, h: 360, quality: 'full', priority: 'foreground' });
    expect(hooks.frame).toHaveBeenCalledTimes(3);
  });

  it('aborts on unmount even when the latest playback effect was throttled, closing its late frame', async () => {
    hooks.playing = true;
    let land!: (frame: FrameResult) => void;
    hooks.frame.mockImplementation(() => new Promise(resolve => { land = resolve; }));
    renderViewer(9); renderViewer(10);
    expect(hooks.frame).toHaveBeenCalledTimes(1);
    const signal = hooks.frame.mock.calls[0][2] as AbortSignal;
    unmountViewer(); expect(signal.aborted).toBe(true);
    const late = result('PROXY'); land(late); await settle();
    expect(late.image.close).toHaveBeenCalledOnce(); expect(hooks.draw).not.toHaveBeenCalled();
  });

  it('does not downgrade an unchanged full-stage frame when switching Full to Auto', async () => {
    hooks.frame.mockImplementation(async () => result('PROXY')); // Full may legitimately use an approximate effect.
    const state = vi.fn(); renderViewer(9, 'full', state); await settle();
    expect(state).toHaveBeenLastCalledWith('PROXY');
    renderViewer(9, 'auto', state); await settle();
    expect(hooks.frame.mock.calls.map(call => call[1].quality)).toEqual(['full', 'full']);
    expect(hooks.frame.mock.calls.every(call => !call[1].interactive)).toBe(true);
  });

  it('cancels a full refinement when scrubbing again, ignoring its late bitmap', async () => {
    let lateFull!: (frame: FrameResult) => void;
    hooks.frame.mockImplementation(async (_target, size) => size.interactive ? result('PROXY') : new Promise(resolve => { lateFull = resolve; }));
    renderViewer(9); await settle(); await vi.advanceTimersByTimeAsync(300);
    const fullSignal = hooks.frame.mock.calls[1][2] as AbortSignal;
    renderViewer(10); expect(fullSignal.aborted).toBe(true); await settle();
    const late = result('EXACT'); hooks.draw.mockClear(); lateFull(late); await settle();
    expect(late.image.close).toHaveBeenCalledOnce(); expect(hooks.draw).not.toHaveBeenCalled();
  });

  it('preempts a playback draft on an edit even after intervening throttled playhead ticks', async () => {
    hooks.playing = true; hooks.frame.mockImplementation(() => new Promise(() => {}));
    renderViewer(9); const signal = hooks.frame.mock.calls[0][2] as AbortSignal;
    renderViewer(10); expect(hooks.frame).toHaveBeenCalledTimes(1);
    hooks.doc = { ...hooks.doc, timeline: {} }; renderViewer(10);
    expect(signal.aborted).toBe(true); expect(hooks.frame).toHaveBeenCalledTimes(2);
  });
});
