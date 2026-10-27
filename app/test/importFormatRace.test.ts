import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/qol/qol', async original => ({
  ...await original<typeof import('../src/qol/qol')>(), toast: vi.fn(), toastError: vi.fn(),
}));
// Import commands are exercised directly; no preview pane or native decoder is mounted.
vi.mock('../src/state/preview', () => ({ pinPreview: vi.fn(), previewInfoOf: vi.fn(), rawFrame: vi.fn(), releasePreview: vi.fn(), stillsOf: vi.fn(), thumbOf: vi.fn() }));
import { engine, type LibraryClip } from '../src/engine';
import { demoProject } from '../src/engine/mockProject';
import { addClips } from '../src/ws/browse/BrowsePanes';
import { canAdoptImport, changeProjectFormat, emptyDoc, getDoc, projectStore, redo, undo } from '../src/state/project';
import { cancelJob, jobStore, resetProjectJobs } from '../src/state/jobs';
import { toast } from '../src/qol/qol';

type Imported = Awaited<ReturnType<typeof engine.importClip>['promise']>;
const clip: LibraryClip = { path: 'C:/fixture/first.mp4', name: 'first.mp4', probe: demoProject().resources.sources[0].probe, pass: true, rating: 0, tags: [] };
const key = `import:${clip.path}`;
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function pendingImport() {
  const settings = getDoc().settings;
  const source = { ...demoProject().resources.sources[0], path: clip.path, name: clip.name };
  const conform = { id: source.conformId, sourceId: source.id, fps: { ...settings.fps }, width: settings.working.w, height: settings.working.h, frames: 300, status: 'proxy' } as Imported['conform'];
  let resolve!: (value: Imported) => void, reject!: (error: unknown) => void;
  const promise = new Promise<Imported>((res, rej) => { resolve = res; reject = rej; });
  const cancel = vi.fn(() => reject(new DOMException('Cancelled', 'AbortError')));
  vi.spyOn(engine, 'importClip').mockReturnValue({ promise, cancel });
  return { resolve: (patch: Partial<Imported['conform']> = {}) => resolve({ source, conform: { ...conform, ...patch } }), reject, cancel, source };
}
beforeEach(() => {
  resetProjectJobs();
  const doc = emptyDoc(); doc.settings.fps = { num: 30, den: 1 };
  projectStore.set({ doc, past: [], future: [] });
  vi.clearAllMocks();
});
afterEach(() => { resetProjectJobs(); vi.restoreAllMocks(); });

describe('first-import format ownership', () => {
  it.each([
    { fps: { num: 60, den: 1 } },
    { fps: { num: 30000, den: 1001 } },
    { working: { w: 3840, h: 2160 } },
  ])('blocks a real pending Browse import format change: %j', async patch => {
    const task = pendingImport(); await addClips([clip]);
    expect(jobStore.get()[key].task).toBeDefined();
    expect(getDoc().resources.sources).toHaveLength(0);
    const before = projectStore.get();
    expect(await changeProjectFormat('Format', patch)).toBe(false);
    expect(projectStore.get()).toBe(before);
    task.resolve(); await settle();
    expect(getDoc().resources.sources).toHaveLength(1);
    expect(getDoc().resources.conforms[0].fps).toEqual(getDoc().settings.fps);
    expect(getDoc().resources.conforms[0].width).toBe(getDoc().settings.working.w);
  });
  it.each(['undo', 'redo'] as const)('rejects late completion after %s changes FPS, without history or engine mutation', async direction => {
    await changeProjectFormat('60 fps', { fps: { num: 60, den: 1 } });
    if (direction === 'redo') undo();
    const task = pendingImport(); await addClips([clip]);
    if (direction === 'undo') undo(); else redo();
    const before = projectStore.get(), sync = vi.spyOn(engine, 'updateProject');
    task.resolve(); await settle();
    expect(projectStore.get()).toBe(before); expect(sync).not.toHaveBeenCalled();
    expect(getDoc().resources.sources).toEqual([]); expect(getDoc().timeline.blocks).toEqual([]);
    expect(jobStore.get()[key]).toBeUndefined();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Import the clip again'), { kind: 'warn' });
  });
  it('rejects late completion after Undo changes working size', async () => {
    await changeProjectFormat('720p working', { working: { w: 1280, h: 720 } });
    const task = pendingImport(); await addClips([clip]); undo();
    const before = projectStore.get(); task.resolve(); await settle();
    expect(projectStore.get()).toBe(before); expect(getDoc().resources.sources).toEqual([]);
  });
  it.each([{ fps: { num: 25, den: 1 } }, { width: 640, height: 360 }])('refuses an incorrectly prepared worker result before adoption: %j', async patch => {
    const task = pendingImport(); await addClips([clip]);
    const before = projectStore.get(); task.resolve(patch); await settle();
    expect(projectStore.get()).toBe(before); expect(jobStore.get()[key]).toBeUndefined();
  });
  it('allows equivalent rates while pending and accepts an equivalent returned rational', async () => {
    const task = pendingImport(); await addClips([clip]); const before = projectStore.get();
    expect(await changeProjectFormat('Same rate', { fps: { num: 60, den: 2 } })).toBe(true);
    expect(projectStore.get()).toBe(before);
    task.resolve({ fps: { num: 60, den: 2 } }); await settle();
    expect(getDoc().resources.sources).toHaveLength(1);
    expect(getDoc().resources.conforms[0].fps).toEqual({ num: 60, den: 2 });
  });
  it.each(['cancel', 'failure'] as const)('releases the empty-project format guard after import %s', async end => {
    const task = pendingImport(); await addClips([clip]);
    if (end === 'cancel') cancelJob(key); else task.reject(new Error('Fixture failed'));
    await settle();
    expect(jobStore.get()[key]?.task).toBeUndefined();
    expect(await changeProjectFormat('60 fps', { fps: { num: 60, den: 1 } })).toBe(true);
    expect(getDoc().resources.sources).toEqual([]);
  });
  it('compares completion against the captured format as well as the current project', () => {
    const current = getDoc().settings;
    const changed = { fps: { num: 60, den: 1 }, working: { ...current.working } };
    const conform = { fps: current.fps, width: current.working.w, height: current.working.h } as Imported['conform'];
    expect(canAdoptImport(changed, conform)).toBe(false);
  });
});
