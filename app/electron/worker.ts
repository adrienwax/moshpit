// The render worker (engine lane): a hidden renderer that owns the engine. It talks to the UI
// over a MessagePort that main wires directly between the two windows, so frames never pass
// through main. Every failure goes back as a MoshpitError's JSON (L26), never a raw stack.
//
// Protocol (UI → worker):  { id, method, args }         { id, cancel: true }
//           (worker → UI):  { id, ok: true, value }     { id, ok: false, error }   { id, progress }
//                           { event: 'conform', value: ConformUpdate }   (proxy-first masters, unprompted)

import { ipcRenderer } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EngineService } from '../../engine/src/service/service';
import { isUnder } from '../../engine/src/library/index';
import { asMoshpitError, MoshpitError } from '../../engine/src/errors';
import { remoteJobs } from '../../engine/src/jobs/runner';
import { FrameCost, dirBytes, sampleGpu } from '../../engine/src/telemetry/system';
import { capFreezes } from './engine-cache';
import { TEST_CLIPS_DIR } from '../src/lib/testClips';
import { liveBackends, onGpuContextLost } from '../../engine/src/gpu/backend';
import { previewTiming } from '../../engine/src/telemetry/previewTiming';

// Phase 0.3: a lost WebGL context (driver reset) never renders again: ask main for a fresh worker.
onGpuContextLost(() => ipcRenderer.send('engine:gpu-lost'));
// Test hook (MOSHPIT_TEST): lose the newest backend's context, as a driver reset would.
if (process.env.MOSHPIT_TEST) {
  Object.assign(window, {
    __moshpitLoseGpu: () => {
      const b = [...liveBackends].at(-1);
      b?.gl.getExtension('WEBGL_lose_context')?.loseContext();
      return liveBackends.size + (b ? 1 : 0);
    },
  });
}

const cacheDir = new URLSearchParams(location.search).get('cache') ?? path.join(os.tmpdir(), 'moshpit-cache');
// MOSHPIT_LIBRARY (tests) wins; then Settings → Media root (UI lane, via the page query); then ~/Videos.
const envRoots = process.env.MOSHPIT_LIBRARY?.split(path.delimiter);
const settingsRoots = (new URLSearchParams(location.search).get('library') ?? '').split(';');
const roots = (envRoots ?? settingsRoots).map((r) => r.trim()).filter(Boolean);
/** The test clips folder joins the roots when it exists and no root already holds it (the "test clips" favourite browses it). */
const withTestClips = (r: string[]) => {
  const t = process.env.MOSHPIT_TEST_CLIPS ?? TEST_CLIPS_DIR;
  return t && fs.existsSync(t) && !r.some((x) => isUnder(t, x)) ? [...r, t] : r;
};
// A-3: the long jobs run in main's job process (jobs-process.ts), reached over a port main wires.
// Calls made before a port arrives (at boot, or after a job-process crash) wait for it.
let jobsPort: MessagePort | null = null;
const jobsBacklog: unknown[] = [];
const jobsClient = remoteJobs((m) => (jobsPort ? jobsPort.postMessage(m) : jobsBacklog.push(m)));
ipcRenderer.on('jobs:port', (e) => {
  jobsPort = e.ports[0];
  jobsPort.onmessage = (ev) => jobsClient.receive(ev.data);
  jobsPort.start();
  for (const m of jobsBacklog.splice(0)) jobsPort.postMessage(m);
});
ipcRenderer.on('jobs:gone', () => {
  jobsPort?.close();
  jobsPort = null;
  jobsClient.fail(new MoshpitError('JOB_PROCESS_CRASHED'));
});
const service = new EngineService({ cacheDir, libraryRoots: withTestClips(roots.length ? roots : [path.join(os.homedir(), 'Videos')]), jobs: jobsClient.runner });
const inflight = new Map<number, AbortController>();
// Cancelled while still queued: skipped when their turn comes. A frame the UI no longer shows (a
// scrub moved on, a thumbnail remounted at a new zoom) used to render anyway and delay the live ones.
const cancelled = new Set<number>();
let port: MessagePort | null = null;

