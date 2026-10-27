import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerEngine } from '../src/engine/workerEngine';

let listeners: ((event: any) => void)[];
beforeEach(() => {
  listeners = [];
  vi.stubGlobal('window', { addEventListener: (_name: string, fn: (event: any) => void) => listeners.push(fn) });
});
afterEach(() => { vi.unstubAllGlobals(); });
const attach = () => {
  const port = { start: vi.fn(), postMessage: vi.fn(), onmessage: null as ((event: any) => void) | null };
  listeners.forEach(fn => fn({ data: 'moshpit-engine-port', ports: [port] }));
  return port;
};
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('worker cancellation', () => {
  it('does not send a render cancelled while waiting for the first engine port', async () => {
    const engine = createWorkerEngine();
    const task = engine.render({} as never, () => {});
    void task.promise.catch(() => {});
    await settle(); // the call is now actually registered in the port waiters
    task.cancel();
    await expect(task.promise).rejects.toMatchObject({ name: 'AbortError' });
    const port = attach(); await settle();
    const requests = port.postMessage.mock.calls.map(c => c[0]);
    for (const request of requests) port.onmessage?.({ data: { id: request.id, ok: true, value: undefined } });
    expect(requests.filter(r => r.method === 'render')).toEqual([]);
  });

  it('honors immediate cancellation even if a port already exists', async () => {
    const engine = createWorkerEngine(), port = attach();
    const task = engine.importClip('C:/review/clip.mp4');
    void task.promise.catch(() => {});
    task.cancel(); await settle();
    const requests = port.postMessage.mock.calls.map(c => c[0]);
    for (const request of requests) port.onmessage?.({ data: { id: request.id, ok: true, value: undefined } });
    expect(requests.filter(r => r.method === 'importClip')).toEqual([]);
  });

  it('sends cancellation once for an already dispatched task and ignores its late success', async () => {
    const engine = createWorkerEngine(), port = attach();
    const task = engine.importClip('C:/review/clip.mp4');
    void task.promise.catch(() => {}); await settle();
    const request = port.postMessage.mock.calls[0][0];
    task.cancel(); task.cancel();
    await expect(task.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(port.postMessage.mock.calls.map(c => c[0])).toEqual([request, { id: request.id, cancel: true }]);
    port.onmessage?.({ data: { id: request.id, ok: true, value: 'late' } });
    await expect(task.promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('awaits dispatched render cleanup before settling cancellation and does not accept late success', async () => {
    const engine = createWorkerEngine(), port = attach();
    const task = engine.render({} as never, () => {}), rejected = vi.fn(), resolved = vi.fn();
    void task.promise.then(resolved, rejected); await settle();
    const request = port.postMessage.mock.calls[0][0];
    task.cancel(); task.cancel(); await settle();
    expect(rejected).not.toHaveBeenCalled(); expect(resolved).not.toHaveBeenCalled();
    expect(port.postMessage.mock.calls.map(c => c[0])).toEqual([request, { id: request.id, cancel: true }]);
    port.onmessage?.({ data: { id: request.id, ok: true, value: 'finished-before-cancel' } });
    await expect(task.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(resolved).not.toHaveBeenCalled();
  });

  it('settles a cancelled render on the worker error acknowledgement', async () => {
    const engine = createWorkerEngine(), port = attach();
    const task = engine.render({} as never, () => {}); void task.promise.catch(() => {}); await settle();
    const request = port.postMessage.mock.calls[0][0]; task.cancel();
    const error = { code: 'INTERNAL', context: { method: 'render' } };
    port.onmessage?.({ data: { id: request.id, ok: false, error } });
    await expect(task.promise).rejects.toEqual(error);
  });

  it('settles a cancellation waiting for cleanup if its worker crashes without cancelling a new worker', async () => {
    const engine = createWorkerEngine(), port = attach();
    const task = engine.render({} as never, () => {}); void task.promise.catch(() => {}); await settle(); task.cancel();
    listeners.forEach(fn => fn({ data: { type: 'moshpit-engine-crashed', reason: 'crashed' } }));
    await expect(task.promise).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
    const replacement = attach(); task.cancel(); expect(replacement.postMessage).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledTimes(2);
  });

  it('removes cancellation listeners after success', async () => {
    const engine = createWorkerEngine(), port = attach();
    const task = engine.importClip('C:/review/clip.mp4'); await settle();
    const request = port.postMessage.mock.calls[0][0];
    port.onmessage?.({ data: { id: request.id, ok: true, value: 'done' } });
    await expect(task.promise).resolves.toBe('done');
    task.cancel(); expect(port.postMessage).toHaveBeenCalledTimes(1);
  });

  it('does not send an old cancellation id to a replacement worker after a crash', async () => {
    const engine = createWorkerEngine(), port = attach();
    const task = engine.importClip('C:/review/clip.mp4'); void task.promise.catch(() => {}); await settle();
    listeners.forEach(fn => fn({ data: { type: 'moshpit-engine-crashed', reason: 'crashed', exitCode: 133, cause: 'gpu-context-lost' } }));
    await expect(task.promise).rejects.toMatchObject({ code: 'WORKER_CRASHED', context: { reason: 'crashed', exitCode: 133, cause: 'gpu-context-lost' } });
    const replacement = attach(); task.cancel();
    expect(replacement.postMessage).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects an already-aborted frame without waiting for a port', async () => {
    const engine = createWorkerEngine(), ac = new AbortController(); ac.abort();
    await expect(engine.frame({ kind: 'output', frame: 0 }, { w: 16, h: 16 }, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const port = attach(); await settle(); expect(port.postMessage).not.toHaveBeenCalled();
  });

  it('reports a port send failure instead of leaving the task pending', async () => {
    const engine = createWorkerEngine(), port = attach();
    port.postMessage.mockImplementation(() => { throw new Error('port closed'); });
    await expect(engine.importClip('C:/review/clip.mp4').promise).rejects.toThrow('port closed');
  });

  it('notifies paused viewers only after a replacement port has received the latest project', () => {
    const engine = createWorkerEngine(), restarted = vi.fn();
    const unsubscribe = engine.onRestart!(restarted);
    const doc = { name: 'latest edits' } as never;
    engine.updateProject(doc); attach();
    expect(restarted).not.toHaveBeenCalled();
    listeners.forEach(fn => fn({ data: { type: 'moshpit-engine-crashed', reason: 'crashed' } }));
    const replacement = attach();
    expect(replacement.postMessage).toHaveBeenCalledWith({ id: 0, method: 'updateProject', args: [doc] });
    expect(restarted).toHaveBeenCalledOnce();
    unsubscribe();
    listeners.forEach(fn => fn({ data: { type: 'moshpit-engine-crashed', reason: 'crashed' } })); attach();
    expect(restarted).toHaveBeenCalledOnce();
  });
});
