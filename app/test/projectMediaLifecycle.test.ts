import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/qol/qol', () => ({ confirmAction: vi.fn(), toast: vi.fn() }));
import type { ConformedSource, FreezeRecord } from '@moshpit/engine';
import { engine } from '../src/engine';
import { demoProject } from '../src/engine/mockProject';
import { confirmAction, toast } from '../src/qol/qol';
import {
  addBlock, addSource, adoptConform, changeProjectFormat, commit, emptyDoc, getDoc,
  mastersPending, projectStore, redo, removeSource, setExportConfig, toggleFreeze, undo,
} from '../src/state/project';

function media() {
  const source = structuredClone(demoProject().resources.sources[0]);
  const proxy = { id: source.conformId!, sourceId: source.id, status: 'proxy', fps: { num: 30, den: 1 }, frames: 300, width: 1920, height: 1080 } as ConformedSource;
  return { source, proxy, ready: { ...proxy, status: 'ready' as const, path: 'fixture-ready.mp4' } };
}
beforeEach(() => {
  const doc = emptyDoc(); doc.settings.fps = { num: 30, den: 1 };
  projectStore.set({ doc, past: [], future: [] });
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe('master readiness across history', () => {
  it('updates an undone import in redo history and dispatches Freeze after redo', async () => {
    const { source, proxy, ready } = media();
    addSource(source, proxy); undo();
    const before = projectStore.get(), update = vi.spyOn(engine, 'updateProject');
    adoptConform(ready);
    expect(getDoc()).toBe(before.doc); expect(projectStore.get().past).toBe(before.past);
    expect(projectStore.get().future[0].before.resources.conforms[0]).toBe(ready);
    expect(projectStore.get().future[0].id).toBe(before.future[0].id);
    expect(update).not.toHaveBeenCalled();
    redo(); expect(mastersPending(getDoc())).toEqual([]);
    const blockId = addBlock(source.id, 0, 300), target = { kind: 'block' as const, blockId };
    const record = { id: 'ready-freeze', target, range: [0, 300], key: 'test', codec: 'raw-rgba8', fingerprint: 'fixture', createdAt: '2026-10-10' } as FreezeRecord;
    const freeze = vi.spyOn(engine, 'freeze').mockReturnValue({ promise: Promise.resolve(record), cancel: vi.fn() });
    await expect(toggleFreeze(target, [0, 300])).resolves.toBe(true);
    expect(freeze).toHaveBeenCalledTimes(1); expect(getDoc().freezes).toEqual([record]);
  });
  it('updates past-only records after removing unused media, including multiple history steps', () => {
    const { source, proxy, ready } = media();
    addSource(source, proxy); commit('Name', d => { d.name = 'Remember me'; });
    removeSource(source.id); commit('After removal', d => { d.name = 'After'; });
    const before = projectStore.get(), update = vi.spyOn(engine, 'updateProject');
    adoptConform(ready);
    expect(getDoc()).toBe(before.doc); expect(projectStore.get().future).toBe(before.future);
    expect(projectStore.get().past[0]).toBe(before.past[0]); // pre-import snapshot stays untouched
    expect(projectStore.get().past[3]).toBe(before.past[3]); // empty post-removal snapshot too
    expect(projectStore.get().past.slice(1, 3).every(e => e.before.resources.conforms[0] === ready)).toBe(true);
    expect(update).not.toHaveBeenCalled();
    undo(); undo(); expect(getDoc().resources.conforms[0]).toBe(ready);
    expect(mastersPending(getDoc())).toEqual([]);
  });
  it('updates the current document once, while unrelated and already-adopted events are no-ops', () => {
    const { source, proxy, ready } = media(); addSource(source, proxy);
    const update = vi.spyOn(engine, 'updateProject'); adoptConform(ready);
    expect(update).toHaveBeenCalledTimes(1); expect(getDoc().resources.conforms[0]).toBe(ready);
    const before = projectStore.get(); adoptConform(ready);
    adoptConform({ ...ready, id: 'unrelated' as never });
    expect(projectStore.get()).toBe(before); expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('safe project format changes', () => {
  it.each([{ num: 60, den: 1 }, { num: 30000, den: 1001 }])('refuses differing FPS with imported media and no timeline blocks: %j', async fps => {
    const { source, ready } = media(); addSource(source, ready);
    commit('Keep a redo step', d => { d.name = 'Changed'; }); undo();
    const before = projectStore.get(), update = vi.spyOn(engine, 'updateProject');
    expect(before.doc.timeline.blocks).toEqual([]);
    expect(await changeProjectFormat('Frame rate', { fps })).toBe(false);
    expect(projectStore.get()).toBe(before); expect(update).not.toHaveBeenCalled();
    expect(confirmAction).not.toHaveBeenCalled(); expect(toast).toHaveBeenCalledWith(expect.stringContaining('before importing'), { kind: 'warn' });
  });
  it.each(['source', 'conform', 'timeline'] as const)('protects %s-backed imported media', async kind => {
    const { source, ready } = media();
    if (kind === 'conform') getDoc().resources.conforms.push(ready);
    else { addSource(source, kind === 'source' ? undefined : ready); if (kind === 'timeline') addBlock(source.id, 0, 300); }
    const before = projectStore.get();
    expect(await changeProjectFormat('Frame rate', { fps: { num: 60, den: 1 } })).toBe(false);
    expect(projectStore.get()).toBe(before);
  });
  it('blocks working-size changes but leaves export resolution independently adjustable', async () => {
    const { source, ready } = media(); addSource(source, ready);
    const before = projectStore.get();
    expect(await changeProjectFormat('Working size', { working: { w: 1080, h: 1920 } })).toBe(false);
    expect(projectStore.get()).toBe(before);
    setExportConfig({ width: 3840, height: 2160 }, 'Export size');
    expect(getDoc().exportConfig).toMatchObject({ width: 3840, height: 2160 });
    expect(getDoc().settings.working).toBe(before.doc.settings.working);
  });
  it('allows empty-project format changes with normal undo/redo', async () => {
    const before = getDoc();
    expect(await changeProjectFormat('New format', { fps: { num: 60000, den: 1001 }, working: { w: 1280, h: 720 } })).toBe(true);
    expect(getDoc().settings.fps).toEqual({ num: 60000, den: 1001 });
    expect(getDoc().settings.working).toEqual({ w: 1280, h: 720 });
    expect(projectStore.get().past).toHaveLength(1);
    expect(getDoc().exportConfig).toMatchObject({ width: 1280, height: 720 });
    undo(); expect(getDoc().settings).toEqual(before.settings);
    expect(getDoc().exportConfig).toEqual(before.exportConfig);
    redo(); expect(getDoc().settings.fps).toEqual({ num: 60000, den: 1001 });
  });
  it('treats equivalent rational rates and unchanged sizes as no-ops without clearing redo', async () => {
    const { source, ready } = media(); addSource(source, ready);
    commit('Future', d => { d.name = 'Future'; }); undo();
    const before = projectStore.get(), update = vi.spyOn(engine, 'updateProject');
    expect(await changeProjectFormat('Same rate', { fps: { num: 60, den: 2 }, working: { ...getDoc().settings.working } })).toBe(true);
    expect(projectStore.get()).toBe(before); expect(update).not.toHaveBeenCalled(); expect(toast).not.toHaveBeenCalled();
  });
});
