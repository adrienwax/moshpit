import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/host', () => ({ host: {
  readConfig: vi.fn(async () => null), writeConfig: vi.fn(async () => 'settings.json'),
  project: {
    session: vi.fn(async () => ({ ok: true, value: 'session' })),
    saveDialog: vi.fn(async () => 'C:/review/A.moshpit.json'), save: vi.fn(async () => ({ ok: true, value: 'saved' })),
    openDialog: vi.fn(async () => 'C:/review/B.moshpit.json'), load: vi.fn(),
    journal: vi.fn(), onCloseRequested: vi.fn(), readyForClose: vi.fn(), discardRecovery: vi.fn(async () => true), closeNow: vi.fn(async () => {}), pendingRecovery: vi.fn(async () => ({ ok: true, value: [] })),
  },
} }));
vi.mock('../src/qol/qol', async original => ({ ...await original<typeof import('../src/qol/qol')>(), choose: vi.fn(async () => 'cancel'), toast: vi.fn(), toastError: vi.fn() }));
vi.mock('../src/state/conforms', () => ({ checkConforms: vi.fn(), resetConformStatus: vi.fn() }));
import { host } from '../src/host';
import { choose, toast, toastError } from '../src/qol/qol';
import { parseProject, serializeProject } from '../../engine/src/project/io';
import { MoshpitError } from '../../engine/src/errors';
import { commit, emptyDoc, getDoc, projectStore } from '../src/state/project';
import { bootLifecycle, isDirty, lifeStore, newProject, openProject, save } from '../src/state/lifecycle';

