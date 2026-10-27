import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/host', () => ({ host: {
  readConfig: vi.fn(async () => null), writeConfig: vi.fn(async () => 'settings.json'),
  project: {
    session: vi.fn(async () => ({ ok: true, value: 'session' })), saveDialog: vi.fn(async () => 'E:/A.mosh'),
    save: vi.fn(async () => ({ ok: true, value: 'saved' })), openDialog: vi.fn(), load: vi.fn(),
    journal: vi.fn(), onCloseRequested: vi.fn(), readyForClose: vi.fn(), onOpenRequested: vi.fn(), readyForOpen: vi.fn(),
    discardRecovery: vi.fn(async () => true), closeNow: vi.fn(async () => {}), pendingRecovery: vi.fn(async () => ({ ok: true, value: [] })),
  },
} }));
vi.mock('../src/qol/qol', async original => ({ ...await original<typeof import('../src/qol/qol')>(), choose: vi.fn(async () => 'cancel'), toast: vi.fn(), toastError: vi.fn() }));
vi.mock('../src/state/conforms', () => ({ checkConforms: vi.fn(), resetConformStatus: vi.fn() }));
import { host } from '../src/host';
import { choose, toastError } from '../src/qol/qol';
import { bootLifecycle, isDirty, lifeStore, save } from '../src/state/lifecycle';
import { commit, emptyDoc, getDoc, projectStore } from '../src/state/project';
function deferred<T>() { let resolve!: (x: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const request = (file: string) => vi.mocked(host.project!.onOpenRequested!).mock.calls.at(-1)![0](file);
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('window', { addEventListener: vi.fn() });
  projectStore.set({ doc: emptyDoc(), past: [], future: [] }); lifeStore.set({ file: 'E:/A.mosh', saved: null });
  vi.mocked(choose).mockResolvedValue('cancel');
  vi.mocked(host.project!.pendingRecovery).mockResolvedValue({ ok: true, value: [] });
  vi.mocked(host.project!.session).mockResolvedValue({ ok: true, value: 'session' });
  vi.mocked(host.project!.load).mockImplementation(async file => ({ ok: true, value: { doc: { ...emptyDoc(), name: file }, warnings: [], migrated: {} } }));
  vi.mocked(host.project!.save).mockResolvedValue({ ok: true, value: 'E:/A.mosh' });
});
afterEach(async () => {
  const hide = vi.mocked(window.addEventListener).mock.calls.find(c => c[0] === 'pagehide')?.[1] as (() => void) | undefined;
  hide?.(); await tick(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});
describe('launcher requests through the real project lifecycle', () => {
  it('waits for recovery/session boot before opening a cold request', async () => {
    const recovering = deferred<{ ok: true; value: [] }>();
    vi.mocked(host.project!.pendingRecovery).mockReturnValueOnce(recovering.promise);
    const boot = bootLifecycle(); request('E:/Example.mosh'); await tick();
    expect(host.project!.load).not.toHaveBeenCalled(); expect(host.project!.readyForOpen).not.toHaveBeenCalled();
    recovering.resolve({ ok: true, value: [] }); await boot; await tick();
    expect(host.project!.readyForOpen).toHaveBeenCalledOnce();
    expect(host.project!.load).toHaveBeenCalledWith('E:/Example.mosh'); expect(getDoc().name).toBe('E:/Example.mosh');
  });
  it('cancel preserves unsaved work and does not load or save the requested file', async () => {
    await bootLifecycle(); commit('Owner edit', d => { d.settings.bpm = 137; }); const before = getDoc();
    request('E:/Example.mosh'); await tick();
    expect(choose).toHaveBeenCalled(); expect(getDoc()).toBe(before); expect(isDirty()).toBe(true);
    expect(host.project!.load).not.toHaveBeenCalled(); expect(host.project!.save).not.toHaveBeenCalled();
  });
  it('saves unsaved work before adopting an existing-instance request', async () => {
    await bootLifecycle(); commit('Owner edit', d => { d.settings.bpm = 137; });
    vi.mocked(choose).mockResolvedValueOnce('save'); request('E:/Example.mosh'); await tick();
    expect(host.project!.save).toHaveBeenCalledWith('E:/A.mosh', expect.objectContaining({ settings: expect.objectContaining({ bpm: 137 }) }));
    expect(vi.mocked(host.project!.save).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(host.project!.load).mock.invocationCallOrder[0]);
    expect(getDoc().name).toBe('E:/Example.mosh');
  });
  it('keeps only the latest request while Save is busy, then uses ordinary Open', async () => {
    await bootLifecycle(); commit('Edit', d => { d.settings.bpm = 138; });
    const writing = deferred<{ ok: true; value: string }>(); vi.mocked(host.project!.save).mockReturnValueOnce(writing.promise);
    const saving = save(); await tick(); request('E:/B.mosh'); request('E:/C.mosh');
    expect(host.project!.load).not.toHaveBeenCalled();
    writing.resolve({ ok: true, value: 'E:/A.mosh' }); await saving; await tick();
    expect(host.project!.load).toHaveBeenCalledExactlyOnceWith('E:/C.mosh'); expect(getDoc().name).toBe('E:/C.mosh');
  });
  it('discard opens the requested project without writing the original', async () => {
    await bootLifecycle(); commit('Edit', d => { d.settings.bpm = 139; });
    vi.mocked(choose).mockResolvedValueOnce('discard'); request('E:/Example.mosh'); await tick();
    expect(getDoc().name).toBe('E:/Example.mosh'); expect(host.project!.save).not.toHaveBeenCalled();
  });
  it('failed Save leaves the dirty document current and never loads the request', async () => {
    await bootLifecycle(); commit('Edit', d => { d.settings.bpm = 139; }); const before = getDoc();
    vi.mocked(host.project!.save).mockRejectedValueOnce(new Error('Disk full'));
    vi.mocked(choose).mockResolvedValueOnce('save'); request('E:/Example.mosh'); await tick();
    expect(getDoc()).toBe(before); expect(isDirty()).toBe(true); expect(host.project!.load).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });
  it('a load failure preserves the current document and reports the ordinary error', async () => {
    await bootLifecycle(); const before = getDoc(); vi.mocked(host.project!.load).mockResolvedValueOnce({ ok: false, error: { code: 'PROJECT_PARSE', context: {}, severity: 'error', humanMessage: 'Invalid', suggestedFix: '' } });
    request('E:/Broken.mosh'); await tick(); expect(getDoc()).toBe(before); expect(toastError).toHaveBeenCalled();
  });
});
