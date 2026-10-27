// The project lifecycle in the renderer: New / Open / Save / Save As / Recent, dirty tracking,
// the autosave journal (one delta per committed edit, L14), crash recovery on start-up and on
// open, and the unsaved-changes prompt on close. The disk work happens in electron/project-host.ts
// through the engine's persistence API; this module owns the decisions and the document (L24).
import { createElement as h } from 'react';
import { freeze } from 'immer';
import type { ProjectDoc } from '@moshpit/engine';
import { host, type PendingRecovery, type ProjectPeek } from '../host';
import { createStore, useStore } from './store';
import { emptyDoc, ensureDecode, projectStore, repairStreamOrder } from './project';
import { engine } from '../engine';
import { setUi, settingsStore, flushSettings } from './ui';
import { asError, choose, toast, toastError } from '../qol/qol';
import { checkConforms, resetConformStatus } from './conforms';
import { resetProjectJobs } from './jobs';
import { projectFileStem } from '../lib/projectFiles';

interface LifeState {
  file: string | null;
  /** The id of the history entry on top at the last save/open (null: none); `undefined` = never saved (recovered). */
  saved: number | null | undefined;
  busy?: 'opening' | 'saving';
}

export const lifeStore = createStore<LifeState>({ file: null, saved: null });
// Entries keep their id through undo/redo, so redoing back to the saved step reads as saved again.
const top = () => projectStore.get().past.at(-1)?.id ?? null;

/** Dirty = an undoable edit since the last save. View-only changes (selection, pan) never count. */
export const isDirty = () => top() !== lifeStore.get().saved;
export function useDirty() {
  const t = useStore(projectStore, (s) => s.past.at(-1)?.id ?? null);
  const saved = useStore(lifeStore, (s) => s.saved);
  return t !== saved;
}
export const useLife = <U>(sel: (s: LifeState) => U) => useStore(lifeStore, sel);

const bridge = () => host.project;
export const desktop = () => !!bridge();
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw asError(r.error);
  return r.value;
};
const baseName = projectFileStem;

// Only one lifecycle operation owns the session at a time. Ordinary edits (including CT writes)
// remain responsive; operations recheck their document before discarding or naming it.
let lifecycleBusy = false;
let externalOpenReady = false;
let pendingExternalOpen: string | null = null;
function drainExternalOpen() {
  if (!externalOpenReady || lifecycleBusy || !pendingExternalOpen) return;
  const file = pendingExternalOpen;
  pendingExternalOpen = null;
  void openProject(file).catch(toastError);
}
async function withLifecycle<T>(fallback: T, run: () => Promise<T>): Promise<T> {
  if (lifecycleBusy) { toast('A project operation is still finishing. Try again when it completes.', { kind: 'warn' }); return fallback; }
  lifecycleBusy = true;
  try { return await run(); } finally { lifecycleBusy = false; drainExternalOpen(); }
}
const changedDuring = (action: string) => toast(`The project changed while ${action}. Your latest work was kept; try again when ready.`, { kind: 'warn' });
function filenameOnlySave(previous: ProjectDoc, previousFile: string | null): boolean {
  const current = projectStore.get().doc, savedFile = lifeStore.get().file;
  return !previousFile && !!savedFile && previous.name === 'Untitled' && !isDirty() &&
    current.name === baseName(savedFile) && (Object.keys(previous) as (keyof ProjectDoc)[]).every(k => k === 'name' || current[k] === previous[k]);
}

/** Replace the whole document: a fresh history, the engine told, the session UI reset. */
function adopt(opened: ProjectDoc, file: string | null, recovered: boolean) {
  // Repairs a graph an earlier build mis-ordered (＋ Speed after the decode node): said, not silent.
  const { doc: repaired, moved } = repairStreamOrder(opened);
  const doc = ensureDecode(repaired); // Phase 1.1: the decode boundary is drawn in every block
  if (moved.length) toast(`Moved ${moved.join(', ')} before the decode boundary — an earlier build placed ${moved.length > 1 ? 'them' : 'it'} after it, which stopped rendering. Save to keep the fix.`, { kind: 'warn' });
  resetProjectJobs();
  projectStore.set({ doc: freeze(doc, true), past: [], future: [] }); // A-4: store docs are frozen (project.ts commit)
  engine.updateProject(doc);
  lifeStore.set({ file, saved: recovered ? undefined : null });
  setUi({ playhead: 0, playing: false, loupes: { A: { frame: 0 }, B: { frame: 0 } }, renderJob: undefined });
  resetConformStatus();
}

