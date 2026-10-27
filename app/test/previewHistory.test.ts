import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedPreview } from '../src/state/previews';

const bridge = vi.hoisted(() => ({ readConfig: vi.fn(), writeConfig: vi.fn(), clearPreviews: vi.fn() }));
vi.mock('../src/host', () => ({ host: { readConfig: bridge.readConfig, writeConfig: bridge.writeConfig, files: { clearPreviews: bridge.clearPreviews } } }));
vi.mock('../src/qol/qol', () => ({ toastError: vi.fn() }));
let shelf: typeof import('../src/state/previews');
const preview = (n: number, projectId = 'project-A'): SavedPreview => ({
  id: `capture-${n}`, path: `C:/cache/preview/preview_${n}.mp4`, label: `Preview ${n}`,
  projectId, createdAt: n, scope: 'Block 1',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  vi.resetModules();
  bridge.readConfig.mockReset().mockResolvedValue([]);
  bridge.writeConfig.mockReset().mockResolvedValue('previews.json');
  bridge.clearPreviews.mockReset().mockResolvedValue(0);
  shelf = await import('../src/state/previews');
});

describe('durable preview history', () => {
  it('restores eight newest distinct valid captures across projects', async () => {
    const records = Array.from({ length: 10 }, (_, n) => preview(n, n % 2 ? 'A' : 'B'));
    bridge.readConfig.mockResolvedValue([null, { ...preview(99), path: 'C:/source.mp4' }, { ...preview(98), createdAt: 'yesterday' }, ...records, preview(5)]);
    await shelf.loadPreviews();
    expect(shelf.previewsStore.get().map(p => p.id)).toEqual([9, 8, 7, 6, 5, 4, 3, 2].map(n => `capture-${n}`));
    expect(new Set(shelf.previewsStore.get().map(p => p.projectId))).toEqual(new Set(['A', 'B']));
    expect(bridge.writeConfig).not.toHaveBeenCalled();
    expect(bridge.clearPreviews).not.toHaveBeenCalled();
  });

  it('merges a capture completing during cold load without losing the existing history', async () => {
    const read = deferred<unknown>();
    bridge.readConfig.mockReturnValue(read.promise);
    const loading = shelf.loadPreviews();
    const remembering = shelf.rememberPreview(preview(2));
    expect(bridge.readConfig).toHaveBeenCalledTimes(1);
    read.resolve([preview(1)]);
    await Promise.all([loading, remembering]);
    expect(shelf.previewsStore.get()).toEqual([preview(2), preview(1)]);
    expect(bridge.writeConfig).toHaveBeenCalledWith('previews', [preview(2), preview(1)]);
    expect(shelf.previewSelectionStore.get()).toBe(preview(2).id);
  });

  it('serializes overlapping captures and prunes only after their metadata is saved', async () => {
    const write = deferred<string>();
    bridge.writeConfig.mockReturnValueOnce(write.promise);
    const first = shelf.rememberPreview(preview(1));
    const second = shelf.rememberPreview(preview(2));
    await vi.waitFor(() => expect(bridge.writeConfig).toHaveBeenCalledTimes(1));
    expect(bridge.clearPreviews).not.toHaveBeenCalled();
    write.resolve('previews.json');
    await Promise.all([first, second]);
    expect(bridge.writeConfig.mock.calls.map(c => c[1])).toEqual([[preview(1)], [preview(2), preview(1)]]);
    expect(shelf.previewsStore.get()).toEqual([preview(2), preview(1)]);
  });

  it('keeps a new capture available after a save failure and retries it on the next successful write', async () => {
    bridge.readConfig.mockResolvedValue([preview(1)]);
    bridge.writeConfig.mockRejectedValueOnce(new Error('disk full'));
    await expect(shelf.rememberPreview(preview(2))).rejects.toThrow('disk full');
    expect(shelf.previewsStore.get()).toEqual([preview(2), preview(1)]);
    expect(shelf.previewSaveErrorStore.get()).toMatch(/could not be saved/i);
    expect(bridge.clearPreviews).not.toHaveBeenCalled();
    await shelf.rememberPreview(preview(3));
    expect(bridge.writeConfig).toHaveBeenLastCalledWith('previews', [preview(3), preview(2), preview(1)]);
    expect(shelf.previewSaveErrorStore.get()).toBeNull();
  });

  it('preserves the expanded old file and queued outputs when enforcing the eight-capture limit', async () => {
    bridge.readConfig.mockResolvedValue(Array.from({ length: 8 }, (_, n) => preview(n)));
    shelf.quickStore.set(preview(0));
    const queued = 'C:/cache/preview/preview_pending.mp4';
    await shelf.rememberPreview(preview(8), [queued]);
    expect(shelf.previewsStore.get()).toHaveLength(8);
    expect(shelf.previewsStore.get().some(p => p.id === preview(0).id)).toBe(false);
    expect(bridge.clearPreviews).toHaveBeenCalledWith(expect.arrayContaining([preview(0).path, queued, ...Array.from({ length: 8 }, (_, n) => preview(n + 1).path)]));
    expect(shelf.quickStore.get()).toEqual(preview(0));
  });

  it('a failed remove keeps both the history and expanded preview; success changes metadata only', async () => {
    bridge.readConfig.mockResolvedValue([preview(1), preview(2)]);
    await shelf.loadPreviews();
    shelf.quickStore.set(preview(1));
    bridge.writeConfig.mockRejectedValueOnce(new Error('read only'));
    await expect(shelf.forgetPreview(preview(1).id)).rejects.toThrow('read only');
    expect(shelf.previewsStore.get()).toContainEqual(preview(1));
    expect(shelf.quickStore.get()).toEqual(preview(1));
    await shelf.forgetPreview(preview(1).id);
    expect(shelf.previewsStore.get()).toEqual([preview(2)]);
    expect(shelf.quickStore.get()).toBeNull();
    expect(bridge.clearPreviews).not.toHaveBeenCalled();
  });

  it('survives a cleanup failure with saved metadata intact and allows subsequent captures', async () => {
    bridge.clearPreviews.mockRejectedValueOnce(new Error('file busy'));
    await expect(shelf.rememberPreview(preview(1))).rejects.toThrow('file busy');
    expect(bridge.writeConfig).toHaveBeenCalledWith('previews', [preview(1)]);
    expect(shelf.previewsStore.get()).toEqual([preview(1)]);
    await shelf.rememberPreview(preview(2));
    expect(shelf.previewsStore.get()).toEqual([preview(2), preview(1)]);
  });

  it('restores saved metadata in a new module session without rendering again', async () => {
    await shelf.rememberPreview(preview(1));
    const saved = structuredClone(bridge.writeConfig.mock.calls[0][1]);
    vi.resetModules();
    shelf = await import('../src/state/previews');
    bridge.readConfig.mockResolvedValue(saved);
    await shelf.loadPreviews();
    expect(shelf.previewsStore.get()).toEqual([preview(1)]);
  });

  it('does not lose a completed capture when reading older metadata fails', async () => {
    bridge.readConfig.mockRejectedValueOnce(new Error('temporary read error'));
    await expect(shelf.rememberPreview(preview(2))).rejects.toThrow('temporary read error');
    expect(shelf.previewsStore.get()).toContainEqual(preview(2));
    expect(bridge.clearPreviews).not.toHaveBeenCalled();
    bridge.readConfig.mockResolvedValue([preview(1)]);
    await shelf.loadPreviews();
    expect(shelf.previewsStore.get()).toEqual([preview(2), preview(1)]);
  });
});
