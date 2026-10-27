// The export queue, shared by Mosh mode's compact Render pane and the Render workspace.
// Jobs run one at a time through EngineClient.render(); the engine refuses to overwrite.
import { useMemo } from 'react';
import type { ExportConfig, MoshpitErrorJSON, ProjectDoc } from '@moshpit/engine';
import { safeFileName } from '@moshpit/engine';
import { engine, type RenderProgress, type Task } from '../engine';
import { createStore, useStore } from './store';
import { asError, toast, toastError } from '../qol/qol';
import { setUi, settingsStore } from './ui';
import { getDoc } from './project';
import { timelineFrames } from '../lib/timeline';
import { host } from '../host';
import { rememberPreview } from './previews';
import { PROJECT_RESOLUTIONS } from '../lib/resolutions';
export { quickStore } from './previews';

// Format roles describe intended workflow. Past repeatability fixtures do not establish a
// byte-identity guarantee across drivers, encoder builds, metadata and every project graph.
export type FormatRole = 'master' | 'delivery';
export const FORMATS: { id: ExportConfig['format']; label: string; ext: string; role: FormatRole }[] = [
  { id: 'hap', label: 'HAP', ext: 'mov', role: 'master' },
  { id: 'hapq', label: 'HAP Q', ext: 'mov', role: 'master' },
  { id: 'hap-alpha', label: 'HAP Alpha', ext: 'mov', role: 'master' },
  { id: 'prores-422hq', label: 'ProRes 422 HQ', ext: 'mov', role: 'master' },
  { id: 'prores-4444', label: 'ProRes 4444', ext: 'mov', role: 'master' },
  { id: 'mp4-h264', label: 'H.264', ext: 'mp4', role: 'delivery' },
  { id: 'png-seq', label: 'PNG sequence', ext: 'png', role: 'master' },
];
export const roleOf = (f: ExportConfig['format']): FormatRole => FORMATS.find((x) => x.id === f)?.role ?? 'delivery';
export const ROLE_TEXT: Record<FormatRole, { tag: string; tip: string }> = {
  master: { tag: 'MASTER', tip: 'Keep a reference export: HAP for VJ playback, ProRes for editing, or PNG for lossless frames. Identical file bytes across renders are not guaranteed.' },
  delivery: { tag: 'DELIVERY', tip: 'A compact export for sharing and review. H.264 encoder output can vary between runs; retain a reference export too.' },
};
// Explicit output sizes remain available independently of the project working size.
export const RESOLUTIONS = [
  ...PROJECT_RESOLUTIONS,
  { w: 960, h: 540, label: '960×540 (Proxy)' },
  { w: 540, h: 960, label: '540×960 (Proxy)' },
];
export interface ExportPreset { name: string; desc: string; format: ExportConfig['format']; size: 'working' | 'proxy' }
export const PRESETS: ExportPreset[] = [
  { name: 'HAP', desc: 'VJ playback', format: 'hap', size: 'working' },
  { name: 'H.264', desc: 'delivery: share / review', format: 'mp4-h264', size: 'working' },
  { name: 'ProRes master', desc: '422 HQ · editing / reference', format: 'prores-422hq', size: 'working' },
  { name: 'HAP Q', desc: 'High quality', format: 'hapq', size: 'working' },
  { name: 'Proxy', desc: 'delivery: fast review', format: 'mp4-h264', size: 'proxy' },
  { name: 'Stills', desc: 'PNG sequence', format: 'png-seq', size: 'working' },
];
/** Codec presets retain the project aspect; proxy caps the long edge at 960 without upscaling. */
export function resolveExportPreset(p: ExportPreset, working: { w: number; h: number }) {
  const scale = p.size === 'proxy' ? Math.min(1, 960 / Math.max(working.w, working.h)) : 1;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { format: p.format, width: p.size === 'proxy' ? even(working.w * scale) : working.w, height: p.size === 'proxy' ? even(working.h * scale) : working.h };
}
export function exportPresetMatches(p: ExportPreset, ec: ExportConfig, working: { w: number; h: number }) {
  const resolved = resolveExportPreset(p, working);
  return ec.format === resolved.format && ec.width === resolved.width && ec.height === resolved.height;
}
export function exportPresetDescription(p: ExportPreset, working: { w: number; h: number }) {
  const r = resolveExportPreset(p, working);
  return `${r.width}×${r.height} · ${p.desc}`;
}
export const formatLabel = (f: ExportConfig['format']) => FORMATS.find((x) => x.id === f)?.label ?? f;