type Msg = { id: number; method?: string; args?: unknown[]; cancel?: boolean };

// Phase 0.1b stage 1: the queue probe. Every request's wait (received → started) and run time, and
// the worker thread's own event-loop lag (a 20 ms tick that fires late when something blocks it).
// Read and reset with the 'queueProbe' method, which skips the queue.
const probe = { received: new Map<number, number>(), started: new Map<number, number>(), done: [] as { method: string; waitMs: number; runMs: number }[], lags: [] as number[] };
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  probe.lags.push(Math.max(0, now - lastTick - 20));
  if (probe.lags.length > 20000) probe.lags.shift();
  lastTick = now;
}, 20);
function queueProbe(op: 'reset' | 'read') {
  if (op === 'reset') return void ((probe.done = []), (probe.lags = []));
  const lags = [...probe.lags].sort((a, b) => a - b);
  return { done: probe.done, lagMax: lags.at(-1) ?? 0, lagP95: lags[Math.floor(lags.length * 0.95)] ?? 0, blocked100: lags.filter((x) => x > 100).length, ticks: lags.length };
}

async function handle(m: Msg): Promise<void> {
  const p = port!;
  if (m.cancel) { const ac = inflight.get(m.id); if (ac) { if (ac.signal.reason === BACKGROUND_PREEMPTED) cancelled.add(m.id); ac.abort(); } else cancelled.add(m.id); return; }
  if (cancelled.delete(m.id)) { p.postMessage({ id: m.id, ok: false, error: asMoshpitError(new DOMException('superseded', 'AbortError'), { method: m.method }).toJSON() }); return; }
  const ac = new AbortController();
  inflight.set(m.id, ac);
  const t0 = performance.now();
  probe.started.set(m.id, t0);
  const progress = (value: unknown) => p.postMessage({ id: m.id, progress: value });
  const args = m.args ?? [];
  let deferred = false;
  try {
    let value: unknown;
    switch (m.method) {
      case 'nodeDefs': value = service.nodeDefs(); break;
      case 'setParam': service.setParam(args[0] as never, args[1] as never, args[2] as string, args[3] as never); value = null; break;
      case 'updateProject': service.updateProject(args[0] as never); lastFreezeKeys = new Set(((args[0] as { freezes?: { key: string }[] }).freezes ?? []).map((f) => f.key)); value = null; break;
      // args[1]: { quality?, proxyFirst? } — the conform preset picked in Import / conform.
      case 'importClip': value = await service.importClip(args[0] as string, progress, ac.signal, (args[1] ?? {}) as never); break;
      case 'conformStates': value = service.conformStates(); break;
      case 'detectCuts': value = await service.detectCuts(args[0] as never, args[1] as number, ac.signal); break;
      case 'verifyConforms': value = await service.verifyConforms(progress, ac.signal); break;
      case 'frame': {
        const t0 = performance.now();
        const f = await fitFrame(await service.frame(args[0] as never, args[1] as never, ac.signal), args[1] as { w: number; h: number });
        ac.signal.throwIfAborted();
        frameCost.add(performance.now() - t0);
        previewTiming({ ev: 'worker.frame', id: m.id, frame: (args[0] as { frame?: number }).frame, req: `${(args[1] as { w: number }).w}x${(args[1] as { h: number }).h}`, quality: (args[1] as { quality?: string }).quality ?? 'auto', waitMs: Math.round(t0 - (probe.received.get(m.id) ?? t0)), runMs: Math.round(performance.now() - t0) });
        p.postMessage({ id: m.id, ok: true, value: { ...f, data: f.data.buffer } }, [f.data.buffer]);
        return;
      }
      case 'audioPeaks': { const a = await service.audioPeaks(args[0] as never, args[1] as number); p.postMessage({ id: m.id, ok: true, value: a.buffer }, [a.buffer]); return; }
      case 'freeze': trimFreezes(); value = await service.freeze(args[0] as never, args[1] as never); break;
      case 'render': value = await service.render(args[0] as never, progress, ac.signal); break;
      case 'libraryFolders': value = await service.libraryFolders(); break;
      // E14: Settings → Media root applied live. Empty falls back to ~/Videos, as at boot.
      case 'setLibraryRoots': { const r = (args[0] as string[]).map((x) => x.trim()).filter(Boolean); value = await service.setLibraryRoots(withTestClips(r.length ? r : [path.join(os.homedir(), 'Videos')])); break; }
      case 'libraryClips': value = await service.libraryClips(args[0] as string); break;
      case 'listDir': value = await service.listDir(args[0] as string); break;
      // Raw-file preview for the Source browser (PREVIEW-API.md): no conform, approximate, disposable.
      case 'previewInfo': value = await service.previewInfo(args[0] as string); break;
      case 'previewFrame': {
        const f = await service.previewFrame(args[0] as string, args[1] as number, args[2] as never);
        if (!f) { value = null; break; }
        // Transfer a copy: the service keeps this frame in its cache and serves the same object again,
        // so moving its own buffer would leave the cache holding a detached one.
        const data = f.data.slice().buffer;
        p.postMessage({ id: m.id, ok: true, value: { ...f, data } }, [data]);
        return;
      }
      case 'filmstrip': {
        const s = await service.filmstrip(args[0] as string, (args[1] ?? {}) as never);
        const cells = s.cells.map((c) => ({ time: c.time, jpeg: c.jpeg.buffer.slice(c.jpeg.byteOffset, c.jpeg.byteOffset + c.jpeg.byteLength) }));
        p.postMessage({ id: m.id, ok: true, value: { ...s, cells } }, cells.map((c) => c.jpeg));
        return;
      }
      case 'closePreview': service.closePreview(args[0] as string); value = null; break;
      case 'releaseTrials': service.releaseTrials(args[0] as 'audition' | 'thumb'); value = null; break;
      case 'setRating': service.setRating(args[0] as string, args[1] as number); value = null; break;
      case 'setTags': service.setTags(args[0] as string, args[1] as string[]); value = null; break;
      default: throw new Error(`unknown method ${m.method}`);
    }
    p.postMessage({ id: m.id, ok: true, value });
  } catch (e) {
    if (ac.signal.reason === BACKGROUND_PREEMPTED && !cancelled.delete(m.id)) {
      // Keep the same caller/promise; resume only after foreground work and cleanup finish.
      deferred = true; low.unshift(m);
      previewTiming({ ev: 'worker.background-preempt', id: m.id });
    } else p.postMessage({ id: m.id, ok: false, error: asMoshpitError(e, { method: m.method }).toJSON() });
  } finally {
    inflight.delete(m.id);
    const rec = probe.received.get(m.id);
    if (!deferred) probe.received.delete(m.id);
    probe.started.delete(m.id);
    if (rec !== undefined && m.method) probe.done.push({ method: m.method, waitMs: Math.round(t0 - rec), runMs: Math.round(performance.now() - t0) });
    if (probe.done.length > 5000) probe.done.shift();
  }
}

