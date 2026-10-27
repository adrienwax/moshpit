import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/host', () => ({ host: {
  readConfig: vi.fn(async () => null), writeConfig: vi.fn(async () => 'settings.json'),
  project: {
    session: vi.fn(async () => ({ ok: true, value: 'session' })),
    load: vi.fn(),
  },
} }));
vi.mock('../src/qol/qol', () => ({ choose: vi.fn(async () => 'discard'), confirmAction: vi.fn(), toast: vi.fn(), toastError: vi.fn() }));
vi.mock('../src/state/conforms', () => ({ checkConforms: vi.fn(), resetConformStatus: vi.fn() }));
import { host } from '../src/host';
import { addSource, commit, emptyDoc, getDoc, projectStore } from '../src/state/project';
import { lifeStore, newProject, openProject } from '../src/state/lifecycle';
import { cancelJob, jobStore, runJob } from '../src/state/jobs';
import { demoProject } from '../src/engine/mockProject';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject, cancel: vi.fn() };
}
const source = demoProject().resources.sources[0];
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  vi.clearAllMocks();
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  lifeStore.set({ file: 'C:/review/A.moshpit.json', saved: null });
  jobStore.set({});
});

describe('background jobs belong to the project session that started them', () => {
  it('does not import into a new project when an old import completes', async () => {
    const task = deferred<typeof source>();
    runJob('import:clip', 'import', 'Import clip', () => task, addSource);
    expect(await newProject()).toBe(true);
    task.resolve(source); await settle();
    expect(getDoc().resources.sources).toEqual([]);
    expect(projectStore.get().past).toEqual([]);
    expect(task.cancel).not.toHaveBeenCalled(); // completed media/cache is retained
  });

  it('does not reapply an old completion after reopening the same saved project', async () => {
    const saved = getDoc(), task = deferred<typeof source>();
    runJob('import:clip', 'import', 'Import clip', () => task, addSource);
    vi.mocked(host.project!.load).mockResolvedValueOnce({ ok: true, value: { doc: saved, warnings: [], migrated: {} } });
    await openProject('C:/review/A.moshpit.json');
    task.resolve(source); await settle();
    expect(getDoc().id).toBe(saved.id);
    expect(getDoc().resources.sources).toEqual([]);
  });

  it('does not resume old work after switching away and back', async () => {
    const saved = getDoc(), task = deferred<typeof source>();
    const done = vi.fn();
    runJob('detect:clip', 'detect', 'Detect cuts', () => task, done);
    await newProject();
    vi.mocked(host.project!.load).mockResolvedValueOnce({ ok: true, value: { doc: saved, warnings: [], migrated: {} } });
    await openProject('C:/review/A.moshpit.json');
    task.resolve(source); await settle();
    expect(done).not.toHaveBeenCalled();
  });

  it('keeps work valid across ordinary edits in its project', async () => {
    const task = deferred<typeof source>();
    runJob('import:clip', 'import', 'Import clip', () => task, addSource);
    commit('Edit BPM', d => { d.settings.bpm = 137; });
    task.resolve(source); await settle();
    expect(getDoc().resources.sources.map(s => s.id)).toEqual([source.id]);
    expect(getDoc().settings.bpm).toBe(137);
  });

  it('allows a new same-file job and ignores old progress and settlement', async () => {
    const oldTask = deferred<string>(), newTask = deferred<string>();
    const oldDone = vi.fn(), newDone = vi.fn();
    let progress!: (p: { fraction: number }) => void;
    runJob('import:clip', 'import', 'Old import', p => { progress = p; return oldTask; }, oldDone);
    await newProject();
    runJob('import:clip', 'import', 'New import', () => newTask, newDone);
    progress({ fraction: 0.9 });
    expect(jobStore.get()['import:clip'].fraction).toBe(0);
    oldTask.resolve('old'); await settle();
    expect(jobStore.get()['import:clip'].task).toBe(newTask);
    expect(oldDone).not.toHaveBeenCalled();
    newTask.resolve('new'); await settle();
    expect(newDone).toHaveBeenCalledWith('new');
    expect(jobStore.get()['import:clip']).toBeUndefined();
  });

  it('honors Cancel even if the engine completes before noticing the abort', async () => {
    const task = deferred<string>(), done = vi.fn();
    runJob('import:clip', 'import', 'Import clip', () => task, done);
    cancelJob('import:clip'); task.resolve('finished'); await settle();
    expect(done).not.toHaveBeenCalled();
    expect(jobStore.get()['import:clip']).toBeUndefined();
  });
});