export interface Job {
  id: string;
  name: string;
  config: ExportConfig;
  outPath: string;
  status: 'queued' | 'rendering' | 'done' | 'failed' | 'cancelled';
  fraction: number;
  log: NonNullable<RenderProgress['log']>[];
  error?: MoshpitErrorJSON;
  /** Before the encode: its clips' full-quality masters still conforming (RenderProgress.conform). */
  conform?: { fraction: number; clips: number };
  /** A quick render: played in the preview overlay as soon as it is written. */
  quick?: boolean;
  /** Pinned when requested, before folder IO or any earlier job finishes. */
  doc?: ProjectDoc;
  capturedAt?: number;
  previewScope?: string;
}

export const renderStore = createStore<Job[]>([]);

/** Proxy-first: the engine holds an export until its clips' masters exist, and reports their progress. */
export const waitingOnConform = (j: Job) => j.status === 'rendering' && j.fraction === 0 && !!j.conform && j.conform.clips > 0;
/**
 * A render runs in stages, and the stage is the primary feedback (an empty bar read as "stuck"):
 * prepare (nothing measurable yet) → conform (its clips' masters, measured) → encode (measured) →
 * finalize (muxing and the write, not measurable). `fraction` is null where there is no honest number.
 */
export type RenderStage = 'prepare' | 'conform' | 'encode' | 'finalize';
export const STAGES: { id: RenderStage; label: string }[] = [
  { id: 'prepare', label: 'Prepare' },
  { id: 'conform', label: 'Conform' },
  { id: 'encode', label: 'Encode' },
  { id: 'finalize', label: 'Finalize' },
];
export function stageOf(j: Job): { stage: RenderStage; fraction: number | null } {
  if (waitingOnConform(j)) return { stage: 'conform', fraction: j.conform!.fraction };
  if (j.fraction >= 1) return { stage: 'finalize', fraction: null };
  if (j.fraction > 0) return { stage: 'encode', fraction: j.fraction };
  return { stage: 'prepare', fraction: null };
}
/** What a progress bar shows: the current stage's measured fraction (0 when it has none: the bar stripes then). */
export const shownFraction = (j: Job) => stageOf(j).fraction ?? 0;
export const progressLabel = (j: Job) => {
  const { stage, fraction } = stageOf(j);
  const name = STAGES.find((s) => s.id === stage)!.label;
  const extra = stage === 'conform' ? ` · ${j.conform!.clips} clip${j.conform!.clips > 1 ? 's' : ''}` : '';
  return fraction == null ? `${name}…` : `${name} ${Math.round(fraction * 100)}%${extra}`;
};
export const useJobs = () => useStore(renderStore, (s) => s);
/** F5: committed renders only; the transient quick preview is never listed with them. */
export function useRenders() {
  const js = useJobs();
  return useMemo(() => js.filter((j) => !j.quick), [js]);
}
const tasks = new Map<string, Task<void>>();
let running = false;

const patch = (id: string, p: Partial<Job> | ((j: Job) => Partial<Job>)) =>
  renderStore.set((js) => js.map((j) => (j.id === id ? { ...j, ...(typeof p === 'function' ? p(j) : p) } : j)));

let enqueueTail = Promise.resolve();
let jobSequence = 0;
export function addJob(name: string, config: ExportConfig, outDir: string, opts: { quick?: boolean; doc?: ProjectDoc; previewScope?: string } = {}) {
  const doc = opts.doc ?? getDoc();
  const capturedAt = Date.now();
  const snapshot = structuredClone(config);
  // Serialize filename allocation: two rapid clicks must never reserve the same output.
  const queued = enqueueTail.catch(() => {}).then(() => enqueue(name, snapshot, outDir, { ...opts, doc, capturedAt }));
  enqueueTail = queued;
  return queued;
}

async function enqueue(name: string, config: ExportConfig, outDir: string, opts: { quick?: boolean; doc: ProjectDoc; capturedAt: number; previewScope?: string }) {
  const ext = FORMATS.find((f) => f.id === config.format)?.ext ?? 'mov';
  const id = `job-${Date.now().toString(36)}-${++jobSequence}`;
  // safeFileName (Phase 0.4): a typed name cannot leave the folder (`..\`, separators, reserved characters).
  let outPath = `${outDir.replace(/[\\/]+$/, '')}\\${safeFileName(name)}.${ext}`;
  if (host.files) {
    try {
      // The engine refuses to overwrite (EXPORT_EXISTS): create the folder, take the next free _vNN.
      await host.files.ensureDir(outDir);
      const taken = renderStore.get().filter((j) => j.status === 'queued' || j.status === 'rendering').map((j) => j.outPath);
      outPath = await host.files.nextFree(outPath, taken);
    } catch (e) {
      return toastError(e);
    }
  }
  const job: Job = { id, name: outPath.replace(/^.*[\\/]/, ''), config, outPath, status: 'queued', fraction: 0, log: [], quick: opts.quick, doc: opts.doc, capturedAt: opts.capturedAt, previewScope: opts.previewScope };
  // Keep quick job progress separate from committed exports; completed files live in the shelf.
  renderStore.set((js) => [...(opts.quick ? js.filter((j) => !j.quick || j.status === 'rendering' || j.status === 'queued') : js), job]);
  if (!opts.quick) {
    setUi({ renderJob: id });
    // Queue = render: a job used to sit at "queued" (an empty bar) until a separate Run all.
    toast(`Rendering ${job.name}`, { kind: 'ok' });
  }
  void runAll();
}