// Requests are served one at a time: the engine owns one GPU context and one decoder per slot.
const PREVIEW = new Set(['previewInfo', 'previewFrame', 'filmstrip', 'closePreview']);
let queue: Promise<void> = Promise.resolve();
let waiting = 0;
// Audit S4: when nothing is waiting, the service fills the scrub cache a chunk at a time. Chunks go
// through the same queue as requests (the engine is not re-entrant), so a request waits at most one chunk.
let idling = false;
let idleAbort: AbortController | null = null;
// Phase 2.3: the fill starts once the viewers have been quiet this long. Started at once, every
// scrub step and the frame after it queued behind a fill chunk, which re-decodes from the
// keyframe: a repeat of the frame just shown took 400 ms instead of a cache read (measured).
const IDLE_AFTER_MS = 250;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { idleTimer = null; kickIdle(); }, IDLE_AFTER_MS);
}
function kickIdle(): void {
  if (waiting > 0 || idling) return;
  idling = true;
  queue = queue.then(async () => {
    let more = false;
    try {
      if (waiting === 0 && !low.length) {
        idleAbort = new AbortController();
        more = await service.idle(12, idleAbort.signal).catch(() => false);
      }
    } finally { idleAbort = null; idling = false; }
    // Previews waiting go before the next fill chunk (each chunk re-decodes from the keyframe,
    // ~0.5 s at 1080p): pumpLow resumes the fill once they are drawn.
    if (low.length) pumpLow();
    else if (more) setTimeout(kickIdle, 0);
  });
}
// HUD telemetry: sampled every 2 s, cache size every 15 s (a disk walk), pushed only when changed.
const frameCost = new FrameCost();
let cacheBytes: number | null = null;
let lastTelemetry = '';
const sampleCache = () => (trimFreezes(), dirBytes(cacheDir).then((b) => (cacheBytes = b), () => {}));
// The freeze cache is capped (default 20 GB, MOSHPIT_FREEZE_CAP_GB): oldest first, never one the open project uses.
let lastFreezeKeys = new Set<string>();
const FREEZE_CAP = Number(process.env.MOSHPIT_FREEZE_CAP_GB || 20) * 2 ** 30;
function trimFreezes() {
  const r = capFreezes(path.join(cacheDir, 'engine', 'freeze'), FREEZE_CAP, lastFreezeKeys);
  if (r.files) console.log(`freeze cache over its cap: removed ${r.files} old freeze(s), ${(r.bytes / 2 ** 30).toFixed(2)} GB`);
}
void sampleCache();
setInterval(() => void sampleCache(), 15000);
setInterval(async () => {
  if (!port) return;
  const gpu = await sampleGpu();
  const value = { gpu, frameMs: frameCost.avgMs, framesServed: frameCost.count, cacheBytes };
  const key = JSON.stringify(value);
  if (key === lastTelemetry) return;
  lastTelemetry = key;
  port.postMessage({ event: 'telemetry', value });
}, 2000);

