import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Actual worker dispatcher, controlled asynchronous engine. No Electron/GPU or owner files.
const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: any) => void>(), events: [] as string[],
  hold: '', cleanup: undefined as (() => void) | undefined,
  active: 0, peak: 0,
}));
vi.mock('electron', () => ({ ipcRenderer: { on: (name: string, fn: any) => state.handlers.set(name, fn), send: vi.fn() } }));
vi.mock('../../engine/src/telemetry/system', () => ({ FrameCost: class { add() {} }, dirBytes: async () => 0, sampleGpu: async () => null }));
vi.mock('../electron/engine-cache', () => ({ capFreezes: () => ({ files: 0 }) }));
vi.mock('../../engine/src/service/service', () => ({ EngineService: class {
  onConformUpdate() {} dispose() {}
  updateProject() { state.events.push('project'); }
  async run(name: string, signal?: AbortSignal) {
    state.events.push(`${name}:start`);
    state.peak = Math.max(state.peak, ++state.active);
    try {
      if (name === state.hold) {
        await new Promise<void>((resolve) => {
          signal!.addEventListener('abort', () => {
            state.events.push(`${name}:abort`);
            state.cleanup = resolve;
          }, { once: true });
        });
        signal!.throwIfAborted();
      }
    } finally { state.active--; state.events.push(`${name}:end`); }
  }
  async frame(target: { frame: number }, _size: unknown, signal?: AbortSignal) {
    await this.run(`frame${target.frame}`, signal);
    return { w: 1, h: 1, data: new Uint8Array(4), state: 'EXACT' };
  }
  async idle(_chunk: number, signal?: AbortSignal) { await this.run('idle', signal); return false; }
} }));

beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules(); state.handlers.clear(); state.events = [];
  state.hold = ''; state.cleanup = undefined; state.active = 0; state.peak = 0;
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  vi.stubGlobal('location', { search: '?cache=unused&library=unused' });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
async function setup() {
  await import('../electron/worker');
  const port: any = { postMessage: vi.fn(), start: vi.fn() };
  state.handlers.get('engine:port')!({ ports: [port] });
  return {
    port,
    send: (data: object) => port.onmessage({ data }),
    frame: (id: number, frame: number) => port.onmessage({ data: { id, method: 'frame', args: [{ kind: 'output', frame }, { w: 1, h: 1 }] } }),
  };
}

it('cancels the active stale frame and skips queued stale frames before drawing the newest', async () => {
  state.hold = 'frame1';
  const { frame, send, port } = await setup();
  frame(1, 1); await settle();
  frame(2, 2); frame(3, 3);
  send({ id: 1, cancel: true }); send({ id: 2, cancel: true }); await settle();
  expect(state.events).toEqual(['frame1:start', 'frame1:abort']);
  state.cleanup!(); await settle();
  expect(state.events).toEqual(['frame1:start', 'frame1:abort', 'frame1:end', 'frame3:start', 'frame3:end']);
  expect(state.peak).toBe(1);
  expect(port.postMessage.mock.calls.map(([reply]: any) => [reply.id, reply.ok])).toEqual([[1, false], [2, false], [3, true]]);
});

it('preempts cache filling but waits for cleanup before project mutation and the next frame', async () => {
  state.hold = 'idle';
  const { frame, send } = await setup();
  send({ id: 1, method: 'updateProject', args: [{ freezes: [] }] }); await settle();
  await vi.advanceTimersByTimeAsync(250);
  expect(state.events).toEqual(['project', 'idle:start']);
  send({ id: 2, method: 'updateProject', args: [{ freezes: [] }] }); frame(3, 3); await settle();
  expect(state.events).toEqual(['project', 'idle:start', 'idle:abort']);
  state.cleanup!(); await settle();
  expect(state.events).toEqual(['project', 'idle:start', 'idle:abort', 'idle:end', 'project', 'frame3:start', 'frame3:end']);
  expect(state.peak).toBe(1);
});


it('foreground preview preempts a running poster, waits for cleanup, then resumes that same poster', async () => {
  state.hold = 'frame1';
  const { frame, send, port } = await setup();
  send({ id: 1, method: 'frame', args: [{ kind: 'source', frame: 1 }, { w: 800, h: 1, priority: 'background' }] });
  await settle(); frame(2, 2); await settle();
  expect(state.events).toEqual(['frame1:start', 'frame1:abort']);
  expect(port.postMessage).not.toHaveBeenCalled();
  state.hold = ''; state.cleanup!(); await settle();
  expect(state.events).toEqual(['frame1:start', 'frame1:abort', 'frame1:end', 'frame2:start', 'frame2:end', 'frame1:start', 'frame1:end']);
  expect(state.peak).toBe(1);
  expect(port.postMessage.mock.calls.map(([r]: any) => [r.id, r.ok])).toEqual([[2, true], [1, true]]);
});

it('a poster cancelled during preemption is not resurrected after the foreground completes', async () => {
  state.hold = 'frame1';
  const { frame, send, port } = await setup();
  send({ id: 1, method: 'frame', args: [{ kind: 'output', frame: 1 }, { w: 1, h: 1, priority: 'background' }] });
  await settle(); frame(2, 2); await settle(); send({ id: 1, cancel: true });
  state.hold = ''; state.cleanup!(); await settle();
  expect(state.events).toEqual(['frame1:start', 'frame1:abort', 'frame1:end', 'frame2:start', 'frame2:end']);
  expect(state.peak).toBe(1);
  expect(port.postMessage.mock.calls.map(([r]: any) => [r.id, r.ok])).toEqual([[1, false], [2, true]]);
});

it('a foreground request arriving before a queued poster starts runs first without dropping the poster', async () => {
  const { frame, send, port } = await setup();
  send({ id: 1, method: 'frame', args: [{ kind: 'source', frame: 1 }, { w: 1, h: 1, priority: 'background' }] });
  frame(2, 2); await settle();
  expect(state.events).toEqual(['frame2:start', 'frame2:end', 'frame1:start', 'frame1:end']);
  expect(port.postMessage.mock.calls.map(([r]: any) => [r.id, r.ok])).toEqual([[2, true], [1, true]]);
});

it('explicit foreground priority keeps a small audition in front of background work', async () => {
  const { send } = await setup();
  send({ id: 1, method: 'frame', args: [{ kind: 'source', frame: 1 }, { w: 1, h: 1, priority: 'background' }] });
  send({ id: 2, method: 'frame', args: [{ kind: 'trial', frame: 2 }, { w: 1, h: 1, priority: 'foreground' }] });
  await settle();
  expect(state.events).toEqual(['frame2:start', 'frame2:end', 'frame1:start', 'frame1:end']);
});
