// App-level background jobs (audit B1/B6). A long operation the user starts — an import, a scene
// detection — belongs to the app, not to the pane that started it: switching workspace unmounts
// the pane, never the job. Progress shows wherever the job's key is looked up, and on the status
// strip. One job per key, so re-entering a workspace cannot start a second copy. A job ends only
// by finishing, failing (kept until dismissed or restarted) or an explicit Cancel.
// Renders, masters and conform checks already live in their own module stores (render.ts,
// conforms.ts), so they need nothing here.
import type { Task } from '../engine';
import { createStore, useStore } from './store';
import { toastError } from '../qol/qol';

export type JobKind = 'import' | 'detect';
export interface BgJob {
  key: string;
  kind: JobKind;
  label: string;
  stage?: string;
  fraction: number;
  task?: Task<unknown>;
  /** Failed: kept so the pane that owns this key can show the error. */
  error?: unknown;
}

export const jobStore = createStore<Record<string, BgJob>>({});
export const useJob = (key?: string) => useStore(jobStore, (j) => (key ? j[key] : undefined));
export const useRunningJobs = () => useStore(jobStore, (j) => j);

// The real worker reports a cancel as an INTERNAL error wrapping the abort, so a cancel is known by
// who asked for it, not by the error's name.
const cancelled = new WeakSet<Task<unknown>>();
let projectSession = 0;
export const getProjectSession = () => projectSession;

/** New/Open/recovery replaces the session, including reopening the same project id. Engine
 * work can finish and keep its cached media, but must never edit the replacement document. */
export function resetProjectJobs() {
  projectSession++;
  jobStore.set({});
}

const patch = (key: string, p: Partial<BgJob>) => jobStore.set((j) => (j[key] ? { ...j, [key]: { ...j[key], ...p } } : j));
const drop = (key: string) => jobStore.set((j) => {
  if (!j[key]) return j;
  const { [key]: _, ...rest } = j;
  return rest;
});

/**
 * Start `kind` under `key` unless one is already running there (then that one is returned).
 * `done` runs when it succeeds — after a workspace switch too, since it lives here.
 */
export function runJob<T>(
  key: string,
  kind: JobKind,
  label: string,
  start: (onProgress: (p: { stage?: string; fraction: number }) => void) => Task<T>,
  done: (value: T) => void,
): BgJob {
  const running = jobStore.get()[key];
  if (running?.task) return running;
  const session = projectSession;
  let task: Task<T> | undefined;
  const ownsSlot = () => session === projectSession && !!task && jobStore.get()[key]?.task === task;
  task = start((p) => { if (ownsSlot()) patch(key, { stage: p.stage, fraction: p.fraction }); });
  const job: BgJob = { key, kind, label, fraction: 0, task };
  jobStore.set((j) => ({ ...j, [key]: job }));
  task.promise.then(
    (v) => {
      if (!ownsSlot()) return;
      drop(key);
      if (cancelled.has(task!)) return;
      try { done(v); } catch (e) { toastError(e); }
    },
    (e) => {
      if (!ownsSlot()) return;
      if (cancelled.has(task!) || (e as Error)?.name === 'AbortError') return drop(key);
      patch(key, { task: undefined, error: e });
      toastError(e);
    },
  );
  return job;
}

export function cancelJob(key: string) {
  const t = jobStore.get()[key]?.task;
  if (!t) return;
  cancelled.add(t);
  t.cancel();
}
/** Forget a failed job (its error banner was dismissed). */
export const dismissJob = (key: string) => {
  if (!jobStore.get()[key]?.task) drop(key);
};
