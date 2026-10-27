// Queue/metadata contracts only: no GPU or real-media rendering is exercised here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportConfig, ProjectDoc } from '@moshpit/engine';
import type { SavedPreview } from '../src/state/previews';

const mocks = vi.hoisted(() => ({
  render: vi.fn(), getDoc: vi.fn(), ensureDir: vi.fn(), nextFree: vi.fn(),
  readConfig: vi.fn(), writeConfig: vi.fn(), clearPreviews: vi.fn(), toastError: vi.fn(),
}));
vi.mock('../src/engine', () => ({ engine: { render: mocks.render } }));
vi.mock('../src/state/project', () => ({ getDoc: mocks.getDoc }));
vi.mock('../src/state/ui', () => ({ setUi: vi.fn(), settingsStore: { get: () => ({ paths: { output: 'C:/out' } }) } }));
vi.mock('../src/qol/qol', () => ({ toast: vi.fn(), toastError: mocks.toastError, asError: (e: Error) => ({ toJSON: () => ({ code: 'INTERNAL', humanMessage: e.message }) }) }));
vi.mock('../src/host', () => ({ host: {
  readConfig: mocks.readConfig, writeConfig: mocks.writeConfig,
  files: { ensureDir: mocks.ensureDir, nextFree: mocks.nextFree, clearPreviews: mocks.clearPreviews },
} }));

let queue: typeof import('../src/state/render');
let shelf: typeof import('../src/state/previews');
const doc = (id: string): ProjectDoc => ({ id, name: id, timeline: { blocks: [] } }) as unknown as ProjectDoc;
const config = (): ExportConfig => ({ format: 'mp4-h264', width: 960, height: 540, audio: false, range: [0, 9] });
const oldPreview: SavedPreview = { id: 'old-preview', path: 'C:/cache/preview/preview_old.mp4', label: 'Old preview', projectId: 'A', createdAt: 1, scope: 'Full timeline' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject, cancel: vi.fn() };
}
const done = async () => vi.waitFor(() => expect(queue.renderStore.get().every(j => ['done', 'failed', 'cancelled'].includes(j.status))).toBe(true));

