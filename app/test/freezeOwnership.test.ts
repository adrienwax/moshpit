import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/host', () => ({ host: {
  readConfig: vi.fn(async () => null), writeConfig: vi.fn(async () => 'settings.json'),
  project: { session: vi.fn(async () => ({ ok: true, value: 'session' })), load: vi.fn() },
} }));
vi.mock('../src/qol/qol', () => ({ choose: vi.fn(async () => 'discard'), confirmAction: vi.fn(), toast: vi.fn(), toastError: vi.fn() }));
vi.mock('../src/state/conforms', () => ({ checkConforms: vi.fn(), resetConformStatus: vi.fn() }));
import type { FreezeRecord, FreezeTarget } from '@moshpit/engine';
import { engine } from '../src/engine';
import { demoProject } from '../src/engine/mockProject';
import { getDoc, projectStore, setBlock, toggleFreeze } from '../src/state/project';
import { lifeStore, newProject, openProject } from '../src/state/lifecycle';
import { host } from '../src/host';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve, cancel: vi.fn() };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const target = (): FreezeTarget => ({ kind: 'block', blockId: getDoc().timeline.blocks[0].id });
const record = (t: FreezeTarget, id = 'freeze-a'): FreezeRecord => ({ id, target: t, range: [0, 20], key: 'cache-key', codec: 'raw-rgba8', fingerprint: 'test', createdAt: '2026-10-10' } as FreezeRecord);
beforeEach(() => {
  projectStore.set({ doc: demoProject(), past: [], future: [] });
  lifeStore.set({ file: 'C:/review/A.moshpit.json', saved: null });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('freeze ownership', () => {
  it('does not append an old freeze record to a new project', async () => {
    const task = deferred<FreezeRecord>(), t = target();
    vi.spyOn(engine, 'freeze').mockReturnValue(task);
    const freezing = toggleFreeze(t, [0, 20]);
    await settle();
    await newProject();
    task.resolve(record(t)); await expect(freezing).rejects.toMatchObject({ name: 'AbortError' });
    expect(getDoc().freezes).toEqual([]);
    expect(projectStore.get().past).toEqual([]);
  });

  it('does not dispatch a waiting freeze into a replacement project', async () => {
    const doc = structuredClone(getDoc()), t = target();
    const source = doc.resources.sources.find(s => s.id === doc.timeline.blocks[0].sourceId)!;
    doc.resources.conforms.push({ id: source.conformId!, sourceId: source.id, status: 'proxy' } as never);
    projectStore.set({ doc, past: [], future: [] });
    const freeze = vi.spyOn(engine, 'freeze').mockReturnValue({ promise: Promise.resolve(record(t)), cancel: vi.fn() });
    const freezing = toggleFreeze(t, [0, 20]);
    await settle(); expect(freeze).not.toHaveBeenCalled();
    await newProject(); await expect(freezing).rejects.toMatchObject({ name: 'AbortError' });
    expect(freeze).not.toHaveBeenCalled();
  });

  it('rejects a pending Freeze when its master fails and releases the pending slot', async () => {
    const doc = structuredClone(getDoc()), t = target();
    const source = doc.resources.sources.find(s => s.id === doc.timeline.blocks[0].sourceId)!;
    doc.resources.conforms.push({ id: source.conformId!, sourceId: source.id, status: 'proxy' } as never);
    projectStore.set({ doc, past: [], future: [] });
    const listeners = new Set<(u: { sourceId: string; state: string; error?: unknown }) => void>();
    const failed = { sourceId: source.id, state: 'FAILED', error: { code: 'CONFORM_FAILED' } };
    const conformStates = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([failed]);
    const mutableEngine = engine as typeof engine & {
      onConformUpdate?: (fn: (u: typeof failed) => void) => () => void;
      conformStates?: typeof conformStates;
    };
    mutableEngine.onConformUpdate = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
    mutableEngine.conformStates = conformStates;
    const freeze = vi.spyOn(engine, 'freeze').mockReturnValue({ promise: Promise.resolve(record(t)), cancel: vi.fn() });

    const freezing = toggleFreeze(t, [0, 20]);
    await settle();
    listeners.forEach((fn) => fn(failed));
    await expect(freezing).rejects.toMatchObject({ code: 'CONFORM_FAILED' });
    expect(freeze).not.toHaveBeenCalled();

    await expect(toggleFreeze(t, [0, 20])).rejects.toMatchObject({ code: 'CONFORM_FAILED' });
    expect(conformStates).toHaveBeenCalledTimes(2);
    expect(freeze).not.toHaveBeenCalled();
    delete mutableEngine.onConformUpdate;
    delete mutableEngine.conformStates;
  });

  it('avoids duplicate freeze work from two presses before completion', async () => {
    const task = deferred<FreezeRecord>(), t = target();
    const freeze = vi.spyOn(engine, 'freeze').mockReturnValue(task);
    const a = toggleFreeze(t, [0, 20]), b = toggleFreeze(t, [0, 20]);
    await settle(); task.resolve(record(t)); await Promise.all([a, b]);
    expect(freeze).toHaveBeenCalledTimes(1);
    expect(getDoc().freezes).toHaveLength(1);
  });

  it('ignores completion after reopening the same saved project', async () => {
    const saved = getDoc(), t = target(), task = deferred<FreezeRecord>();
    vi.spyOn(engine, 'freeze').mockReturnValue(task);
    const freezing = toggleFreeze(t, [0, 20]); await settle();
    vi.mocked(host.project!.load).mockResolvedValueOnce({ ok: true, value: { doc: saved, warnings: [], migrated: {} } });
    await openProject('C:/review/A.moshpit.json');
    task.resolve(record(t)); await expect(freezing).rejects.toMatchObject({ name: 'AbortError' });
    expect(getDoc().freezes).toEqual([]);
  });

  it('ignores a freeze after its timeline changes during rendering', async () => {
    const t = target(), task = deferred<FreezeRecord>();
    vi.spyOn(engine, 'freeze').mockReturnValue(task);
    const freezing = toggleFreeze(t, [0, 20]); await settle();
    setBlock(t.blockId, { repeat: 2 }, 'Repeat twice');
    task.resolve(record(t)); await expect(freezing).rejects.toMatchObject({ name: 'AbortError' });
    expect(getDoc().freezes).toEqual([]);
    expect(projectStore.get().past.map(e => e.label)).toEqual(['Repeat twice']);
  });
});
