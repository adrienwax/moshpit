// D7 — conform determinism across dependency bumps. On reopen, the engine can re-conform every
// clip and compare with the pinned record (EngineClient.verifyConforms). A changed result keeps
// the pinned conform in use and raises CONFORM_CHANGED (≈); a missing source raises
// MEDIA_FILE_MISSING. It is expensive, so the user decides: Settings → re-check on open.
import { createElement as h } from 'react';
import type { MoshpitErrorJSON, SourceId } from '@moshpit/engine';
import { engine, type ConformCheck, type ConformState as MasterPhase, type ConformUpdate, type Task } from '../engine';
import { createStore, useStore } from './store';
import { adoptConform, getDoc } from './project';
import { settingsStore } from './ui';
import { asError, toast, toastError } from '../qol/qol';

interface ConformState {
  running?: { done: number; total: number; task: Task<ConformCheck[]> };
  status: Record<string, ConformCheck['status']>;
  checkedAt?: number;
}
export const conformStore = createStore<ConformState>({ status: {} });
export const useConforms = <U>(sel: (s: ConformState) => U) => useStore(conformStore, sel);
let conformCheckGeneration = 0;
export const resetConformStatus = () => {
  conformCheckGeneration++;
  conformStore.get().running?.task.cancel();
  conformStore.set({ status: {} });
};

export async function runConformCheck() {
  const doc = getDoc();
  const total = doc.resources.sources.length;
  if (!total) return toast('No clips to re-check', { kind: 'info' });
  const generation = ++conformCheckGeneration;
  conformStore.get().running?.task.cancel();
  let task: Task<ConformCheck[]>;
  task = engine.verifyConforms((p) => conformCheckGeneration === generation && conformStore.get().running?.task === task && conformStore.set((s) => ({ ...s, running: { ...s.running!, ...p } })));
  conformStore.set((s) => ({ ...s, running: { done: 0, total, task } }));
  try {
    const results = await task.promise;
    if (conformCheckGeneration !== generation || conformStore.get().running?.task !== task) return;
    const status: ConformState['status'] = {};
    for (const r of results) status[r.sourceId] = r.status;
    conformStore.set({ status, checkedAt: Date.now() });
    const name = (id: SourceId) => doc.resources.sources.find((s) => s.id === id)?.name ?? id;
    const changed = results.filter((r) => r.status === 'changed');
    const missing = results.filter((r) => r.status === 'missing');
    if (!changed.length && !missing.length) toast(`All ${results.length} conformed clips match their pinned conforms`, { kind: 'ok' });
    if (changed.length) {
      const e = asError(changed[0].error ?? { code: 'CONFORM_CHANGED' });
      toast(h('span', null, h('b', null, `≈ ${changed.length} clip${changed.length > 1 ? 's' : ''} conform differently now: `), changed.map((r) => name(r.sourceId)).join(', '), '. ', h('span', { className: 'tfix' }, e.suggestedFix)), { kind: 'warn', ms: 12000 });
    }
    for (const m of missing) toastError(m.error ?? { code: 'MEDIA_FILE_MISSING', context: { sourceId: m.sourceId } });
  } catch (e) {
    if (conformCheckGeneration !== generation || conformStore.get().running?.task !== task) return;
    conformStore.set((s) => ({ ...s, running: undefined }));
    if ((e as Error)?.name !== 'AbortError') toastError(e);
  }
}

/** Called after open/recovery: follow the user's setting (ask / always / never). */
export function checkConforms(_trigger: 'open') {
  const n = getDoc().resources.sources.length;
  if (!n) return;
  const mode = settingsStore.get().conformCheck;
  if (mode === 'never') return;
  if (mode === 'always') return void runConformCheck();
  toast(`Re-check ${n} conformed clip${n > 1 ? 's' : ''} against their pinned conforms? It re-encodes each one, so it takes a while.`, { kind: 'info', ms: 12000, action: { label: 'Re-check', run: () => void runConformCheck() } });
}

// ---------- proxy-first masters ----------
// An import resolves as soon as the proxy exists (usable now: browse, slice, mosh preview); the
// full-quality master encodes in the background and reports here. READY swaps its record into
// the project; FAILED leaves the proxy working and says why. Export and freeze wait for masters.

export interface MasterState { state: MasterPhase; fraction?: number; error?: MoshpitErrorJSON }
export const masterStore = createStore<Record<string, MasterState>>({});
export const useMaster = (id?: SourceId) => useStore(masterStore, (m) => (id ? m[id] : undefined));

const DONE_SHOWN_MS = 8000;
function onMaster(u: ConformUpdate) {
  masterStore.set((m) => ({ ...m, [u.sourceId]: { state: u.state, fraction: u.fraction, error: u.error } }));
  if (u.state === 'READY') {
    if (u.conform) adoptConform(u.conform);
    // The quiet done state shows for a moment, then the badge goes away.
    setTimeout(() => masterStore.set((m) => {
      if (m[u.sourceId]?.state !== 'READY') return m;
      const { [u.sourceId]: _, ...rest } = m;
      return rest;
    }), DONE_SHOWN_MS);
  }
  if (u.state === 'FAILED') toastError(u.error ?? { code: 'CONFORM_FAILED', context: { sourceId: u.sourceId } });
}
engine.onConformUpdate?.(onMaster);
// Masters the engine already knows about (a project reopened mid-conform) get their badges back.
void engine.conformStates?.().then((all) => all.forEach(onMaster), () => {});
