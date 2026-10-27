import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/host', () => ({ host: {
  readConfig: vi.fn(async () => null), writeConfig: vi.fn(async () => 'settings.json'),
  files: { pickFolder: vi.fn(async () => null) },
  project: { session: vi.fn(async () => ({ ok: true, value: 'session' })), saveDialog: vi.fn(async () => 'C:/review/My project.moshpit'), save: vi.fn(async () => ({ ok: true, value: 'saved' })) },
} }));
vi.mock('../src/qol/qol', async importOriginal => ({
  ...await importOriginal<typeof import('../src/qol/qol')>(),
  choose: vi.fn(async () => 'cancel'), toast: vi.fn(), toastError: vi.fn(),
}));
import { engine, type LibraryClip } from '../src/engine';
import { host } from '../src/host';
import { demoProject } from '../src/engine/mockProject';
import { openStarterMosh, starterClips } from '../src/lib/starterMosh';
import { TEST_CLIPS_DIR } from '../src/lib/testClips';
import { commit, emptyDoc, getDoc, projectStore } from '../src/state/project';
import { lifeStore, newProject } from '../src/state/lifecycle';
import { setUi } from '../src/state/ui';
import { choose, toast } from '../src/qol/qol';
import { timelineFrames } from '../src/lib/timeline';

type Imported = Awaited<ReturnType<typeof engine.importClip>['promise']>;
const clips: LibraryClip[] = [0, 1, 2].map(i => ({ path: `C:/user/clip${i}.mp4`, name: `clip${i}.mp4`, probe: { ...demoProject().resources.sources[0].probe, fps: { num: 60, den: 1 }, durationSec: 30 }, pass: true, rating: 0, tags: [] }));
function imported(path: string): Imported {
  const i = clips.findIndex(c => c.path === path), doc = demoProject(), format = getDoc().settings;
  const source = { ...doc.resources.sources[0], id: `starter-${i}` as never, path, name: clips[i].name, probe: clips[i].probe, conformId: `starter-conform-${i}` as never };
  const conform = { ...doc.resources.conforms[0], id: source.conformId, sourceId: source.id, fps: format.fps, width: format.working.w, height: format.working.h, frames: 10 * format.fps.num / format.fps.den, moshable: true };
  return { source, conform };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  lifeStore.set({ file: null, saved: null });
  setUi({ folder: 'C:/user', ws: 'home' });
  vi.mocked(choose).mockResolvedValue('cancel');
  vi.mocked(host.files!.pickFolder).mockResolvedValue(null);
  vi.mocked(host.project!.session).mockResolvedValue({ ok: true, value: 'session' });
  vi.spyOn(engine, 'libraryClips').mockImplementation(async folder => folder === 'C:/user' ? clips : []);
  vi.spyOn(engine, 'listDir').mockRejectedValue(new Error('Missing optional test folder'));
  vi.spyOn(engine, 'importClip').mockImplementation(path => ({ promise: Promise.resolve(imported(path)), cancel() {} }));
});