function deferred<T>() { let resolve!: (x: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const loaded = () => ({ ok: true as const, value: { doc: { ...emptyDoc(), name: 'Loaded B' }, warnings: [], migrated: {} } });
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  lifeStore.set({ file: 'C:/review/A.moshpit.json', saved: null });
  vi.mocked(choose).mockResolvedValue('cancel');
  vi.mocked(host.writeConfig).mockResolvedValue('settings.json');
  vi.mocked(host.project!.save).mockResolvedValue({ ok: true, value: 'saved' });
  vi.mocked(host.project!.load).mockResolvedValue(loaded());
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('lifecycle concurrency', () => {
  it.each(['mosh', 'MOSH', 'moshpit.json'])('names an Untitled .%s save and completes New without a false stale-session rejection', async ext => {
    lifeStore.set({ file: null, saved: null });
    commit('Edit', d => { d.settings.bpm = 137; });
    const previous = getDoc();
    vi.mocked(host.project!.saveDialog).mockResolvedValueOnce(`C:/review/Town.${ext}`);
    vi.mocked(choose).mockResolvedValueOnce('save');
    expect(await newProject()).toBe(true);
    expect(host.project!.save).toHaveBeenCalledWith(`C:/review/Town.${ext}`, expect.objectContaining({ name: 'Town' }));
    expect(getDoc().id).not.toBe(previous.id);
    expect(lifeStore.get().file).toBeNull();
  });

  it('keeps a legacy ordinary Save path and uses a .mosh Save As without changing the old file', async () => {
    expect(await save()).toBe(true);
    expect(host.project!.save).toHaveBeenLastCalledWith('C:/review/A.moshpit.json', getDoc());
    vi.mocked(host.project!.saveDialog).mockResolvedValueOnce('C:/review/A.mosh');
    expect(await save(true)).toBe(true);
    expect(host.project!.save).toHaveBeenLastCalledWith('C:/review/A.mosh', getDoc());
    expect(lifeStore.get().file).toBe('C:/review/A.mosh');
  });

  it('refuses stale Open adoption after an edit while loading and keeps its history', async () => {
    const wait = deferred<any>(); vi.mocked(host.project!.load).mockReturnValueOnce(wait.promise);
    const opening = openProject('C:/review/B.moshpit.json');
    await Promise.resolve();
    commit('CT edit', d => { d.settings.bpm = 137; });
    const edited = projectStore.get(); wait.resolve(loaded()); await opening;
    expect(projectStore.get()).toBe(edited); expect(host.project!.session).not.toHaveBeenCalled();
    expect(lifeStore.get().file).toBe('C:/review/A.moshpit.json'); expect(isDirty()).toBe(true);
  });
  it('refuses stale discard confirmation and stale recovery confirmation', async () => {
    commit('Edit', d => { d.name = 'Before'; });
    vi.mocked(choose).mockImplementationOnce(async () => { commit('New edit', d => { d.name = 'Keep this'; }); return 'discard'; });
    await openProject('C:/review/B.moshpit.json');
    expect(getDoc().name).toBe('Keep this'); expect(host.project!.load).not.toHaveBeenCalled();
    lifeStore.set(s => ({ ...s, saved: projectStore.get().past.at(-1)!.id }));
    const r = loaded(); (r.value as any).recovery = { doc: emptyDoc(), replayed: 1, tornTail: false };
    vi.mocked(host.project!.load).mockResolvedValueOnce(r);
    vi.mocked(choose).mockImplementationOnce(async () => { commit('CT edit', d => { d.name = 'After recovery prompt'; }); return true; });
    await openProject('C:/review/B.moshpit.json');
    expect(getDoc().name).toBe('After recovery prompt'); expect(host.project!.session).not.toHaveBeenCalled();
  });
  it('serializes lifecycle operations while a Save is pending', async () => {
    const wait = deferred<any>(); vi.mocked(host.project!.save).mockReturnValueOnce(wait.promise);
    const saving = save(), before = getDoc();
    expect(await newProject()).toBe(false); await openProject('C:/review/B.moshpit.json');
    expect(host.project!.load).not.toHaveBeenCalled(); expect(getDoc()).toBe(before);
    wait.resolve({ ok: true, value: 'saved' }); expect(await saving).toBe(true);
    expect(await newProject()).toBe(true); expect(getDoc().id).not.toBe(before.id);
  });
  it('cannot attach an old save destination/marker to a replacement session', async () => {
    const wait = deferred<any>(); vi.mocked(host.project!.save).mockReturnValueOnce(wait.promise);
    const saving = save();
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    lifeStore.set({ file: 'C:/review/B.moshpit.json', saved: undefined });
    const replacement = getDoc(); wait.resolve({ ok: true, value: 'saved' });
    expect(await saving).toBe(false); expect(getDoc()).toBe(replacement);
    expect(lifeStore.get()).toMatchObject({ file: 'C:/review/B.moshpit.json', saved: undefined });
  });
  it('keeps edits made during a save dirty while recording the saved snapshot marker', async () => {
    commit('First edit', d => { d.settings.bpm = 100; });
    const marker = projectStore.get().past.at(-1)!.id;
    const wait = deferred<any>(); vi.mocked(host.project!.save).mockReturnValueOnce(wait.promise);
    const saving = save(); commit('CT edit', d => { d.settings.bpm = 133; });
    wait.resolve({ ok: true, value: 'saved' }); expect(await saving).toBe(true);
    expect(lifeStore.get().saved).toBe(marker); expect(isDirty()).toBe(true); expect(getDoc().settings.bpm).toBe(133);
  });
  it('cancels Save As if its original session was replaced during the picker', async () => {
    const wait = deferred<string | null>(); vi.mocked(host.project!.saveDialog).mockReturnValueOnce(wait.promise);
    const saving = save(true);
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    const next = getDoc(); wait.resolve('C:/review/Old destination.moshpit.json');
    expect(await saving).toBe(false); expect(host.project!.save).not.toHaveBeenCalled(); expect(getDoc()).toBe(next);
  });
  it('does not close/discard an initially clean project edited while settings flush is pending', async () => {
    await bootLifecycle();
    const wait = deferred<string>(); vi.mocked(host.writeConfig).mockReturnValueOnce(wait.promise);
    const close = vi.mocked(host.project!.onCloseRequested).mock.calls.at(-1)![0] as () => Promise<void>;
    const closing = close(); await Promise.resolve();
    commit('CT edit', d => { d.settings.bpm = 143; });
    wait.resolve('settings.json'); await closing;
    expect(host.project!.closeNow).not.toHaveBeenCalled(); expect(isDirty()).toBe(true);
    expect(getDoc().settings.bpm).toBe(143);
  });
  it('does not close after Save when a later edit missed the saved snapshot', async () => {
    await bootLifecycle(); commit('Edit', d => { d.settings.bpm = 120; });
    vi.mocked(choose).mockResolvedValueOnce('save');
    vi.mocked(host.project!.save).mockImplementationOnce(async () => { commit('During Save', d => { d.settings.bpm = 145; }); return { ok: true, value: 'saved' }; });
    const close = vi.mocked(host.project!.onCloseRequested).mock.calls.at(-1)![0] as () => Promise<void>;
    await close(); expect(host.project!.closeNow).not.toHaveBeenCalled(); expect(isDirty()).toBe(true);
  });
  it('does not announce close readiness while startup recovery or session setup is pending', async () => {
    const recovery = deferred<any>(), session = deferred<any>();
    vi.mocked(host.project!.pendingRecovery).mockReturnValueOnce(recovery.promise);
    vi.mocked(host.project!.session).mockReturnValueOnce(session.promise);
    const boot = bootLifecycle();
    expect(host.project!.onCloseRequested).toHaveBeenCalledTimes(1);
    expect(host.project!.readyForClose).not.toHaveBeenCalled();
    recovery.resolve({ ok: true, value: [] });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(host.project!.readyForClose).not.toHaveBeenCalled();
    session.resolve({ ok: true, value: 'session' }); await boot;
    expect(host.project!.readyForClose).toHaveBeenCalledTimes(1);
  });
  it('offers recovered dirty work before releasing an early close; Cancel keeps it', async () => {
    const recovered = { ...emptyDoc(), name: 'Recover me' };
    vi.mocked(host.project!.pendingRecovery).mockResolvedValueOnce({ ok: true, value: [
      { file: null, doc: recovered, name: recovered.name, replayed: 1, tornTail: false },
    ] });
    const decision = deferred<any>(); vi.mocked(choose).mockReturnValueOnce(decision.promise);
    const boot = bootLifecycle();
    await Promise.resolve(); await Promise.resolve();
    expect(host.project!.readyForClose).not.toHaveBeenCalled();
    decision.resolve(0); await boot;
    expect(host.project!.readyForClose).toHaveBeenCalledTimes(1);
    expect(isDirty()).toBe(true); expect(getDoc().name).toBe('Recover me (recovered)');
    const before = getDoc();
    const close = vi.mocked(host.project!.onCloseRequested).mock.calls.at(-1)![0] as () => Promise<void>;
    vi.mocked(choose).mockResolvedValueOnce('cancel'); await close();
    expect(getDoc()).toBe(before); expect(host.project!.closeNow).not.toHaveBeenCalled();
    expect(host.project!.discardRecovery).not.toHaveBeenCalled();
  });
  it.each(['save', 'discard'] as const)('retains the normal dirty-close %s decision after readiness', async decision => {
    await bootLifecycle(); commit('Edit', d => { d.settings.bpm = 149; });
    const close = vi.mocked(host.project!.onCloseRequested).mock.calls.at(-1)![0] as () => Promise<void>;
    vi.mocked(choose).mockResolvedValueOnce(decision); await close();
    expect(host.project!.closeNow).toHaveBeenCalledExactlyOnceWith(decision === 'discard');
    if (decision === 'save') {
      expect(host.project!.save).toHaveBeenCalledTimes(1); expect(isDirty()).toBe(false);
    } else { expect(host.project!.save).not.toHaveBeenCalled(); }
  });
  it('keeps dirty work when Save fails during close', async () => {
    await bootLifecycle(); commit('Edit', d => { d.settings.bpm = 151; });
    vi.mocked(choose).mockResolvedValueOnce('save');
    vi.mocked(host.project!.save).mockRejectedValueOnce(new Error('disk full'));
    const close = vi.mocked(host.project!.onCloseRequested).mock.calls.at(-1)![0] as () => Promise<void>;
    await close(); expect(host.project!.closeNow).not.toHaveBeenCalled();
    expect(isDirty()).toBe(true); expect(getDoc().settings.bpm).toBe(151);
  });

});


describe('project migration notices', () => {
  it('reopens graph-1 compatible files twice without a false upgrade and preserves their saved format', async () => {
    const text = serializeProject(emptyDoc());
    for (let i = 0; i < 2; i++) {
      const result = parseProject(text);
      expect(result.migrated).toEqual({ graph: [1, 2] });
      vi.mocked(host.project!.load).mockResolvedValueOnce({ ok: true, value: result });
      await openProject('C:/review/Compatible.mosh');
      expect(serializeProject(getDoc())).toBe(text);
    }
    expect(vi.mocked(toast).mock.calls.filter(([message]) => message.includes('Upgraded'))).toHaveLength(0);
    expect(vi.mocked(toast).mock.calls.filter(([message]) => message === 'Opened Compatible')).toHaveLength(2);
  });
  it('keeps genuine migrations and load warnings visible alongside the no-op graph migration', async () => {
    const result = parseProject(serializeProject(emptyDoc()));
    result.migrated.project = [0, 1];
    const warning = new MoshpitError('PROJECT_TOO_NEW', { section: 'nodeDefs', file: 99, app: 1 });
    result.warnings.push(warning);
    vi.mocked(host.project!.load).mockResolvedValueOnce({ ok: true, value: result });
    await openProject('C:/review/Updated.mosh');
    expect(toastError).toHaveBeenCalledWith(warning);
    const upgrade = vi.mocked(toast).mock.calls.find(([message]) => message.includes('Upgraded'))!;
    expect(upgrade[0]).toContain('project v0→v1');
    expect(upgrade[0]).not.toContain('graph');
  });
});