// Proxy-first masters report on their own schedule; forward each update to whichever UI port is live.
service.onConformUpdate((u) => port?.postMessage({ event: 'conform', value: u }));

function enqueue(m: Msg): void {
  // Cache warming must yield its shared decoder before the next interactive operation.
  // Aborting does not run requests in parallel: they still await idle's cleanup on this queue.
  idleAbort?.abort();
  if (activeLow !== null) inflight.get(activeLow)?.abort(BACKGROUND_PREEMPTED);
  waiting++;
  queue = queue.then(() => handle(m)).finally(() => { if (--waiting === 0) (pumpLow(), scheduleIdle()); });
}

/**
 * Phase 2.5: the effect browser's previews (thumbnail-size trial frames) wait for everything else.
 * In the one queue, the Program's audition frame waited behind a dozen of them: 1.6–1.7 s to show
 * (measured). They take a turn only when nothing else is waiting, one at a time; a cancelled one
 * is skipped when its turn comes (handle's `cancelled` check).
 */
const low: Msg[] = [];
let lowBusy = false;
let activeLow: number | null = null;
const BACKGROUND_PREEMPTED = Symbol('foreground preview arrived');
const isPreview = (m: Msg) => {
  const size = m.args?.[1] as { w?: number; priority?: 'foreground' | 'background' } | undefined;
  return m.method === 'frame' && (size?.priority === 'background' ||
    (!size?.priority && (m.args?.[0] as { kind?: string })?.kind === 'trial' && (size?.w ?? 0) < 480));
};
function pumpLow(): void {
  if (waiting > 0 || lowBusy || !low.length) return;
  lowBusy = true;
  const m = low.shift()!;
  queue = queue.then(async () => {
    // A foreground request can arrive before this queued callback starts.
    if (waiting > 0) { low.unshift(m); return; }
    activeLow = m.id;
    try { await handle(m); } finally { activeLow = null; }
  }).finally(() => { lowBusy = false; pumpLow(); if (!low.length && waiting === 0) scheduleIdle(); });
}

/**
 * Phase 0.1b, the job lane. Long jobs that never touch the engine's shared slots (ffmpeg work:
 * import, the conform check, cut detection, audio peaks; and the export, which builds its own
 * export-role engine) run one at a time here, beside the engine queue, so frames no longer wait
 * for them: a frame used to wait out a whole 30 s export. Each job first waits for everything
 * sent before it on the engine queue, so it sees the project those messages built.
 * Freeze stays on the engine queue: it renders on the same timeline slot that serves frames.
 */
