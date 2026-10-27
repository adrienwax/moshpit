import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  frame: vi.fn(), effects: [] as (() => void | (() => void))[], refs: 0, states: 0,
  restart: null as (() => void) | null, kick: vi.fn(), refining: vi.fn(), playing: false,
  canvas: { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }) },
}));
vi.mock('react', () => ({
  useEffect: (fn: () => void | (() => void)) => mocks.effects.push(fn),
  useMemo: (fn: () => unknown) => fn(),
  useRef: (value: unknown) => ({ current: mocks.refs++ === 0 ? mocks.canvas : value }),
  useState: (initial: unknown) => { const index = mocks.states++; return [index === 2 ? 320 : initial, index === 3 ? mocks.kick : index === 4 ? mocks.refining : vi.fn()]; },
}));
vi.mock('../src/engine', () => ({ engine: { frame: mocks.frame, onRestart: (fn: () => void) => { mocks.restart = fn; return () => { mocks.restart = null; }; } } }));
vi.mock('../src/state/ui', () => ({ uiStore: { get: () => ({ playing: mocks.playing }) }, useSettings: () => true }));
vi.mock('../src/state/project', () => ({ getDoc: () => ({ resources: { sources: [], conforms: [] } }), useProject: () => null }));
vi.mock('../src/state/telemetry', () => ({ countDropped: vi.fn() }));
vi.mock('../src/qol/qol', () => ({ Loading: () => null, asError: (error: Error) => ({ humanMessage: error.message }) }));
import { FrameView } from '../src/components/FrameView';

