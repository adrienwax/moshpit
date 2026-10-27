// The real EngineClient (engine lane): talks to the crash-isolated render worker over a
// MessagePort that main wires straight to this window (app/electron/engine-host.ts). The preload
// relays the port into this world as a 'moshpit-engine-port' window message.
//
// Crash isolation: if the worker dies, main starts a new one and sends a new port. Pending calls
// reject with WORKER_CRASHED, onError listeners hear it, and the last project snapshot is re-sent
// so the next frame request just works.
import { MoshpitError, type MoshpitErrorJSON, type NodeDef, type ProjectDoc } from '@moshpit/engine';
import type { ConformUpdate, EngineClient, FrameResult, Task, Telemetry } from './EngineClient';

type Pending = { resolve: (v: any) => void; reject: (e: unknown) => void; progress?: (p: any) => void };

export function createWorkerEngine(): EngineClient {
  let port: MessagePort | null = null;
  let nextId = 1;
  let lastDoc: ProjectDoc | null = null;
  const pending = new Map<number, Pending>();
  const errorListeners = new Set<(e: MoshpitErrorJSON) => void>();
  const conformListeners = new Set<(u: ConformUpdate) => void>();
  const telemetryListeners = new Set<(t: Telemetry) => void>();
  const restartListeners = new Set<() => void>();
  let restarting = false;
  const waiters: (() => void)[] = [];

  const crashed = (details: { reason?: unknown; exitCode?: unknown; cause?: unknown }): MoshpitErrorJSON => new MoshpitError('WORKER_CRASHED', {
    reason: String(details.reason),
    ...(typeof details.exitCode === 'number' && Number.isFinite(details.exitCode) ? { exitCode: details.exitCode } : {}),
    ...(typeof details.cause === 'string' ? { cause: details.cause } : {}),
  }).toJSON();

  window.addEventListener('message', (ev) => {
    if (ev.data !== 'moshpit-engine-port' || !ev.ports[0]) return;
    port = ev.ports[0];
    port.onmessage = (m: MessageEvent) => {
      const d = m.data;
      if (d.event === 'conform') { for (const fn of conformListeners) fn(d.value); return; }
      if (d.event === 'telemetry') { for (const fn of telemetryListeners) fn(d.value); return; }
      const p = pending.get(d.id);
      if (!p) return;
      if (d.progress !== undefined) { p.progress?.(d.progress); return; }
      pending.delete(d.id);
      if (d.ok) p.resolve(d.value); else p.reject(d.error);
    };
    port.start();
    if (lastDoc) port.postMessage({ id: 0, method: 'updateProject', args: [lastDoc] });
    while (waiters.length) waiters.shift()!();
    if (restarting) { restarting = false; for (const fn of restartListeners) fn(); }
  });
  window.addEventListener('message', (ev) => {
    if (ev.data?.type !== 'moshpit-engine-crashed') return;
    const err = crashed(ev.data);
    restarting = true;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    port = null;
    for (const fn of errorListeners) fn(err);
  });

  function call<T>(method: string, args: unknown[], progress?: (p: any) => void, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let id: number | undefined, requestPort: MessagePort | null = null, settled = false;
      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
        const at = waiters.indexOf(send);
        if (at >= 0) waiters.splice(at, 1);
        if (id !== undefined) pending.delete(id);
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const abort = () => {
        // Cancel on the original port only; a replacement worker must not receive old ids.
        if (id !== undefined && pending.has(id)) {
          try {
            requestPort?.postMessage({ id, cancel: true });
            // Export owns files/encoders. Its queue must await the worker's cleanup
            // acknowledgement before offering Retry or starting the next job.
            if (method === 'render') return;
          } catch { /* a closed port cannot receive cancellation */ }
        }
        finish(() => reject(new DOMException('cancelled', 'AbortError')));
      };
      const send = () => {
        if (settled) return;
        if (signal?.aborted) return abort();
        if (!port) { waiters.push(send); return; }
        id = nextId++;
        requestPort = port;
        pending.set(id, { resolve: v => finish(() => signal?.aborted ? reject(new DOMException('cancelled', 'AbortError')) : resolve(v)), reject: e => finish(() => reject(e)), progress });
        try { requestPort.postMessage({ id, method, args }); }
        catch (e) { finish(() => reject(e)); }
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else queueMicrotask(send);
    });
  }
  function task<T>(method: string, args: unknown[], progress?: (p: any) => void): Task<T> {
    const ac = new AbortController();
    return { promise: call<T>(method, args, progress, ac.signal), cancel: () => ac.abort() };
  }

  const client: EngineClient = {
    nodeDefs: () => call<NodeDef[]>('nodeDefs', []),
    updateProject(doc) { lastDoc = doc; if (port) port.postMessage({ id: 0, method: 'updateProject', args: [doc] }); },
    // R-1: a drag tick posts the edit, never the whole project (lastDoc still re-syncs a restarted worker).
    setParam(doc, blockId, nodeId, key, value) { lastDoc = doc; if (port) port.postMessage({ id: 0, method: 'setParam', args: [blockId, nodeId, key, value] }); },
    libraryFolders: () => call('libraryFolders', []),
    libraryClips: (folder) => call('libraryClips', [folder]),
    listDir: (dir) => call('listDir', [dir]),
    setLibraryRoots: (roots) => call('setLibraryRoots', [roots]),
    // UI lane: the worker's existing setRating / setTags routes (INTERFACES.md).
    setRating: (path, n) => call('setRating', [path, n]),
    setTags: (path, tags) => call('setTags', [path, tags]),
    importClip: (path, onProgress, opts) => task('importClip', [path, opts ?? {}], onProgress),
    onConformUpdate(fn) { conformListeners.add(fn); return () => conformListeners.delete(fn); },
    conformStates: () => call<ConformUpdate[]>('conformStates', []),
    onTelemetry(fn) { telemetryListeners.add(fn); return () => telemetryListeners.delete(fn); },
    onRestart(fn) { restartListeners.add(fn); return () => { restartListeners.delete(fn); }; },
    detectCuts: (sourceId, sensitivity) => task('detectCuts', [sourceId, sensitivity]),
    async frame(target, size, signal): Promise<FrameResult> {
      const r = await call<{ w: number; h: number; data: ArrayBuffer; state: FrameResult['state']; route: string; freeze?: FrameResult['freeze'] }>('frame', [target, size], undefined, signal);
      // The worker already fitted it to `size` (Phase 0.1a); resample here only if it could not.
      const data = new ImageData(new Uint8ClampedArray(r.data), r.w, r.h);
      const image = await (r.w === size.w && r.h === size.h ? createImageBitmap(data) : createImageBitmap(data, { resizeWidth: size.w, resizeHeight: size.h, resizeQuality: 'medium' }));
      return { image, state: r.state, route: r.route, ...(r.freeze ? { freeze: r.freeze } : {}) };
    },
    async audioPeaks(sourceId, buckets) { return new Float32Array(await call<ArrayBuffer>('audioPeaks', [sourceId, buckets])); },
    previewInfo: (path) => call('previewInfo', [path]),
    async previewFrame(path, timeSec, req) {
      const r = await call<{ w: number; h: number; data: ArrayBuffer; time: number; exact: boolean } | null>('previewFrame', [path, timeSec, req]);
      if (!r) return null; // a newer request for this file superseded it
      const image = await createImageBitmap(new ImageData(new Uint8ClampedArray(r.data), r.w, r.h));
      return { image, time: r.time, exact: r.exact };
    },
    async filmstrip(path, opts) {
      const s = await call<{ durationSec: number; width: number; cells: { time: number; jpeg: ArrayBuffer }[] }>('filmstrip', [path, opts ?? {}]);
      return { ...s, cells: s.cells.map((c) => ({ time: c.time, jpeg: new Uint8Array(c.jpeg) })) };
    },
    // Through the engine queue, never beside a frame rendering on that slot.
    releaseTrials(role) { void call('releaseTrials', [role]).catch(() => {}); },
    closePreview(path) { if (port) port.postMessage({ id: 0, method: 'closePreview', args: [path] }); },
    freeze: (target, range) => task('freeze', [target, range]),
    render: (job, onProgress) => task('render', [job], onProgress),
    // UI lane: adopts the worker's existing verifyConforms route (INTERFACES.md, D7).
    verifyConforms: (onProgress) => task('verifyConforms', [], onProgress),
    onError(fn) { errorListeners.add(fn); return () => errorListeners.delete(fn); },
    // Phase 0.1b: the worker's queue probe (e2e only; skips the queue).
    queueProbe: (op: 'reset' | 'read') => call('queueProbe', [op]),
  };
  // The app's own page: exposing the client lets the e2e harness drive the real engine directly.
  (window as { __moshpitEngine?: EngineClient }).__moshpitEngine = client;
  return client;
}