// Audio peaks stay on the engine queue: alone it takes 0.6 s, but beside a scrub its ffmpeg pipe
// (64 KB at a time) waited on every frame render and the job crawled to 7.6 s (measured). A frame
// waiting 0.6 s once is the better trade.
const JOB_LANE = new Set(['importClip', 'verifyConforms', 'detectCuts']);
let jobs: Promise<void> = Promise.resolve();
function enqueueJob(m: Msg, run: () => Promise<void> = () => handle(m)): void {
  const before = queue.catch(() => {});
  jobs = jobs.then(async () => { await before; await run(); }).catch(() => {});
}

async function beforeRender(m: Msg): Promise<void> {
  const p = port!;
  const ac = new AbortController();
  inflight.set(m.id, ac);
  try {
    // Everything sent before this render (the edit that put the block on the timeline included)
    // lands first, so the wait sees the doc the render will. Without it the check ran on the old
    // doc, found nothing to wait for, and the render's own wait blocked the queue at 0 %.
    await queue.catch(() => {});
    await service.awaitTimelineMasters((value) => p.postMessage({ id: m.id, progress: value }), ac.signal, (m.args?.[0] as { doc?: import('@moshpit/engine').ProjectDoc } | undefined)?.doc);
  } catch (e) {
    inflight.delete(m.id);
    p.postMessage({ id: m.id, ok: false, error: asMoshpitError(e, { method: m.method }).toJSON() });
    return;
  }
  inflight.delete(m.id);
  if (ac.signal.aborted) cancelled.add(m.id);
  // Phase 0.1b: the encode runs on the job lane (its own export engine), not the engine queue.
  enqueueJob(m);
}

/**
 * Phase 0.1a: frames leave the worker at the size the view asked for. The engine renders at the
 * working size (up to 1920×1080) and the UI thread used to resample every frame down to its view:
 * a param drag spent 1,035 ms of UI-thread time in createImageBitmap. Here it costs the worker, the
 * buffer crossing the port is the view's size, and the UI only copies it.
 */
async function fitFrame<F extends { w: number; h: number; data: Uint8Array }>(f: F, size: { w: number; h: number }): Promise<F> {
  if (!size || (f.w <= size.w && f.h <= size.h) || size.w < 1 || size.h < 1) return f;
  const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(f.data.buffer as ArrayBuffer, f.data.byteOffset, f.data.byteLength), f.w, f.h), { resizeWidth: size.w, resizeHeight: size.h, resizeQuality: 'medium' });
  const c = new OffscreenCanvas(size.w, size.h);
  const g = c.getContext('2d')!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return { ...f, w: size.w, h: size.h, data: new Uint8Array(g.getImageData(0, 0, size.w, size.h).data.buffer) };
}

ipcRenderer.on('engine:port', (e) => {
  port = e.ports[0];
  port.onmessage = (ev: MessageEvent<Msg>) => {
    if (ev.data.cancel) { void handle(ev.data); return; }
    if (ev.data.method === 'queueProbe') { port!.postMessage({ id: ev.data.id, ok: true, value: queueProbe(ev.data.args?.[0] as 'reset' | 'read') }); return; }
    probe.received.set(ev.data.id, performance.now());
    // Raw preview runs on Mediabunny's own decoders, never the Engine, so it skips the serial queue:
    // hover requests overlap, and the service's latest-request-wins can drop the stale ones.
    if (PREVIEW.has(ev.data.method ?? '')) { void handle(ev.data); return; }
    // A render first waits for its clips' full-quality masters, which can take minutes. That wait
    // runs here, outside the queue, reporting progress; only the encode itself takes a turn.
    if (ev.data.method === 'render') { void beforeRender(ev.data); return; }
    if (JOB_LANE.has(ev.data.method ?? '')) { enqueueJob(ev.data); return; }
    if (isPreview(ev.data)) { idleAbort?.abort(); low.push(ev.data); pumpLow(); return; }
    enqueue(ev.data);
  };
  port.start();
});
window.addEventListener('beforeunload', () => service.dispose());