beforeEach(() => {
  vi.clearAllMocks(); mocks.effects.length = 0; mocks.refs = 0; mocks.states = 0;
  mocks.restart = null; mocks.playing = false;
  vi.stubGlobal('devicePixelRatio', 1);
});
function pending() {
  let reject!: (error: Error) => void;
  mocks.frame.mockReturnValue(new Promise((_, no) => { reject = no; }));
  return reject;
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }
describe('FrameView scope failure notification', () => {
  it('forwards Full quality and reports only the displayed frame state', async () => {
    const onState = vi.fn(), close = vi.fn();
    mocks.frame.mockResolvedValue({ image: { width: 320, height: 180, close }, state: 'EXACT', route: '1920×1080 master' });
    FrameView({ target: { kind: 'output', frame: 9 }, quality: 'full', onState });
    mocks.effects.at(-1)!(); await settle();
    expect(mocks.frame.mock.calls[0][1]).toMatchObject({ quality: 'full' });
    expect(onState).toHaveBeenCalledExactlyOnceWith('EXACT');
    expect(close).toHaveBeenCalledOnce();
  });
  it('clears the visible state on unmount and never publishes a late decoded frame', async () => {
    let resolve!: (value: unknown) => void;
    mocks.frame.mockReturnValue(new Promise(yes => { resolve = yes; }));
    const onState = vi.fn(), close = vi.fn();
    FrameView({ target: { kind: 'output', frame: 9 }, onState });
    const unmount = mocks.effects[0](); mocks.effects.at(-1)!(); unmount?.();
    resolve({ image: { width: 320, height: 180, close }, state: 'EXACT', route: 'master' });
    await settle();
    expect(onState).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(close).toHaveBeenCalledOnce();
  });
  it('reports current-frame failure so conformed IN scopes can clear old pixels', async () => {
    const reject = pending(), onError = vi.fn();
    FrameView({ target: { kind: 'output', frame: 9 }, onError });
    mocks.effects.at(-1)!();
    reject(new Error('Frame unavailable')); await settle();
    expect(onError).toHaveBeenCalledExactlyOnceWith('Frame unavailable');
  });
  it('ignores a superseded frame failure, preserving the new request scope state', async () => {
    const reject = pending(), onError = vi.fn();
    FrameView({ target: { kind: 'output', frame: 9 }, onError });
    const cleanup = mocks.effects.at(-1)!(); cleanup?.();
    reject(new Error('Old frame failed')); await settle();
    expect(onError).not.toHaveBeenCalled();
  });
  it('does not notify a preview that unmounted while decoding', async () => {
    const reject = pending(), onError = vi.fn();
    FrameView({ target: { kind: 'output', frame: 9 }, onError });
    const unmount = mocks.effects[0]();
    mocks.effects.at(-1)!(); unmount?.();
    reject(new Error('Late error')); await settle();
    expect(onError).not.toHaveBeenCalled();
  });

  it('requests a paused-frame refresh after restart and discards a late old-worker bitmap', async () => {
    let resolve!: (value: unknown) => void;
    mocks.frame.mockReturnValue(new Promise(yes => { resolve = yes; }));
    const onFrame = vi.fn(), close = vi.fn();
    FrameView({ target: { kind: 'output', frame: 9 }, onFrame });
    const unsubscribe = mocks.effects[1](); mocks.effects.at(-1)!();
    mocks.restart!();
    expect(mocks.kick).toHaveBeenCalledOnce();
    expect(mocks.refining).toHaveBeenCalledWith(false);
    resolve({ image: { width: 320, height: 180, close }, state: 'EXACT', route: 'old worker' });
    await settle();
    expect(onFrame).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
    unsubscribe?.(); expect(mocks.restart).toBeNull();
  });

  it('marks Program draft requests as playback only while playing (the service reads ahead only then)', async () => {
    mocks.frame.mockReturnValue(new Promise(() => {}));
    FrameView({ target: { kind: 'output', frame: 9 }, progressive: true });
    mocks.effects.at(-1)!(); await settle();
    expect(mocks.frame.mock.calls[0][1]).not.toHaveProperty('playback');
    mocks.effects.length = 0; mocks.refs = 0; mocks.states = 0; mocks.playing = true;
    FrameView({ target: { kind: 'output', frame: 10 }, progressive: true });
    mocks.effects.at(-1)!(); await settle();
    expect(mocks.frame.mock.calls[1][1]).toMatchObject({ quality: 'auto', interactive: true, playback: true });
  });

  it('marks a paused Auto draft as refining until its exact frame lands', async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn();
      mocks.frame
        .mockResolvedValueOnce({ image: { width: 320, height: 180, close }, state: 'PROXY', route: 'proxy' })
        .mockResolvedValueOnce({ image: { width: 320, height: 180, close }, state: 'EXACT', route: 'master' });
      FrameView({ target: { kind: 'output', frame: 9 }, progressive: true });
      mocks.effects.at(-1)!(); await settle();
      expect(mocks.refining.mock.calls).toEqual([[true]]);
      await vi.advanceTimersByTimeAsync(400);
      expect(mocks.frame.mock.calls[1][1]).toMatchObject({ quality: 'full' });
      expect(mocks.refining.mock.calls).toEqual([[true], [false]]);
    } finally { vi.useRealTimers(); }
  });
  it('clears a refining badge when the Program target is removed', () => {
    const onState = vi.fn();
    FrameView({ target: null, progressive: true, onState });
    mocks.effects[3]();
    expect(mocks.refining).toHaveBeenCalledExactlyOnceWith(false);
    expect(onState).toHaveBeenCalledExactlyOnceWith(undefined);
  });

});


it('labels a background preview explicitly and cancels it on unmount during playback', async () => {
  mocks.playing = true;
  pending();
  FrameView({ target: { kind: 'trial', blockId: 'b' as never, graph: {} as never, frame: 9 }, priority: 'background' });
  const unmount = mocks.effects[0](); mocks.effects.at(-1)!();
  expect(mocks.frame.mock.calls[0][1]).toMatchObject({ priority: 'background' });
  const signal = mocks.frame.mock.calls[0][2] as AbortSignal;
  expect(signal.aborted).toBe(false);
  unmount?.();
  expect(signal.aborted).toBe(true);
});