async function startSession(file: string | null, saved: ProjectDoc, current: ProjectDoc | null) {
  const b = bridge();
  if (b) unwrap(await b.session(file, saved, current));
}

/** If there are unsaved edits: Save / Don't save / Cancel. Resolves false to abort the caller. */
async function settleUnsaved(action: string): Promise<boolean> {
  if (!isDirty()) return true;
  const name = projectStore.get().doc.name;
  const c = await choose(
    `Save changes to “${name}”?`,
    h('p', null, `Your edits since the last save will be lost if you ${action} without saving.`),
    [
      { label: "Don't save", value: 'discard' as const, kind: 'ghost' },
      { label: 'Cancel', value: 'cancel' as const, kind: 'ghost' },
      { label: 'Save', value: 'save' as const, kind: 'primary' },
    ],
    1,
  );
  if (c === 'cancel') return false;
  if (c === 'save') return saveCurrent();
  return true;
}

/** True only when this new, untouched document is still current when setup completes. */
export const newProject = (): Promise<boolean> => withLifecycle(false, newProjectCurrent);
async function newProjectCurrent(): Promise<boolean> {
  const previous = projectStore.get().doc;
  const previousFile = lifeStore.get().file;
  if (!(await settleUnsaved('start a new project'))) return false;
  const current = projectStore.get().doc;
  // Save As gives an Untitled document its filename without changing its contents.
  const savedRename = filenameOnlySave(previous, previousFile);
  if (current !== previous && !savedRename) {
    toast('The project changed while confirming New. Your latest work was kept; start again when ready.', { kind: 'warn' });
    return false;
  }
  const doc = emptyDoc();
  adopt(doc, null, false);
  const adopted = projectStore.get().doc;
  await startSession(null, doc, null).catch(toastError);
  if (projectStore.get().doc !== adopted) return false;
  toast('New project', { kind: 'ok' });
  return true;
}

export const openProject = (file?: string): Promise<void> => withLifecycle(undefined, () => openProjectCurrent(file));
async function openProjectCurrent(file?: string) {
  const b = bridge();
  if (!b) return toast('Opening project files needs the desktop app', { kind: 'warn' });
  const previous = projectStore.get().doc, previousFile = lifeStore.get().file;
  if (!(await settleUnsaved('open another project'))) return;
  if (projectStore.get().doc !== previous && !filenameOnlySave(previous, previousFile)) return changedDuring('confirming Open');
  const approved = projectStore.get().doc;
  const f = file ?? (await b.openDialog());
  if (!f) return;
  if (projectStore.get().doc !== approved) return changedDuring('choosing a project');
  lifeStore.set((s) => ({ ...s, busy: 'opening' }));
  try {
    const r = unwrap(await b.load(f));
    if (projectStore.get().doc !== approved) return changedDuring('opening a project');
    if (r.recovery) {
      const c = await choose(
        'Recover unsaved edits?',
        h('p', null, `“${r.doc.name}” has ${r.recovery.replayed} edit${r.recovery.replayed === 1 ? '' : 's'} made after its last save, kept by autosave when Moshpit closed unexpectedly.${r.recovery.tornTail ? ' The very last edit was cut off and is not included.' : ''} Recovering opens them as a new unsaved copy; the file itself stays as last saved.`),
        [
          { label: 'Open last save', value: false, kind: 'ghost' },
          { label: 'Recover edits', value: true, kind: 'primary' },
        ],
        1,
        '↺',
      );
      if (projectStore.get().doc !== approved) return changedDuring('confirming recovery');
      if (c) {
        await adoptRecovered(r.recovery.doc, f);
        toast(`Recovered ${r.recovery.replayed} edits as “${projectStore.get().doc.name}”. Save it to keep it; ${baseName(f)} is unchanged.`, { kind: 'ok' });
        return;
      }
    }
    adopt(r.doc, f, false);
    await startSession(f, r.doc, null);
    for (const w of r.warnings) toastError(w);
    // A container-free graph 1 is read as graph 2 but deliberately saved as graph 1.
    // Hide only that identity migration; keep actual migrations and all load warnings.
    const ups = Object.entries(r.migrated).filter(([section, [from, to]]) =>
      !(section === 'graph' && from === 1 && to === 2 && !r.doc.timeline.blocks.some(b => b.graph.nodes.some(n => n.kind === 'group.container'))));
    if (ups.length) toast(`Upgraded this project's format (${ups.map(([s, [a, z]]) => `${s} v${a}→v${z}`).join(', ')}). Saving writes the new format.`, { kind: 'warn' });
    toast(`Opened ${baseName(f)}`, { kind: 'ok' });
    void checkConforms('open');
  } catch (e) {
    toastError(e);
  } finally {
    lifeStore.set((s) => ({ ...s, busy: undefined }));
  }
}

