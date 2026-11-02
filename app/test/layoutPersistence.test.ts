import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/host', () => ({ host: { writeConfig: vi.fn(async () => 'layouts.json') } }));
vi.mock('../src/qol/qol', () => ({ toastError: vi.fn() }));
import { host } from '../src/host';
import { toastError } from '../src/qol/qol';
import { flushLayouts, layoutStore, saveLayout } from '../src/layout/model';

beforeEach(() => { vi.useFakeTimers(); layoutStore.set({ current: {}, saved: [] }); vi.mocked(host.writeConfig).mockReset().mockResolvedValue('layouts.json'); vi.mocked(toastError).mockClear(); });
afterEach(async () => { await flushLayouts(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('layout persistence', () => {
  it('does not rewrite untouched layouts on close', async () => {
    await flushLayouts(); expect(host.writeConfig).not.toHaveBeenCalled();
  });
  it('serializes slow writes and retains edits made while the first snapshot is saving', async () => {
    let release!: () => void;
    vi.mocked(host.writeConfig).mockImplementationOnce(() => new Promise<string>(resolve => { release = () => resolve('layouts.json'); }));
    saveLayout('First', 'mosh'); const first = flushLayouts();
    await Promise.resolve(); await Promise.resolve();
    saveLayout('Second', 'browse'); const second = flushLayouts();
    await Promise.resolve(); await Promise.resolve();
    expect(host.writeConfig).toHaveBeenCalledTimes(1);
    const firstSnapshot = vi.mocked(host.writeConfig).mock.calls[0][1] as any;
    expect(firstSnapshot.saved.map((x: any) => x.name)).toEqual(['First']);
    release(); await Promise.all([first, second]);
    expect(host.writeConfig).toHaveBeenCalledTimes(2);
    const latest = vi.mocked(host.writeConfig).mock.calls.at(-1)![1] as any;
    expect(latest.saved.map((x: any) => x.name)).toEqual(['First', 'Second']);
  });
  it('retains a failed save as pending and retries without losing the layout', async () => {
    vi.mocked(host.writeConfig).mockRejectedValueOnce(new Error('Disk full'));
    saveLayout('Keep me', 'mosh');
    await expect(flushLayouts()).rejects.toThrow('Disk full');
    expect(layoutStore.get().saved[0].name).toBe('Keep me');
    await flushLayouts();
    expect(host.writeConfig).toHaveBeenCalledTimes(2);
  });
  it('reports a failed debounced write and allows the close flush to retry', async () => {
    vi.mocked(host.writeConfig).mockRejectedValueOnce(new Error('Read only'));
    saveLayout('Retry me', 'mosh');
    await vi.advanceTimersByTimeAsync(400);
    expect(toastError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Read only' }));
    await flushLayouts(); expect(host.writeConfig).toHaveBeenCalledTimes(2);
  });
});