/**
 * Render the timeline with the project's export settings: the Render button and the CT's
 * render.start (M4) both land here. `name` and `dir` default as the export form shows them.
 */
export function queueRender(name?: string, dir?: string) {
  const d = getDoc();
  if (!timelineFrames(d.timeline.blocks)) return toast('The timeline is empty: add a slice first', { kind: 'warn' });
  const ec = d.exportConfig;
  const out = dir ?? (ec.outDir || settingsStore.get().paths.output);
  if (!out?.trim()) return toast('Choose an output folder in OUT before rendering', { kind: 'warn' });
  return addJob(name ?? `${d.name.replace(/\s+/g, '_')}_${ec.format}_${ec.width}x${ec.height}`, { ...ec, outDir: out }, out);
}

export async function runAll() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = renderStore.get().find((j) => j.status === 'queued');
      if (!next) break;
      patch(next.id, { status: 'rendering', fraction: 0, log: [], error: undefined, conform: undefined });
      if (!next.quick) setUi({ renderJob: next.id });
      try {
        const t = engine.render({ id: next.id, name: next.name, config: next.config, outPath: next.outPath, doc: next.doc }, (p) =>
          patch(next.id, (j) => ({ fraction: p.fraction, conform: p.conform ?? j.conform, log: p.log ? [...j.log, p.log] : j.log })),
        );
        tasks.set(next.id, t);
        await t.promise;
        if (userCancelled.delete(next.id)) { patch(next.id, { status: 'cancelled' }); continue; }
        patch(next.id, { status: 'done', fraction: 1, doc: undefined });
        if (next.quick) await rememberPreview({ id: next.id, path: next.outPath, label: next.name, projectId: next.doc?.id ?? '', createdAt: next.capturedAt ?? Date.now(), scope: next.previewScope ?? 'Timeline' },
          renderStore.get().filter(j => j.status === 'queued' || j.status === 'rendering').map(j => j.outPath)).catch(toastError);
      } catch (e) {
        // A cancel comes back from the real worker as INTERNAL wrapping the abort: trust who asked.
        if (userCancelled.delete(next.id) || (e as Error)?.name === 'AbortError') {
          patch(next.id, { status: 'cancelled' });
        } else {
          const err = asError(e).toJSON();
          // Contextual, not global: the job row carries the error and its fix, with Retry beside it.
          patch(next.id, (j) => ({ status: 'failed', error: err, log: [...j.log, { level: 'warn', text: `✕ ${err.humanMessage}` }] }));
        }
      } finally {
        tasks.delete(next.id);
      }
    }
  } finally {
    running = false;
  }
}

const userCancelled = new Set<string>();
export function cancelJob(id: string) {
  const t = tasks.get(id);
  if (t) (userCancelled.add(id), t.cancel());
  else patch(id, { status: 'cancelled' });
}
const retrying = new Set<string>();
// A cancelled/failed encode may already have written its output. Reserve a free filename through
// the same serialized lane as new jobs, retaining this job's original project and settings.
export function retryJob(id: string): Promise<void> {
  const job = renderStore.get().find(j => j.id === id);
  if (!job || (job.status !== 'failed' && job.status !== 'cancelled') || retrying.has(id)) return Promise.resolve();
  retrying.add(id);
  const queued = enqueueTail.catch(() => {}).then(async () => {
    if (renderStore.get().find(j => j.id === id) !== job) return;
    const taken = renderStore.get().filter(j => j.status === 'queued' || j.status === 'rendering').map(j => j.outPath);
    const outPath = host.files ? await host.files.nextFree(job.outPath, taken) : job.outPath;
    // Clear done, a replacement quick capture, or cancellation may have removed/changed this row.
    if (renderStore.get().find(j => j.id === id) !== job) return;
    patch(id, { outPath, name: outPath.replace(/^.*[\\/]/, ''), status: 'queued', fraction: 0, error: undefined });
    void runAll();
  }).catch(e => { toastError(e); }).finally(() => { retrying.delete(id); });
  enqueueTail = queued;
  return queued;
}
export const clearDone = () => renderStore.set((js) => js.filter((j) => j.status !== 'done' && j.status !== 'cancelled'));
