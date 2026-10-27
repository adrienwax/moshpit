// Checkpoint 1, A-3: the long jobs (probe, conform, the D7 re-check, cut detection, source hash) behind
// one seam. The service calls a JobRunner; in tests and the harness that is `localJobs` (in process),
// in the app it is `remoteJobs` over a MessagePort to a crash-isolated Electron utilityProcess. Same
// functions, same arguments: the bytes they write cannot differ by where they ran.
//
// Wire protocol (client → host): { id, method, args }   { id, cancel: true }
//                (host → client): { id, ok: true, value }   { id, ok: false, error }   { id, progress }
import { conform, conformMaster, conformProxy, probe, sourceHash, type ConformSettings } from '../conform/conform';
import { detectCuts } from '../conform/scenes';
import { asMoshpitError, MoshpitError } from '../errors';
import type { ConformedSource, SourceId } from '@moshpit/core';

/** What a call can carry that cannot cross a port: kept on the caller's side. */
export interface JobCtl { signal?: AbortSignal; onProgress?: (f: number) => void }

export const localJobs = {
  probe: (file: string, ffmpeg?: string, _c: JobCtl = {}) => probe(file, ffmpeg),
  sourceHash: async (file: string, _c: JobCtl = {}) => sourceHash(file),
  conformProxy: (id: SourceId, file: string, s: ConformSettings, dir: string, c: JobCtl = {}) => conformProxy(id, file, s, dir, c),
  // Records only: the parsed video stays in this process (it is large, and the service never reads it).
  conformMaster: (rec: ConformedSource, file: string, s: ConformSettings, dir: string, background: boolean, c: JobCtl = {}) => conformMaster(rec, file, s, dir, { ...c, background }).then((r) => ({ record: r.record })),
  /** D7: a fresh full conform (never reused). */
  reconform: (id: SourceId, file: string, s: ConformSettings, dir: string, c: JobCtl = {}) => conform(id, file, s, dir, c.onProgress, { reuse: false, signal: c.signal }).then((r) => ({ record: r.record })),
  detectCuts: (conf: ConformedSource, sensitivity: number, ffmpeg?: string, c: JobCtl = {}) => detectCuts(conf, sensitivity, { ffmpeg, signal: c.signal }),
};
export type JobRunner = typeof localJobs;
export type JobMethod = keyof JobRunner;

/** The one port surface both ends need (a DOM MessagePort or Electron's MessagePortMain). */
export interface PortLike { postMessage(m: unknown): void }

/**
 * The client: each call posts its arguments (the JobCtl stays here), relays progress, and sends a
 * cancel on abort. `fail(err)` rejects every call in flight: the host process died, and a job that
 * was running there will never answer.
 */
export function remoteJobs(post: (m: unknown) => void): { runner: JobRunner; receive(m: unknown): void; fail(err: Error): void } {
  let next = 1;
  const calls = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void; ctl: JobCtl }>();
  const call = (method: JobMethod) => (...args: unknown[]) => {
    const ctl = (args.length && typeof args.at(-1) === 'object' && args.at(-1) !== null && !Array.isArray(args.at(-1)) && isCtl(args.at(-1)) ? args.pop() : {}) as JobCtl;
    if (ctl.signal?.aborted) return Promise.reject(new DOMException('cancelled', 'AbortError'));
    const id = next++;
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject, ctl });
      ctl.signal?.addEventListener('abort', () => post({ id, cancel: true }), { once: true });
      post({ id, method, args });
    });
  };
  const runner = Object.fromEntries((Object.keys(localJobs) as JobMethod[]).map((m) => [m, call(m)])) as unknown as JobRunner;
  return {
    runner,
    receive(raw) {
      const m = raw as { id: number; ok?: boolean; value?: unknown; error?: ReturnType<MoshpitError['toJSON']>; aborted?: boolean; progress?: number };
      const c = calls.get(m.id);
      if (!c) return;
      if (m.progress !== undefined) return void c.ctl.onProgress?.(m.progress);
      calls.delete(m.id);
      if (m.ok) c.resolve(m.value);
      else if (m.aborted || c.ctl.signal?.aborted) c.reject(new DOMException('cancelled', 'AbortError'));
      else { const e = m.error!; c.reject(new MoshpitError(e.code, e.context, e.cause, e.humanMessage)); }
    },
    fail(err) {
      for (const [id, c] of calls) { calls.delete(id); c.reject(err); }
    },
  };
}
// A JobCtl is the trailing options bag: only signal / onProgress keys (settings objects have others).
const isCtl = (o: unknown) => Object.keys(o as object).every((k) => k === 'signal' || k === 'onProgress');

/** The host: runs each call with localJobs, one AbortController per call. `abortAll` cancels every call in flight. */
export function serveJobs(post: (m: unknown) => void, jobs: JobRunner = localJobs): ((raw: unknown) => void) & { abortAll(): void } {
  const inflight = new Map<number, AbortController>();
  const receive = (raw: unknown) => {
    const m = raw as { id: number; method?: JobMethod; args?: unknown[]; cancel?: boolean };
    if (m.cancel) return void inflight.get(m.id)?.abort();
    const ac = new AbortController();
    inflight.set(m.id, ac);
    const fn = jobs[m.method!] as ((...a: unknown[]) => Promise<unknown>) | undefined;
    const run = fn ? fn(...(m.args ?? []), { signal: ac.signal, onProgress: (f: number) => post({ id: m.id, progress: f }) }) : Promise.reject(new Error(`unknown job ${m.method}`));
    run.then(
      (value) => post({ id: m.id, ok: true, value }),
      (e) => post(ac.signal.aborted ? { id: m.id, ok: false, aborted: true } : { id: m.id, ok: false, error: asMoshpitError(e, { method: m.method }).toJSON() }),
    ).finally(() => inflight.delete(m.id));
  };
  return Object.assign(receive, { abortAll: () => { for (const ac of inflight.values()) ac.abort(); } });
}
