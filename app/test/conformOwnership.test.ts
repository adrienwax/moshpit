import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/qol/qol', () => ({ asError: (e: unknown) => ({ suggestedFix: String(e) }), toast: vi.fn(), toastError: vi.fn() }));
import type { ConformCheck, Task } from '../src/engine';
import { engine } from '../src/engine';
import { demoProject } from '../src/engine/mockProject';
import { conformStore, resetConformStatus, runConformCheck } from '../src/state/conforms';
import { projectStore } from '../src/state/project';
import { toastError } from '../src/qol/qol';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject, cancel: vi.fn() };
}
function project(sourceCount: number) {
  const doc = structuredClone(demoProject());
  const first = doc.resources.sources[0];
  doc.resources.sources = Array.from({ length: sourceCount }, (_, i) => ({ ...first, id: `source-${i}`, name: `Clip ${i}`, conformId: `conform-${i}` }));
  doc.resources.conforms = doc.resources.sources.map((s) => ({ id: s.conformId!, sourceId: s.id, status: 'proxy' as const }));
  return doc;
}
beforeEach(() => {
  projectStore.set({ doc: project(1), past: [], future: [] });
  conformStore.set({ status: {} });
});
afterEach(() => { resetConformStatus(); vi.restoreAllMocks(); });

describe('conform check ownership', () => {
  it('ignores a cancelled check after project replacement and preserves the new check', async () => {
    const a = deferred<ConformCheck[]>(), b = deferred<ConformCheck[]>();
    const checks: Array<{ task: typeof a; progress: (p: { done: number; total: number }) => void }> = [];
    vi.spyOn(engine, 'verifyConforms').mockImplementation((progress) => {
      const task = checks.length ? b : a;
      checks.push({ task, progress });
      return task as Task<ConformCheck[]>;
    });

    const oldCheck = runConformCheck();
    expect(conformStore.get().running?.total).toBe(1);
    projectStore.set({ doc: project(2), past: [], future: [] });
    resetConformStatus();
    const newCheck = runConformCheck();
    const newTask = conformStore.get().running?.task;
    expect(a.cancel).toHaveBeenCalledOnce();
    expect(conformStore.get().running?.total).toBe(2);

    checks[0].progress({ done: 1, total: 1 });
    a.reject(new DOMException('cancelled old project check', 'AbortError'));
    await oldCheck;
    expect(conformStore.get().running?.task).toBe(newTask);
    expect(conformStore.get().running?.total).toBe(2);
    expect(toastError).not.toHaveBeenCalled();

    checks[1].progress({ done: 1, total: 2 });
    expect(conformStore.get().running).toMatchObject({ done: 1, total: 2 });
    b.resolve([{ sourceId: 'source-0', status: 'match' } as ConformCheck]);
    await newCheck;
    expect(conformStore.get()).toMatchObject({ status: { 'source-0': 'match' }, checkedAt: expect.any(Number) });
    expect(conformStore.get().running).toBeUndefined();
  });

  it('does not let an older concurrent result replace the current project result', async () => {
    const a = deferred<ConformCheck[]>(), b = deferred<ConformCheck[]>();
    const tasks = [a, b];
    const progress: Array<(p: { done: number; total: number }) => void> = [];
    vi.spyOn(engine, 'verifyConforms').mockImplementation((onProgress) => {
      progress.push(onProgress);
      return tasks[progress.length - 1] as Task<ConformCheck[]>;
    });
    const oldCheck = runConformCheck(), newCheck = runConformCheck();
    a.resolve([{ sourceId: 'old', status: 'changed' } as ConformCheck]);
    await oldCheck;
    expect(conformStore.get().running?.task).toBe(b);
    expect(conformStore.get().status).toEqual({});
    progress[0]({ done: 1, total: 99 });
    expect(conformStore.get().running?.total).toBe(1);
    b.resolve([{ sourceId: 'source-0', status: 'match' } as ConformCheck]);
    await newCheck;
    expect(conformStore.get().status).toEqual({ 'source-0': 'match' });
  });
});