beforeEach(async () => {
  vi.resetModules();
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.getDoc.mockReturnValue(doc('A'));
  mocks.ensureDir.mockResolvedValue(undefined);
  mocks.nextFree.mockImplementation(async (candidate: string, taken: string[]) => {
    let next = candidate, n = 1;
    while (taken.includes(next)) next = candidate.replace(/\.mp4$/, `_v${++n}.mp4`);
    return next;
  });
  mocks.readConfig.mockResolvedValue([]);
  mocks.writeConfig.mockResolvedValue('previews.json');
  mocks.clearPreviews.mockResolvedValue(0);
  mocks.render.mockImplementation(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  queue = await import('../src/state/render');
  shelf = await import('../src/state/previews');
});
afterEach(() => vi.restoreAllMocks());

describe('render queue owns each requested snapshot', () => {
  it('captures the document and config before asynchronous output-folder allocation', async () => {
    const folder = deferred<void>(), original = doc('A'), settings = config();
    mocks.getDoc.mockReturnValue(original);
    mocks.ensureDir.mockReturnValueOnce(folder.promise);
    const adding = queue.addJob('export', settings, 'C:/out');
    await vi.waitFor(() => expect(mocks.ensureDir).toHaveBeenCalled());
    mocks.getDoc.mockReturnValue(doc('B'));
    settings.width = 1920; settings.range![1] = 99;
    folder.resolve(); await adding; await done();
    expect(mocks.render.mock.calls[0][0]).toMatchObject({ doc: original, config: { width: 960, range: [0, 9] } });
  });

  it('rapid requests reserve distinct paths and preserve each project while an earlier render runs', async () => {
    const first = deferred<void>();
    mocks.render.mockReturnValueOnce(first);
    const addingA = queue.addJob('same', config(), 'C:/out');
    mocks.getDoc.mockReturnValue(doc('B'));
    const addingB = queue.addJob('same', config(), 'C:/out');
    await Promise.all([addingA, addingB]);
    expect(mocks.render).toHaveBeenCalledTimes(1);
    const jobs = queue.renderStore.get();
    expect(new Set(jobs.map(j => j.outPath)).size).toBe(2);
    expect(mocks.nextFree.mock.calls[1][1]).toContain(jobs[0].outPath);
    first.resolve(); await done();
    expect(mocks.render.mock.calls.map(c => c[0].doc.id)).toEqual(['A', 'B']);
  });

  it('records the original preview project and keeps history after Clear done', async () => {
    const rendering = deferred<void>();
    mocks.render.mockReturnValueOnce(rendering);
    mocks.readConfig.mockResolvedValue([oldPreview]);
    await queue.addJob('preview_new', config(), 'C:/cache/preview', { quick: true, previewScope: 'Block 2' });
    mocks.getDoc.mockReturnValue(doc('B'));
    rendering.resolve();
    await vi.waitFor(() => expect(shelf.previewsStore.get()).toHaveLength(2));
    await vi.waitFor(() => expect(mocks.clearPreviews).toHaveBeenCalled());
    expect(shelf.previewsStore.get()[0]).toMatchObject({ projectId: 'A', scope: 'Block 2' });
    queue.clearDone();
    expect(queue.renderStore.get()).toEqual([]);
    expect(shelf.previewsStore.get()).toHaveLength(2);
    expect(mocks.clearPreviews).toHaveBeenCalledWith(expect.arrayContaining([oldPreview.path]));
  });

  it('keeps the old preview when a capture fails and retries the same document after switching projects', async () => {
    const first = deferred<void>();
    mocks.render.mockReturnValueOnce(first);
    mocks.readConfig.mockResolvedValue([oldPreview]);
    await shelf.loadPreviews();
    shelf.quickStore.set(oldPreview);
    await queue.addJob('preview_failed', config(), 'C:/cache/preview', { quick: true });
    first.reject(new Error('encode failed')); await done();
    const failed = queue.renderStore.get()[0];
    expect(failed.status).toBe('failed');
    expect(shelf.previewsStore.get()).toEqual([oldPreview]);
    expect(shelf.quickStore.get()).toEqual(oldPreview);
    expect(mocks.clearPreviews).not.toHaveBeenCalled();
    mocks.getDoc.mockReturnValue(doc('B'));
    queue.retryJob(failed.id);
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(shelf.previewsStore.get()).toHaveLength(2));
    expect(mocks.render.mock.calls[1][0].doc.id).toBe('A');
    expect(shelf.quickStore.get()).toEqual(oldPreview);
  });

  it('a cancelled preview never replaces history or prunes files', async () => {
    const rendering = deferred<void>();
    rendering.cancel.mockImplementation(() => rendering.reject(new Error('worker abort wrapped as INTERNAL')));
    mocks.render.mockReturnValueOnce(rendering);
    mocks.readConfig.mockResolvedValue([oldPreview]);
    await shelf.loadPreviews();
    await queue.addJob('preview_cancelled', config(), 'C:/cache/preview', { quick: true });
    queue.cancelJob(queue.renderStore.get()[0].id);
    await done();
    expect(queue.renderStore.get()[0].status).toBe('cancelled');
    expect(shelf.previewsStore.get()).toEqual([oldPreview]);
    expect(mocks.clearPreviews).not.toHaveBeenCalled();
  });

  it('a render resolving after cancellation keeps its snapshot for Retry in another project', async () => {
    const rendering = deferred<void>();
    mocks.render.mockReturnValueOnce(rendering);
    await queue.addJob('cancel_race', config(), 'C:/out');
    const id = queue.renderStore.get()[0].id;
    queue.cancelJob(id);
    rendering.resolve(); await done();
    expect(queue.renderStore.get()[0].status).toBe('cancelled');
    expect(mocks.writeConfig).not.toHaveBeenCalled();
    mocks.getDoc.mockReturnValue(doc('B'));
    queue.retryJob(id);
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2));
    await done();
    expect(mocks.render.mock.calls[1][0].doc?.id).toBe('A');
  });

  it('metadata failure leaves the render successful and previous previews available', async () => {
    mocks.readConfig.mockResolvedValue([oldPreview]);
    mocks.writeConfig.mockRejectedValueOnce(new Error('metadata full'));
    await queue.addJob('preview_unsaved', config(), 'C:/cache/preview', { quick: true });
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(queue.renderStore.get()[0].status).toBe('done');
    expect(shelf.previewsStore.get()).toContainEqual(oldPreview);
    expect(shelf.previewsStore.get()).toHaveLength(2);
    expect(mocks.clearPreviews).not.toHaveBeenCalled();
  });

  it('cancelling a queued export skips it without affecting the active one', async () => {
    const active = deferred<void>();
    mocks.render.mockReturnValueOnce(active);
    await queue.addJob('first', config(), 'C:/out');
    await queue.addJob('second', config(), 'C:/out');
    const second = queue.renderStore.get()[1];
    queue.cancelJob(second.id);
    active.resolve(); await done();
    expect(mocks.render).toHaveBeenCalledTimes(1);
    expect(queue.renderStore.get().map(j => j.status)).toEqual(['done', 'cancelled']);
  });

  it('allocates unique IDs when quick jobs replace one another within the same clock tick', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    for (let n = 0; n < 3; n++) {
      await queue.addJob(`preview_${n}`, config(), 'C:/cache/preview', { quick: true });
      await vi.waitFor(() => expect(mocks.clearPreviews).toHaveBeenCalledTimes(n + 1));
    }
    expect(new Set(shelf.previewsStore.get().map(p => p.id)).size).toBe(3);
  });

  it.each(['cancelled', 'failed'] as const)('Retry reserves a fresh path after a %s job has already written a file', async status => {
    const first = deferred<void>();
    mocks.render.mockReturnValueOnce(first);
    await queue.addJob('written', config(), 'C:/out');
    const original = queue.renderStore.get()[0];
    if (status === 'cancelled') { queue.cancelJob(original.id); first.resolve(); }
    else first.reject(new Error('failed after writing'));
    await done();
    expect(queue.renderStore.get()[0].status).toBe(status);
    const free = original.outPath.replace('.mp4', '_v02.mp4');
    mocks.nextFree.mockResolvedValueOnce(free);
    mocks.getDoc.mockReturnValue(doc('B'));
    mocks.render.mockImplementationOnce(job => ({
      promise: job.outPath === original.outPath ? Promise.reject(new Error('EXPORT_EXISTS')) : Promise.resolve(), cancel: vi.fn(),
    }));
    await queue.retryJob(original.id);
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2));
    await done();
    expect(mocks.nextFree).toHaveBeenCalledTimes(2);
    expect(queue.renderStore.get()[0]).toMatchObject({ id: original.id, outPath: free, status: 'done' });
    expect(mocks.render.mock.calls[1][0].doc?.id).toBe('A');
  });

  it('serializes Retry path allocation with new jobs and ignores double Retry clicks', async () => {
    mocks.render.mockReturnValueOnce({ promise: Promise.reject(new Error('failed')), cancel: vi.fn() });
    await queue.addJob('same', config(), 'C:/out'); await done();
    const failed = queue.renderStore.get()[0], allocation = deferred<string>(), active = deferred<void>();
    const free = failed.outPath.replace('.mp4', '_v02.mp4');
    mocks.nextFree.mockReturnValueOnce(allocation.promise);
    mocks.render.mockReturnValueOnce(active);
    const retry = queue.retryJob(failed.id);
    const duplicate = queue.retryJob(failed.id);
    const added = queue.addJob('same_v02', config(), 'C:/out');
    await vi.waitFor(() => expect(mocks.nextFree).toHaveBeenCalledTimes(2));
    expect(mocks.render).toHaveBeenCalledTimes(1);
    allocation.resolve(free);
    await Promise.all([retry, duplicate, added]);
    expect(mocks.nextFree).toHaveBeenCalledTimes(3);
    expect(mocks.nextFree.mock.calls[2][1]).toContain(free);
    expect(queue.renderStore.get()).toHaveLength(2);
    expect(new Set(queue.renderStore.get().map(j => j.outPath)).size).toBe(2);
    active.resolve(); await done();
    expect(mocks.render).toHaveBeenCalledTimes(3);
  });

  it('does not restore a cancelled job cleared while Retry is reserving its new path', async () => {
    const first = deferred<void>();
    mocks.render.mockReturnValueOnce(first);
    await queue.addJob('removed', config(), 'C:/out');
    const id = queue.renderStore.get()[0].id;
    queue.cancelJob(id); first.resolve(); await done();
    const allocation = deferred<string>();
    mocks.nextFree.mockReturnValueOnce(allocation.promise);
    const retry = queue.retryJob(id);
    await vi.waitFor(() => expect(mocks.nextFree).toHaveBeenCalledTimes(2));
    queue.clearDone();
    allocation.resolve('C:/out/removed_v02.mp4'); await retry;
    expect(queue.renderStore.get()).toEqual([]);
    expect(mocks.render).toHaveBeenCalledTimes(1);
  });

  it('ignores Retry for rendering and done jobs', async () => {
    const first = deferred<void>();
    mocks.render.mockReturnValueOnce(first);
    await queue.addJob('active', config(), 'C:/out');
    const id = queue.renderStore.get()[0].id;
    await queue.retryJob(id);
    expect(mocks.nextFree).toHaveBeenCalledTimes(1);
    expect(queue.renderStore.get()[0].status).toBe('rendering');
    first.resolve(); await done();
    await queue.retryJob(id);
    expect(mocks.nextFree).toHaveBeenCalledTimes(1);
    expect(mocks.render).toHaveBeenCalledTimes(1);
    expect(queue.renderStore.get()[0].status).toBe('done');
  });

  it('a failed Retry reservation retains the failed job and can be retried again', async () => {
    mocks.render.mockReturnValueOnce({ promise: Promise.reject(new Error('encode failed')), cancel: vi.fn() });
    await queue.addJob('reservation', config(), 'C:/out'); await done();
    const original = queue.renderStore.get()[0];
    mocks.nextFree.mockRejectedValueOnce(new Error('folder unavailable'));
    await queue.retryJob(original.id);
    expect(mocks.toastError).toHaveBeenCalledWith(expect.objectContaining({ message: 'folder unavailable' }));
    expect(queue.renderStore.get()[0]).toBe(original);
    expect(mocks.render).toHaveBeenCalledTimes(1);
    await queue.retryJob(original.id);
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2));
    await done();
    expect(queue.renderStore.get()[0].status).toBe('done');
  });
});