describe('portable Starter Mosh', () => {
  it('rejects failed, duplicate, invalid-rate and sub-frame candidates', () => {
    const bad = [
      { ...clips[0], path: 'failed', pass: { code: 'BAD' } },
      { ...clips[0], path: 'fps', probe: { ...clips[0].probe, fps: { num: NaN, den: 1 } } },
      { ...clips[0], path: 'short', probe: { ...clips[0].probe, durationSec: 0.001 } },
    ];
    expect(starterClips([...bad, clips[0], { ...clips[0], path: 'c:\\USER\\clip0.mp4' }, clips[1], clips[2]])).toEqual(clips);
  });
  it('uses three distinct ten-second sections for a thirty-second starter and keeps conform format', async () => {
    const before = getDoc();
    expect(await openStarterMosh()).toBe(true);
    expect(engine.listDir).not.toHaveBeenCalled();
    expect(host.files!.pickFolder).not.toHaveBeenCalled();
    expect(engine.importClip).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(engine.importClip).mock.calls) expect(call[2]).toMatchObject({ proxyFirst: false, range: { startSec: 0, durSec: 10 } });
    expect(new Set(vi.mocked(engine.importClip).mock.calls.map(c => c[0])).size).toBe(3);
    expect(getDoc().id).not.toBe(before.id);
    expect(getDoc().settings.fps).toEqual(before.settings.fps);
    expect(getDoc().resources.conforms.every(c => c.fps.num === before.settings.fps.num)).toBe(true);
    expect(getDoc().timeline.blocks.map(b => b.kind)).toEqual(['picture', 'motion', 'picture']);
    expect(timelineFrames(getDoc().timeline.blocks) * before.settings.fps.den / before.settings.fps.num).toBe(30);
    expect(projectStore.get().past).toHaveLength(1);
  });
  it('missing test folder leads to a picker; cancelling preserves even an empty edited project', async () => {
    vi.mocked(engine.libraryClips).mockResolvedValue([]);
    commit('Name', d => void (d.name = 'Keep this empty project'));
    const before = getDoc();
    expect(await openStarterMosh()).toBe(false);
    expect(engine.listDir).toHaveBeenCalledWith(TEST_CLIPS_DIR);
    expect(host.files!.pickFolder).toHaveBeenCalledTimes(1);
    expect(engine.importClip).not.toHaveBeenCalled();
    expect(getDoc()).toBe(before);
  });
  it('uses a chosen folder outside library roots and offers retry for insufficient clips', async () => {
    vi.mocked(host.files!.pickFolder).mockResolvedValue('E:/my-clips');
    vi.mocked(engine.libraryClips).mockResolvedValue([clips[0]]);
    const before = getDoc();
    expect(await openStarterMosh({ chooseFolder: true })).toBe(false);
    expect(engine.libraryClips).toHaveBeenCalledWith('E:/my-clips');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('three different playable'), expect.objectContaining({ action: expect.objectContaining({ label: 'Choose folder' }) }));
    expect(getDoc()).toBe(before);
  });
  it('keeps genuinely short clips short, reports actual duration, and never pads or repeats', async () => {
    vi.mocked(engine.libraryClips).mockResolvedValue(clips.map(c => ({ ...c, probe: { ...c.probe, durationSec: 7 } })));
    vi.mocked(engine.importClip).mockImplementation(path => {
      const result = imported(path);
      result.conform.frames = 7 * getDoc().settings.fps.num / getDoc().settings.fps.den;
      return { promise: Promise.resolve(result), cancel() {} };
    });
    expect(await openStarterMosh()).toBe(true);
    for (const call of vi.mocked(engine.importClip).mock.calls) expect(call[2]?.range?.durSec).toBe(7);
    expect(timelineFrames(getDoc().timeline.blocks) / getDoc().settings.fps.num * getDoc().settings.fps.den).toBe(21);
    expect(getDoc().timeline.blocks.every(b => b.repeat === 1)).toBe(true);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('21s from three distinct clips (short sources kept at their real length)'), expect.anything());
  });
  it('refuses two clips instead of silently reusing a source for the third section', async () => {
    vi.mocked(host.files!.pickFolder).mockResolvedValue('C:/user');
    vi.mocked(engine.libraryClips).mockResolvedValue(clips.slice(0, 2));
    const before = getDoc();
    expect(await openStarterMosh({ chooseFolder: true })).toBe(false);
    expect(engine.importClip).not.toHaveBeenCalled();
    expect(getDoc()).toBe(before);
  });
  it('preserves the old document when the third import fails', async () => {
    const before = getDoc();
    vi.mocked(engine.importClip).mockImplementation(path => ({ promise: path === clips[2].path ? Promise.reject(new Error('Third conform failed')) : Promise.resolve(imported(path)), cancel() {} }));
    expect(await openStarterMosh()).toBe(false);
    expect(engine.importClip).toHaveBeenCalledTimes(3);
    expect(getDoc()).toBe(before);
    expect(host.project!.session).not.toHaveBeenCalled();
  });
  it('second import failure preserves the complete old document and working format', async () => {
    const before = getDoc();
    vi.mocked(engine.importClip).mockImplementationOnce(path => ({ promise: Promise.resolve(imported(path)), cancel() {} }))
      .mockImplementationOnce(() => ({ promise: Promise.reject(new Error('Conform failed')), cancel() {} }));
    expect(await openStarterMosh()).toBe(false);
    expect(getDoc()).toBe(before);
    expect(host.project!.session).not.toHaveBeenCalled();
  });
  it.each(['fps', 'size', 'moshable'] as const)('refuses a conform with incompatible %s without replacing the project', async issue => {
    const before = getDoc(), result = imported(clips[0].path);
    if (issue === 'fps') result.conform.fps = { num: before.settings.fps.num + 1, den: before.settings.fps.den };
    if (issue === 'size') result.conform.width = 17;
    if (issue === 'moshable') result.conform.moshable = false;
    vi.mocked(engine.importClip).mockReturnValueOnce({ promise: Promise.resolve(result), cancel() {} });
    expect(await openStarterMosh()).toBe(false);
    expect(getDoc()).toBe(before);
    expect(host.project!.session).not.toHaveBeenCalled();
  });
  it('unsaved Cancel after imports never turns an empty edited project into a starter', async () => {
    commit('Name', d => void (d.name = 'Keep me'));
    const before = getDoc();
    expect(await openStarterMosh()).toBe(false);
    expect(choose).toHaveBeenCalledTimes(1);
    expect(getDoc()).toBe(before);
    expect(host.project!.session).not.toHaveBeenCalled();
  });
  it('a project changed during import receives no imported sources and no second import starts', async () => {
    let finish!: (r: Imported) => void;
    vi.mocked(engine.importClip).mockImplementationOnce(() => ({ promise: new Promise(resolve => { finish = resolve; }), cancel() {} }));
    const pending = openStarterMosh();
    await vi.waitFor(() => expect(engine.importClip).toHaveBeenCalledTimes(1));
    expect(await openStarterMosh()).toBe(false); // double activation is locked
    const result = imported(clips[0].path);
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    const replacement = getDoc();
    finish(result);
    expect(await pending).toBe(false);
    expect(getDoc()).toBe(replacement);
    expect(engine.importClip).toHaveBeenCalledTimes(1);
  });
  it('newProject reports cancellation and a replacement during session setup explicitly', async () => {
    commit('Name', d => void (d.name = 'Keep me'));
    const before = getDoc();
    expect(await newProject()).toBe(false);
    expect(getDoc()).toBe(before);
    vi.mocked(choose).mockResolvedValue('discard');
    vi.mocked(host.project!.session).mockImplementationOnce(async () => {
      projectStore.set({ doc: emptyDoc(), past: [], future: [] });
      return { ok: true, value: 'session' };
    });
    expect(await newProject()).toBe(false);
  });
  it('newProject refuses a stale confirmation after a same-project edit', async () => {
    commit('Name', d => void (d.name = 'Before confirmation'));
    const id = getDoc().id;
    vi.mocked(choose).mockImplementationOnce(async () => {
      commit('Live edit', d => void (d.name = 'New edit while confirming'));
      return 'discard';
    });
    expect(await newProject()).toBe(false);
    expect(getDoc().id).toBe(id);
    expect(getDoc().name).toBe('New edit while confirming');
    expect(host.project!.session).not.toHaveBeenCalled();
  });
  it('continues New after Save As legitimately names the previous Untitled document', async () => {
    commit('Tempo', d => void (d.settings.bpm = 110));
    const oldId = getDoc().id;
    vi.mocked(choose).mockResolvedValueOnce('save');
    expect(await newProject()).toBe(true);
    expect(host.project!.save).toHaveBeenCalled();
    expect(getDoc().id).not.toBe(oldId);
    expect(getDoc().name).toBe('Untitled');
  });
});