/** Save to the current file, or ask where (Save As) the first time. Resolves false if cancelled. */
export const save = (as = false): Promise<boolean> => withLifecycle(false, () => saveCurrent(as));
async function saveCurrent(as = false): Promise<boolean> {
  const b = bridge();
  if (!b) {
    toast('Saving project files needs the desktop app', { kind: 'warn' });
    return false;
  }
  const originId = projectStore.get().doc.id, originFile = lifeStore.get().file;
  const sameSession = () => projectStore.get().doc.id === originId && lifeStore.get().file === originFile;
  let file = originFile;
  if (as || !file) {
    file = await b.saveDialog(projectStore.get().doc.name);
    if (!file) return false;
    if (!sameSession()) { changedDuring('choosing a save location'); return false; }
    // An untitled project takes its file's name (not an undoable edit: it is what Save As means).
    const name = projectStore.get().doc.name;
    if (!lifeStore.get().file && name === 'Untitled') {
      projectStore.set((s) => ({ ...s, doc: freeze({ ...s.doc, name: baseName(file!) }, true) }));
    }
  }
  lifeStore.set((s) => ({ ...s, busy: 'saving' }));
  try {
    const marker = top();
    unwrap(await b.save(file, projectStore.get().doc));
    if (!sameSession()) { changedDuring('saving'); return false; }
    lifeStore.set({ file, saved: marker });
    toast(`Saved ${baseName(file)}`, { kind: 'ok' });
    return true;
  } catch (e) {
    toastError(e);
    return false;
  } finally {
    lifeStore.set((s) => ({ ...s, busy: undefined }));
  }
}

export const recents = () => bridge()?.recents() ?? Promise.resolve([] as string[]);
export const peekProject = (file: string) => bridge()?.peek(file) ?? Promise.resolve({ file, error: 'needs the desktop app' } as ProjectPeek);

/**
 * Start-up: offer anything a crash left behind, then start the journal for whatever we open.
 * Untitled sessions journal too, so a crash before the first save is recoverable as well.
 */
export async function bootLifecycle() {
  const b = bridge();
  if (!b) return; // browser dev mode: no files, no journal
  externalOpenReady = false;
  b.onOpenRequested?.(file => { pendingExternalOpen = file; drainExternalOpen(); });
  // Journal every committed edit (coalesced; a drag-scrub lands as one delta).
  let last = top();
  let timer: ReturnType<typeof setTimeout> | undefined;
  projectStore.subscribe(() => {
    const t = top();
    if (t === last) return;
    last = t;
    clearTimeout(timer);
    timer = setTimeout(flush, 150);
  });
  // Phase 0.3: 150 ms (was 500) bounds what a killed process can lose, and a closing or reloading
  // page sends what is still waiting. A drag keeps re-arming the timer, so it lands as one delta.
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (settingsStore.get().autosaveMin > 0) b!.journal(projectStore.get().doc);
  }
  window.addEventListener('pagehide', () => {
    externalOpenReady = false;
    pendingExternalOpen = null;
    if (timer !== undefined) flush();
  });
  b.onCloseRequested(() => withLifecycle(undefined, async () => {
    const requested = projectStore.get().doc;
    const close = async (discard: boolean) => {
      const approved = projectStore.get().doc;
      try { await flushSettings(); }
      catch {
        const c = await choose('Settings could not be saved', h('p', null, 'Keep Moshpit open to retry, or close using the previously saved settings.'), [
          { label: 'Keep open', value: 'cancel' as const, kind: 'primary' },
          { label: 'Close anyway', value: 'close' as const, kind: 'ghost' },
        ], 0);
        if (c !== 'close') return;
      }
      if (projectStore.get().doc !== approved) return changedDuring('saving settings before closing');
      await b.closeNow(discard);
    };
    // Nothing unsaved: the journal holds nothing worth recovering.
    if (!isDirty()) return close(true);
    const c = await choose(
      `Save changes to “${projectStore.get().doc.name}” before closing?`,
      h('p', null, 'If you close without saving, these edits are discarded.'),
      [
        { label: "Don't save", value: 'discard' as const, kind: 'ghost' },
        { label: 'Cancel', value: 'cancel' as const, kind: 'ghost' },
        { label: 'Save', value: 'save' as const, kind: 'primary' },
      ],
      1,
    );
    if (c === 'cancel') return;
    if (projectStore.get().doc !== requested) return changedDuring('confirming Close');
    if (c === 'save') {
      if (!(await saveCurrent())) return;
      if (isDirty()) return changedDuring('saving before closing');
    }
    await close(c === 'discard');
  }));

  try {
    try {
      const pending = unwrap(await b.pendingRecovery());
      const crashed = (await b.lastCrash?.()) ?? null;
      if (pending.length && (await offerRecovery(pending, crashed))) return;
    } catch (e) {
      toastError(e);
    }
    const doc = projectStore.get().doc;
    await startSession(null, doc, null).catch(toastError);
  } finally {
    // An early Quit must wait for recovery and journal setup as well as the listener.
    // Otherwise it could approve the empty startup document while recovery is pending.
    b.readyForClose?.();
    externalOpenReady = true;
    b.readyForOpen?.();
    drainExternalOpen();
  }
}

/**
 * Offer what a crash left behind: every pending journal, newest first (up to three as buttons;
 * the rest stay on disk for next time). Phase 0.3: recovered work opens as a NEW unsaved project,
 * "<name> (recovered)", so saving it can never overwrite the original; the original file stays as
 * last saved, and its journal goes once the recovered copy has its own.
 */
async function offerRecovery(pending: PendingRecovery[], crashed: string | null): Promise<boolean> {
  const where = (p: PendingRecovery) => (p.file ? `“${p.name}” (${baseName(p.file)})` : `the untitled project “${p.name}”`);
  const edits = (p: PendingRecovery) => `${p.replayed} edit${p.replayed === 1 ? '' : 's'}`;
  const title = crashed ? 'The window crashed. Your edits are safe' : 'Moshpit closed without saving';
  const body = pending.length === 1
    ? `Autosave kept ${edits(pending[0])} to ${where(pending[0])}.${pending[0].tornTail ? ' The very last edit was cut off and is not included.' : ''} Recovering opens them as a new unsaved copy; the original file is not changed.`
    : `Autosave kept unsaved edits in ${pending.length} projects: ${pending.map((p) => `${where(p)}, ${edits(p)}`).join('; ')}. Recover one as a new unsaved copy; the others stay for next time.`;
  const shown = pending.slice(0, 3);
  const c = await choose<number | 'discard' | 'later'>(
    title,
    h('p', null, body),
    [
      { label: pending.length === 1 ? 'Discard' : 'Discard all', value: 'discard', kind: 'ghost' },
      ...(pending.length > 1 ? [{ label: 'Not now', value: 'later' as const, kind: 'ghost' as const }] : []),
      ...shown.map((p, i) => ({ label: pending.length === 1 ? 'Recover' : `Recover ${p.name}`, value: i, kind: (i === 0 ? 'primary' : 'ghost') as 'primary' | 'ghost' })),
    ],
    pending.length > 1 ? 2 : 1,
    '↺',
  );
  const b = bridge()!;
  if (c === 'later') return false;
  if (c === 'discard') {
    for (const p of pending) await b.discardRecovery(p.file);
    return false;
  }
  const p = pending[c];
  await adoptRecovered(p.doc, p.file);
  toast(`Recovered ${edits(p)} as “${projectStore.get().doc.name}”. Save it to keep it; the original is unchanged.`, { kind: 'ok' });
  return true;
}

/** Open recovered work as a new, unsaved project and move its journal into the new session. */
async function adoptRecovered(recovered: ProjectDoc, from: string | null) {
  const doc = { ...recovered, name: / \(recovered\)$/.test(recovered.name) ? recovered.name : `${recovered.name} (recovered)` };
  adopt(doc, null, true);
  // Journal it against an empty base: the recovered state is itself a delta, so a second crash
  // before any save still finds it (a session based on it would have an empty journal).
  await startSession(null, emptyDoc(), doc);
  if (from) await bridge()!.discardRecovery(from);
  void checkConforms('open');
}
