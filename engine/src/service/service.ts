// The engine as a service: everything the UI's EngineClient asks for, implemented over the real
// engine. Runs in the render worker (app/electron/worker.ts adapts it to a MessagePort) and in
// the harness directly, so the client contract is tested without any UI.
//
// L24: the UI owns the project document; the service compiles from the latest snapshot and never
// edits it. Live engine state (engines, decoders, checkpoints, freezes) lives here, outside React.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { MoshpitError } from '../errors';
import { validRange } from '../conform/range';
export { validRange };
import type {
  BlockId, Chapter, ConformedSource, FreezeId, FreezeRecord, FreezeTarget, NodeDef, NodeId, ProjectDoc,
  SourceClip, SourceId, SourceProbe, SourceRange,
} from '../model';
import { newId } from '../model';
import { NODE_DEFS } from '../nodes/defs';
import { CONTAINER_KIND, macroTarget } from '../graph/container';
import * as crypto from 'node:crypto';
import { conformDiverged, type ConformSettings } from '../conform/conform';
import { chaptersFromCuts } from '../conform/scenes';
import { localJobs, type JobRunner } from '../jobs/runner';
import { findFfmpeg } from '../conform/ffmpeg';
import { newBlock, newProject } from '../project/build';
import { Engine } from '../runtime/engine';
import { compileProject, engineOptions, type CompiledProject } from '../runtime/session';
import { assertNotSource, exportRange } from '../runtime/export';
import { LibraryIndex, isUnder } from '../library/index';
import type { ConformCheck, ConformUpdate, FrameTarget, RenderJob } from '../client';
import type { ConformQuality } from '@moshpit/core';
import { previewInfo, type PreviewInfo } from '../preview/probe';
import { PreviewSource, type FrameRequest, type PreviewFrame } from '../preview/source';
import { filmstrip, type Filmstrip, type FilmstripOptions } from '../preview/filmstrip';
import { previewTiming, previewTimingOn } from '../telemetry/previewTiming';

// One definition, the client contract's (it used to be copied here and could drift).
export type { FrameTarget } from '../client';

export interface FramePixels {
  w: number;
  h: number;
  /** RGBA8, a fresh buffer the caller may transfer. */
  data: Uint8Array;
  state: 'EXACT' | 'PROXY';
  route: string;
  freeze?: 'fresh' | 'stale';
}

export interface LibraryClip { path: string; name: string; probe: SourceProbe; rating: number; tags: string[]; pass: true | { code: string }; sourceId?: SourceId }
export interface LibraryFolder { path: string; name: string; count: number; children: LibraryFolder[] }
/** A folder on disk for navigation: its subfolders and its parent (null at a drive; '' lists the drives). */
export interface DirListing { path: string; parent: string | null; dirs: { name: string; path: string }[] }

interface Slot { key: string; identity: string; compiled: CompiledProject; engine: Engine; variant: 'master' | 'proxy' }

// A slot owns a WebGL context, decoder, checkpoints and frame cache. Keeping one forever for
// every selected node/source can exhaust Chromium's context limit during ordinary browsing.
// All slot users (frame/freeze/idle/project edits) run on the worker's serial engine queue;
// export uses its own Engine and does not participate in this cache.
const PREVIEW_SLOTS = 6;
const PREVIEW_FRAME_CACHE_BYTES = (768 << 20) / PREVIEW_SLOTS;
/** Program frames rendered ahead of a playback tick in one decode pass: 2 s at 60 fps. */
const READ_AHEAD = 120;

/** One background master encode (proxy-first import). */
interface MasterJob {
  sourceId: SourceId;
  file: string;
  settings: ConformSettings;
  rec: ConformedSource;
  state: 'PROXY_READY' | 'MASTERING' | 'READY' | 'FAILED';
  fraction: number;
  ready?: ConformedSource;
  error?: MoshpitError;
  done: Promise<ConformedSource>;
  settle: { resolve(r: ConformedSource): void; reject(e: unknown): void };
}


export interface ServiceOptions {
  cacheDir: string;
  ffmpeg?: string;
  libraryRoots?: string[];
  /** Budget for each preview engine. */
  budgetBytes?: number;
  /** Scrub cache per preview engine. Default 128 MiB (768 MiB across six retained slots). */
  frameCacheBytes?: number;
  /** A-3: where long jobs run. Default in process; the app passes its utilityProcess client. */
  jobs?: JobRunner;
}

export class EngineService {
  private doc: ProjectDoc | null = null;
  private version = 0;
  private slots = new Map<string, Slot>();
  /** The window the background fill works through: around the last frame a viewer asked for. */
  // Phase 2.3: forward first (play, the next frame, a 2 s audition loop), then back.
  private fillWin: { slot: string; ranges: [number, number][] } | null = null;
  private jobs: JobRunner;
  constructor(private o: ServiceOptions) {
    this.jobs = o.jobs ?? localJobs;
    fs.mkdirSync(o.cacheDir, { recursive: true });
  }

  nodeDefs(): NodeDef[] { return [...NODE_DEFS]; }

  /**
   * L24: the latest committed snapshot. Engines rebuild lazily on the next frame request. A
   * proxy-stage conform with no master job (a project saved mid-conform, then reopened) gets one.
   */
  updateProject(doc: ProjectDoc): void {
    if (this.doc && this.doc.id !== doc.id) this.releaseSlots();
    this.doc = doc;
    this.version++;
    for (const c of doc.resources.conforms) {
      if (c.status !== 'proxy' || this.masters.has(c.sourceId)) continue;
      const src = doc.resources.sources.find((x) => x.id === c.sourceId);
      if (src) this.enqueueMaster(src.id, src.path, this.settingsFor(c), c);
    }
  }

  /**
   * The param fast path (R-1): the worker gets the edit, not the project. No version bump, so no slot recompiles. Encoded-stream ops (their
   * params are compiled into the plan) and any engine that cannot take the patch fall back to a
   * full update. Source loupes never hold a block, so they are skipped.
   */
  setParam(blockId: BlockId, nodeId: NodeId, key: string, value: number | boolean | string): void {
    const doc = this.need();
    const node = doc.timeline.blocks.find((b) => b.id === blockId)?.graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new MoshpitError('PARAM_UNKNOWN', { blockId, nodeId, key });
    // Only the edited node is new; everything else is shared with the previous snapshot.
    const blocks = doc.timeline.blocks.map((b) => (b.id !== blockId ? b : { ...b, graph: { ...b.graph, nodes: b.graph.nodes.map((n) => (n.id !== nodeId ? n : { ...n, params: { ...n.params, [key]: value } })) } }));
    const next = { ...doc, timeline: { ...doc.timeline, blocks } };
    // 3.3: a container's macro reaches the engines as the inner param it drives (they hold inlined graphs).
    const hit = node.kind === CONTAINER_KIND ? (typeof value === 'number' ? macroTarget(node, key, value) : null) : { node: nodeId, param: key, value, kind: node.kind };
    if (!hit) throw new MoshpitError('PARAM_UNKNOWN', { blockId, nodeId, key });
    const def = NODE_DEFS.find((d) => d.kind === hit.kind);
    // Full path: encoded ops (params compiled into the plan) and history ops (their depth sizes the plan's VRAM estimate, R-2).
    if (!def || def.domain === 'ENCODED_STREAM' || def.temporal.mode === 'past-dependent') return this.updateProject(next);
    this.doc = next;
    try {
      for (const [name, s] of this.slots) if (!name.startsWith('source-')) s.engine.setParam(blockId, hit.node, hit.param, hit.value);
      this.fastParams++;
    } catch {
      this.version++; // an engine without the block: rebuild on the next frame, as a full update would
    }
  }
  /** Param edits applied without a recompile (the R-1 proof reads it). */
  fastParams = 0;

  // ── proxy-first import: the background master queue ──

  private masters = new Map<SourceId, MasterJob>();
  private queue: SourceId[] = [];
  private running: { id: SourceId; ac: AbortController } | null = null;
  private listeners = new Set<(u: ConformUpdate) => void>();

  onConformUpdate(fn: (u: ConformUpdate) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  conformStates(): ConformUpdate[] { return [...this.masters.values()].map((j) => this.update(j)); }

  private update(j: MasterJob): ConformUpdate {
    return { sourceId: j.sourceId, state: j.state, ...(j.state === 'MASTERING' ? { fraction: j.fraction } : {}), ...(j.ready ? { conform: j.ready } : {}), ...(j.error ? { error: j.error.toJSON() } : {}) };
  }

  private emit(j: MasterJob): void { const u = this.update(j); for (const f of this.listeners) f(u); }

  /** The settings a record was conformed with, so its master (or a re-check) matches its proxy. */
  private settingsFor(c: ConformedSource): ConformSettings {
    return { fps: c.fps, width: c.width, height: c.height, proxyDivisor: Math.round(c.width / (c.proxy?.width ?? c.width / 4)), crf: 15, quality: c.quality, ffmpeg: this.o.ffmpeg, range: c.range };
  }

  private enqueueMaster(sourceId: SourceId, file: string, settings: ConformSettings, rec: ConformedSource): MasterJob {
    let settle!: MasterJob['settle'];
    const done = new Promise<ConformedSource>((resolve, reject) => { settle = { resolve, reject }; });
    done.catch(() => { /* FAILED is reported as an update; waiters see the rejection */ });
    const j: MasterJob = { sourceId, file, settings, rec, state: 'PROXY_READY', fraction: 0, done, settle };
    this.masters.set(sourceId, j);
    this.queue.push(sourceId);
    this.emit(j);
    void this.pump();
    return j;
  }

  /** One master at a time: x264 already uses every core, two at once would only thrash. */
  private async pump(): Promise<void> {
    if (this.running) return;
    const id = this.queue.shift();
    if (!id) return;
    const j = this.masters.get(id)!;
    const ac = new AbortController();
    this.running = { id, ac };
    j.state = 'MASTERING'; j.fraction = 0; this.emit(j);
    let last = 0;
    try {
      const r = await this.jobs.conformMaster(j.rec, j.file, j.settings, path.join(this.o.cacheDir, 'conform'), true, {
        signal: ac.signal,
        onProgress: (f) => { j.fraction = f; if (f - last >= 0.01) { last = f; this.emit(j); } },
      });
      j.state = 'READY'; j.fraction = 1; j.ready = r.record;
      this.version++; // engines rebuild on the master at the next request
      this.emit(j);
      j.settle.resolve(r.record);
    } catch (e) {
      j.state = 'FAILED';
      j.error = e instanceof MoshpitError ? e : new MoshpitError('CONFORM_FAILED', { path: j.file }, e);
      this.emit(j);
      j.settle.reject(j.error);
    } finally {
      this.running = null;
      void this.pump();
    }
  }

  /** Masters not ready yet among these sources. */
  private pending(ids: Iterable<SourceId>): MasterJob[] {
    const out: MasterJob[] = [];
    for (const id of new Set(ids)) { const j = this.masters.get(id); if (j && j.state !== 'READY') out.push(j); }
    return out;
  }

  /** Wait for these masters, moving them to the front of the queue. */
  private async waitForMasters(jobs: MasterJob[], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    const ids = new Set(jobs.map((j) => j.sourceId));
    this.queue = [...this.queue.filter((q) => ids.has(q)), ...this.queue.filter((q) => !ids.has(q))];
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, rej) => { onAbort = () => rej(new DOMException('cancelled', 'AbortError')); });
    signal?.addEventListener('abort', onAbort, { once: true });
    aborted.catch(() => {});
    try { for (const j of jobs) await Promise.race([j.done, aborted]); }
    finally { signal?.removeEventListener('abort', onAbort); }
  }

  /**
   * Wait for the timeline's full-quality masters before an export, reporting their progress every
   * half second. The render worker runs this outside its serial queue, so frames, scrubbing and
   * imports keep working while a long master encodes (it used to block them all, bar at 0%).
   */
  async awaitTimelineMasters(onProgress: (p: { fraction: number; conform?: { fraction: number; clips: number }; log?: { level: 'info' | 'ok'; text: string } }) => void, signal?: AbortSignal, doc: ProjectDoc = this.need()): Promise<void> {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    const sources = new Set(this.timelineSources(doc));
    // A queued snapshot may no longer be the live project, or may never have been loaded here.
    // Resume its missing masters without installing that snapshot as the preview document.
    for (const c of doc.resources.conforms) {
      if (c.status !== 'proxy' || !sources.has(c.sourceId)) continue;
      const existing = this.masters.get(c.sourceId);
      if (existing) {
        if (existing.rec.id !== c.id) throw new MoshpitError('CONFORM_CHANGED', { sourceId: c.sourceId, pinned: c.id, current: existing.rec.id });
        continue;
      }
      const src = doc.resources.sources.find((s) => s.id === c.sourceId);
      if (!src) throw new MoshpitError('CONFORM_FAILED', { sourceId: c.sourceId, why: 'snapshot source is missing' });
      this.enqueueMaster(src.id, src.path, this.settingsFor(c), c);
    }
    const waiting = this.pending(sources);
    if (!waiting.length) return;
    onProgress({ fraction: 0, conform: { fraction: 0, clips: waiting.length }, log: { level: 'info', text: `waiting for ${waiting.length} clip${waiting.length > 1 ? 's' : ''} to finish conforming at full quality` } });
    const tick = setInterval(() => {
      const f = waiting.reduce((a, j) => a + (j.state === 'READY' ? 1 : j.fraction), 0) / waiting.length;
      onProgress({ fraction: 0, conform: { fraction: f, clips: waiting.filter((j) => j.state !== 'READY').length } });
    }, 500);
    try { await this.waitForMasters(waiting, signal); } finally { clearInterval(tick); }
    onProgress({ fraction: 0, conform: { fraction: 1, clips: 0 }, log: { level: 'ok', text: 'conform finished, rendering' } });
  }

  /** The project as the engine compiles it: proxy-stage records whose master finished are swapped for the ready one. */
  private effective(doc: ProjectDoc): ProjectDoc {
    if (!doc.resources.conforms.some((c) => c.status === 'proxy')) return doc;
    const conforms = doc.resources.conforms.map((c) => {
      const j = c.status === 'proxy' ? this.masters.get(c.sourceId) : undefined;
      return j?.ready && j.rec.id === c.id ? { ...j.ready, id: c.id } : c;
    });
    return { ...doc, resources: { ...doc.resources, conforms } };
  }

  private timelineSources(doc: ProjectDoc): SourceId[] { return doc.timeline.blocks.map((b) => b.sourceId); }

  private settings(quality?: ConformQuality): ConformSettings {
    const d = this.doc ?? newProject('scratch');
    return { fps: d.settings.fps, width: d.settings.working.w, height: d.settings.working.h, proxyDivisor: 4, crf: 15, quality, ffmpeg: this.o.ffmpeg };
  }

  /**
   * Proxy-first import: probe → proxy, resolve (PROXY_READY), master in the background. A clip
   * already conformed with the same key (content, quality, size…) is reused and resolves ready.
   */
  async importClip(file: string, onProgress?: (p: { stage: 'probe' | 'conform' | 'proxy'; fraction: number }) => void, signal?: AbortSignal, opts: { quality?: ConformQuality; proxyFirst?: boolean; range?: SourceRange } = {}): Promise<{ source: SourceClip; conform: ConformedSource }> {
    onProgress?.({ stage: 'probe', fraction: 0 });
    const p = await this.jobs.probe(file, this.o.ffmpeg);
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    const id = newId<SourceId>();
    // Use with IN/OUT conforms only that slice: a 4 s cut of a 48 min film is a 4 s conform, not 48 min.
    const base = this.settings(opts.quality);
    // A requested range is never dropped: it is clamped to at least one frame, or refused.
    const range = opts.range && validRange(opts.range, p.durationSec, base.fps);
    const settings = { ...base, ...(range ? { range } : {}) };
    let rec = await this.jobs.conformProxy(id, file, settings, path.join(this.o.cacheDir, 'conform'), { signal, onProgress: (f) => onProgress?.({ stage: 'proxy', fraction: f }) });
    if (rec.status === 'proxy') {
      const j = this.enqueueMaster(id, file, settings, rec);
      if (opts.proxyFirst === false) { await this.waitForMasters([j], signal); rec = j.ready!; }
    }
    const source: SourceClip = { id, name: path.basename(file), path: file, sourceHash: await this.jobs.sourceHash(file), probe: p, chapters: [], marks: [], conformId: rec.id, motionSignature: null, ...(range ? { range } : {}) };
    return { source, conform: rec };
  }

  /**
   * D7: re-conform each source and compare with its pinned record. A mismatch keeps the pinned
   * conform (edits never shift) and reports CONFORM_CHANGED (≈). Expensive: a full conform per
   * source, so the UI runs it on demand or in the background, never on every open.
   */
  async verifyConforms(onProgress?: (p: { done: number; total: number }) => void, signal?: AbortSignal): Promise<ConformCheck[]> {
    const doc = this.need();
    const out: { sourceId: SourceId; status: 'same' | 'changed' | 'missing'; error?: ReturnType<MoshpitError['toJSON']> }[] = [];
    const dir = path.join(this.o.cacheDir, 'verify');
    for (const [i, src] of doc.resources.sources.entries()) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      const pinned = doc.resources.conforms.find((c) => c.id === src.conformId);
      if (pinned?.status === 'proxy') continue; // checked once its master exists
      if (!pinned || !fs.existsSync(src.path)) { out.push({ sourceId: src.id, status: 'missing', error: new MoshpitError('MEDIA_FILE_MISSING', { path: src.path }).toJSON() }); continue; }
      const fresh = await this.jobs.reconform(src.id, src.path, this.settingsFor(pinned), dir, { signal });
      const changed = conformDiverged(pinned, fresh.record);
      out.push({ sourceId: src.id, status: changed ? 'changed' : 'same', ...(changed ? { error: new MoshpitError('CONFORM_CHANGED', { sourceId: src.id, pinned: pinned.conformedHash, fresh: fresh.record.conformedHash }).toJSON() } : {}) });
      fs.rmSync(fresh.record.path, { force: true }); if (fresh.record.proxy) fs.rmSync(fresh.record.proxy.path, { force: true });
      onProgress?.({ done: i + 1, total: doc.resources.sources.length });
    }
    return out;
  }

  async detectCuts(sourceId: SourceId, sensitivity: number, signal?: AbortSignal): Promise<Chapter[]> {
    const { src, conf } = this.source(sourceId);
    const cuts = await this.jobs.detectCuts(conf, sensitivity, this.o.ffmpeg, { signal });
    return chaptersFromCuts(cuts, conf.frames, sensitivity, src.chapters);
  }

  private source(sourceId: SourceId): { src: SourceClip; conf: ConformedSource } {
    const d = this.need();
    const src = d.resources.sources.find((s) => s.id === sourceId);
    if (!src) throw new MoshpitError('MEDIA_FILE_MISSING', { sourceId });
    const conf = d.resources.conforms.find((c) => c.id === src.conformId) ?? d.resources.conforms.find((c) => c.sourceId === sourceId);
    if (!conf) throw new MoshpitError('CONFORM_FAILED', { sourceId, why: 'not conformed' });
    return { src, conf };
  }

  private need(): ProjectDoc {
    if (!this.doc) throw new MoshpitError('TIMELINE_EMPTY', { why: 'no project loaded' });
    return this.effective(this.doc);
  }

  /**
   * An engine for a purpose, rebuilt only when the project changed. Small requests use the
   * keyframe-locked proxy (decision 2): the real mosh at a quarter of the size.
   */
  private slot(purpose: string, doc: ProjectDoc, variant: 'master' | 'proxy', viewer?: { blockId: BlockId; nodeId: NodeId }, extra = ''): Slot {
    const key = `${purpose}:${variant}:${this.version}${extra && ':' + extra}`;
    const name = `${purpose}:${variant}`;
    const have = this.slots.get(name);
    // Map insertion order is access order, including a cache hit or an in-place update.
    if (have) { this.slots.delete(name); this.slots.set(name, have); }
    if (have && have.key === key) return have;
    // Engine.update patches plans/graphs, not constructor settings or freeze attachments. A
    // freeze change also invalidates cached pixels, which are served before checking freezes.
    const timelinePurpose = purpose === 'timeline' || purpose === 'timeline-scope';
    const identity = JSON.stringify([doc.id, doc.settings, variant === 'master' && timelinePurpose ? doc.freezes : []]);
    const compiled = compileProject(doc, { variant, backend: 'preview', viewer });
    if (have && have.identity === identity && have.engine.hashes.length === compiled.plan.frames && have.engine.w === compiled.plan.width && have.engine.h === compiled.plan.height) {
      have.engine.update({ plan: compiled.plan, blocks: doc.timeline.blocks, blockPlans: compiled.blockPlans, lfos: doc.modulators.lfos, values: doc.modulators.values ?? [] });
      have.compiled.close();
      const next = { key, identity, compiled, engine: have.engine, variant };
      this.slots.set(name, next);
      return next;
    }
    if (have) this.releaseSlot(name);
    // Release BEFORE allocation: creating the replacement first can itself evict a live
    // browser context. A disposed slot also loses its pending background-fill window.
    while (this.slots.size >= PREVIEW_SLOTS) this.releaseSlot(this.slots.keys().next().value!);
    let engine: Engine;
    try {
      engine = new Engine(engineOptions(doc, compiled, { cacheDir: path.join(this.o.cacheDir, 'engine'), role: 'preview', decodeAccel: 'no-preference', budgetBytes: this.o.budgetBytes, frameCacheBytes: this.o.frameCacheBytes ?? PREVIEW_FRAME_CACHE_BYTES }));
    } catch (e) { compiled.close(); throw e; }
    // Re-open recorded freezes without rendering them (L25): fresh ones serve, stale ones still play.
    if (variant === 'master' && timelinePurpose) for (const f of doc.freezes) if (f.target.kind === 'block') engine.attachFreeze(f.target.blockId, f.range[0], f.range[1], f.key);
    const s = { key, identity, compiled, engine, variant };
    this.slots.set(name, s);
    return s;
  }

  private releaseSlot(name: string): void {
    const s = this.slots.get(name);
    if (!s) return;
    this.slots.delete(name);
    if (this.fillWin?.slot === name) this.fillWin = null;
    s.engine.dispose(); s.compiled.close();
  }

  private releaseSlots(): void {
    for (const name of [...this.slots.keys()]) this.releaseSlot(name);
    this.fillWin = null;
  }

  async frame(target: FrameTarget, size: { w: number; h: number; quality?: 'auto' | 'full'; interactive?: boolean; playback?: boolean; priority?: 'foreground' | 'background' }, signal?: AbortSignal): Promise<FramePixels> {
    signal?.throwIfAborted();
    const doc = this.need();
    const needs = target.kind === 'source' ? [target.sourceId] : this.timelineSources(doc);
    // Range scopes seek independently: they must not rewind the active Program decoder.
    const timelinePurpose = size.priority === 'background' ? 'timeline-scope' : 'timeline';
    let variant: 'master' | 'proxy' = size.quality !== 'full' && size.w <= Math.ceil(doc.settings.working.w / 4 * 1.25) ? 'proxy' : 'master';
    // Auto Program/audition paints a quick proxy before its full refinement. Keep the
    // requested viewport size: shrinking it would misclassify auditions as thumbnails.
    if (size.interactive && size.quality !== 'full' && (target.kind === 'output' || target.kind === 'trial')) {
      const purpose = target.kind === 'output' ? timelinePurpose : size.w < 480 ? 'trial-thumb' : 'trial-audition';
      const extra = target.kind === 'trial' ? ':' + crypto.createHash('sha1').update(JSON.stringify(target.graph)).digest('hex').slice(0, 16) : '';
      const master = this.slots.get(`${purpose}:master`);
      const t = master ? Math.max(0, Math.min(master.compiled.plan.frames - 1, target.frame)) : target.frame;
      // Never downgrade a valid cached full frame, nor substitute an unfrozen proxy for
      // recorded output. Version/graph checks prevent returning a pre-edit cached image.
      const cached = master?.key === `${purpose}:master:${this.version}${extra}` && master.engine.hasCached(t);
      const frozen = target.kind === 'output' && doc.freezes.some(f => f.target.kind === 'block' && target.frame >= f.range[0] && target.frame <= f.range[1]);
      variant = cached || frozen ? 'master' : 'proxy';
    }
    // Older projects and cleaned caches can keep masters without their proxies. This
    // fallback serves every preview: Program, scopes, source strips, nodes and trials.
    // Do not select unfinished masters or hide a genuinely missing conform/source.
    if (variant === 'proxy' && !this.pending(needs).length) {
      const conforms = needs.map(id => {
        const src = doc.resources.sources.find(s => s.id === id);
        return doc.resources.conforms.find(c => c.id === src?.conformId) ?? doc.resources.conforms.find(c => c.sourceId === id);
      });
      const missingProxy = conforms.some(c => c && (!c.proxy?.path || !fs.existsSync(c.proxy.path)));
      if (missingProxy && conforms.every(c => c?.path && fs.existsSync(c.path))) variant = 'master';
    }
    // EXACT needs the master: until it exists, a large viewer gets the proxy, reported as PROXY (≈).
    const finalizing = variant === 'master' && this.pending(needs).length > 0;
    if (finalizing) variant = 'proxy';
    const t0 = performance.now();
    let s: Slot, t: number, route: string;
    if (target.kind === 'source') {
      const { src, conf } = this.source(target.sourceId);
      const mini = { ...newProject('source view'), settings: doc.settings, resources: { sources: [src], conforms: [conf] } } as ProjectDoc;
      mini.timeline.blocks = [newBlock('picture', src.id, 0, conf.frames)];
      s = this.slot(`source-${src.id}`, mini, variant);
      t = Math.max(0, Math.min(conf.frames - 1, target.frame));
      route = `${conf.keyframes.includes(t) ? 'I-frame' : 'P-frame'} · ${variant === 'proxy' ? 'proxy' : 'exact'}`;
    } else if (target.kind === 'trial') {
      // Two trial slots. The audition (viewer size) keeps its own, so its compiled plan and the scrub
      // cache its 2 s loop plays from survive while the browser's row previews (thumbnail size) take
      // turns on the other: sharing one, every row swapped the graph and dropped the audition's
      // cache (integration audit P2, worst during the proxy window right after import).
      const role = size.w < 480 ? 'trial-thumb' : 'trial-audition';
      if (!doc.timeline.blocks.some((b) => b.id === target.blockId)) throw new MoshpitError('PARAM_UNKNOWN', { blockId: target.blockId });
      const trial = { ...doc, timeline: { ...doc.timeline, blocks: doc.timeline.blocks.map((b) => (b.id === target.blockId ? { ...b, graph: target.graph } : b)) } };
      s = this.slot(role, trial, variant, undefined, crypto.createHash('sha1').update(JSON.stringify(target.graph)).digest('hex').slice(0, 16));
      t = Math.max(0, Math.min(s.compiled.plan.frames - 1, target.frame));
      const span = s.compiled.plan.blocks.find((b) => t >= b.start && t < b.end)!;
      route = `trial · ${span.kind} block · ${s.compiled.plan.moshRanges.some(([a, b]) => t >= a && t < b) ? 'moshed' : 'clean'}`;
    } else {
      s = target.kind === 'node' ? this.slot(`${size.priority === 'background' ? 'scope-viewer' : 'viewer'}-${target.blockId}-${target.nodeId}`, doc, variant, { blockId: target.blockId, nodeId: target.nodeId }) : this.slot(timelinePurpose, doc, variant);
      t = Math.max(0, Math.min(s.compiled.plan.frames - 1, target.frame));
      const span = s.compiled.plan.blocks.find((b) => t >= b.start && t < b.end)!;
      route = `${span.kind} block · ${s.compiled.plan.held[t] ? 'held (removed keyframe)' : s.compiled.plan.moshRanges.some(([a, b]) => t >= a && t < b) ? 'moshed' : 'clean'}`;
    }
    let data: Uint8Array | null = null;
    const t1 = performance.now(), st0 = previewTimingOn ? { ...s.engine.stats } : null, hit = s.engine.hasCached(t);
    // Playback asks for one Program frame a tick, and a moshed stream has no keyframe to seek to:
    // each single-frame render re-decoded the chain from the last keyframe (≈350 ms a tick at proxy
    // size, 1.3 fps drawn, measured). A Program request the UI marks as playback renders the frames
    // ahead in the same decode pass, so the next ticks are cache reads. Only playback: a paused seek
    // or step stays a single-frame render (inferring playback from a short forward jump made the
    // first paused step pay the read-ahead, +263 ms, measured). Bounded by the frame cache so the
    // requested frame is never evicted by its own read-ahead.
    // A retained decoder can serve the next requested frame directly. The old
    // 120-frame batch otherwise delays its first visible frame by about a second.
    // Keep batching only for paths that cannot continue (for example GPU proxy).
    const ahead = target.kind === 'output' && !!size.interactive && !!size.playback && !hit && !s.engine.canContinue(t)
      ? Math.min(READ_AHEAD, Math.max(0, Math.floor((this.o.frameCacheBytes ?? PREVIEW_FRAME_CACHE_BYTES) / (s.engine.outW * s.engine.outH * 4)) - 1)) : 0;
    await s.engine.renderRange(t, Math.min(s.compiled.plan.frames - 1, t + ahead), { signal, onFrame: (px) => { data ??= px.slice(); } });
    signal?.throwIfAborted();
    if (st0) {
      const st = s.engine.stats;
      previewTiming({ ev: 'service.frame', kind: target.kind, frame: t, req: `${size.w}x${size.h}`, quality: size.quality ?? 'auto', interactive: !!size.interactive, variant, engine: `${s.engine.w}x${s.engine.h}`, cacheHit: hit, ahead, slotMs: Math.round(t1 - t0), renderMs: Math.round(performance.now() - t1), replayed: st.replayed - st0.replayed, decoded: st.decoded - st0.decoded, gpuFrames: st.gpuFrames - st0.gpuFrames, stepPasses: st.stepPasses - st0.stepPasses, unspills: st.unspills - st0.unspills, resumedRanges: st.resumedRanges - st0.resumedRanges, previewFlushes: st.previewFlushes - st0.previewFlushes });
    }
    // Audit S4: fill the frames around this one in the background, so a scrub here turns into cache reads.
    // A thumbnail-size trial is never filled around (each is one look at one frame); an audition at
    // viewer size is, so its 2 s loop plays from the cache.
    const name = size.priority === 'background' || (target.kind === 'trial' && size.w < 480) ? undefined : [...this.slots.entries()].find(([, v]) => v === s)?.[0];
    if (name) {
      // Reserve the requested frame: warming more pixels than the cache holds evicts it
      // before the user returns. Fitting to the viewer happens later, outside this cache.
      const cacheBytes = this.o.frameCacheBytes ?? PREVIEW_FRAME_CACHE_BYTES;
      const neighbors = Math.min(120, Math.max(0, Math.floor(cacheBytes / (s.engine.outW * s.engine.outH * 4)) - 1));
      this.fillWin = neighbors > 0 ? { slot: name, ranges: [
        [t + 1, Math.min(s.compiled.plan.frames - 1, t + Math.ceil(neighbors / 2))],
        [Math.max(0, t - Math.floor(neighbors / 2)), t - 1],
      ] } : null;
    }
    const span = s.compiled.plan.blocks.find((b) => t >= b.start && t < b.end);
    const status = span ? s.compiled.blockPlans.get(span.blockId)?.status : undefined;
    const proxied = variant === 'proxy' || (!!status && [...status.values()].includes('PROXY'));
    const fz = target.kind === 'output' && span ? s.engine.freezeState(span.blockId) : 'none';
    route += ` · ${s.engine.w}×${s.engine.h} ${variant}`;
    return { w: s.engine.outW, h: s.engine.outH, data: data!, state: proxied ? 'PROXY' : 'EXACT', route: finalizing ? `${route} · finalizing conform` : route, ...(fz !== 'none' ? { freeze: fz } : {}) };
  }

  /** L25: bounce a block range on the master preview engine. The UI stores the record. */
  async freeze(target: FreezeTarget, range: [number, number]): Promise<FreezeRecord> {
    const doc = this.need();
    if (target.kind !== 'block') throw new MoshpitError('INTERNAL', { why: 'node-level freeze is M2' });
    const waiting = this.pending(this.timelineSources(doc));
    if (waiting.length) throw new MoshpitError('CONFORM_PENDING', { sourceIds: waiting.map((j) => j.sourceId), why: 'a freeze is a master render' });
    const s = this.slot('timeline', doc, 'master');
    const f = await s.engine.freeze(target.blockId, range[0], range[1]);
    // The document owns whether a freeze plays. A late UI result can be discarded after an
    // edit/project switch, so never leave its uncommitted attachment active in the service.
    // Force the next request to rebuild and attach only the records then in the document.
    s.engine.unfreeze(target.blockId);
    s.key = ''; s.identity = '';
    return { id: newId<FreezeId>(), target, range, key: f.key, codec: 'raw-rgba8', fingerprint: s.engine.fingerprint, createdAt: new Date().toISOString() };
  }

  /** The authoritative export (L30): a fresh export-role engine on the pinned software decoder. */
  async render(job: RenderJob, onProgress: (p: { fraction: number; conform?: { fraction: number; clips: number }; log?: { level: 'info' | 'warn' | 'ok'; text: string } }) => void, signal?: AbortSignal): Promise<void> {
    const snapshot = structuredClone(job.doc ?? this.need());
    assertNotSource(snapshot, job.outPath); // before EXPORT_EXISTS: a source always exists
    if (this.doc) assertNotSource(this.doc, job.outPath);
    if (fs.existsSync(job.outPath)) throw new MoshpitError('EXPORT_EXISTS', { path: job.outPath });
    // Export is the master's job (L30). Masters still encoding move to the front of the queue and
    // the export starts when they are done: queued, not refused, so the user exports once. The wait
    // reports conform progress (the Conform stage), on every path, not only the worker's.
    await this.awaitTimelineMasters(onProgress, signal, snapshot);
    const doc = this.effective(snapshot);
    assertNotSource(doc, job.outPath);
    if (this.doc) assertNotSource(this.doc, job.outPath);
    const compiled = compileProject(doc, { variant: 'master', backend: 'export' });
    const engine = new Engine(engineOptions(doc, compiled, { cacheDir: path.join(this.o.cacheDir, 'engine'), role: 'export', decodeAccel: 'prefer-software' }));
    try {
      for (const f of doc.freezes) if (f.target.kind === 'block') engine.attachFreeze(f.target.blockId, f.range[0], f.range[1], f.key);
      // E13: log the frames this job renders, which is the range when one is given, not the plan.
      const total = compiled.plan.frames, [ra, rb] = job.config.range ?? [0, total - 1];
      if (ra < 0 || rb >= total || rb < ra) throw new MoshpitError('RANGE_INVALID', { range: [ra, rb], frames: total });
      onProgress({ fraction: 0, log: { level: 'info', text: `rendering frames ${ra}–${rb} (${rb - ra + 1} of ${total}), ${job.config.format} ${job.config.width}×${job.config.height}` } });
      if (rb < total - 1) onProgress({ fraction: 0, log: { level: 'warn', text: `the range stops ${total - 1 - rb} frames before the end of the timeline` } });
      const rep = await exportRange(engine, doc, compiled.plan, job.config, job.outPath, { tmpDir: path.join(this.o.cacheDir, 'tmp'), ffmpeg: this.o.ffmpeg, signal, onProgress: (f) => onProgress({ fraction: f }) });
      onProgress({ fraction: 1, log: { level: 'ok', text: `wrote ${rep.file}: ${rep.frames} frames in ${(rep.ms / 1000).toFixed(1)} s` } });
    } finally { engine.dispose(); compiled.close(); }
  }

  /** Per-clip audio (L27) as peak buckets 0..1, decoded by ffmpeg at 8 kHz mono. */
  async audioPeaks(sourceId: SourceId, buckets: number): Promise<Float32Array> {
    const { src, conf } = this.source(sourceId);
    const out = new Float32Array(Math.max(1, buckets));
    // The conformed audio lives in the master; before it exists, read the source's own (same shape).
    const file = conf.status === 'proxy' ? src.path : conf.path;
    if (conf.status === 'proxy' ? !src.probe.audio : !conf.audio) return out;
    const pcm = await new Promise<Buffer>((res, rej) => {
      const p = spawn(findFfmpeg(this.o.ffmpeg).ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { windowsHide: true });
      const parts: Buffer[] = [];
      p.stdout.on('data', (d: Buffer) => parts.push(d));
      p.on('error', rej);
      p.on('close', (code) => (code === 0 ? res(Buffer.concat(parts)) : rej(new MoshpitError('MEDIA_UNREADABLE', { path: file }))));
    });
    const n = pcm.length >> 1, per = Math.max(1, Math.floor(n / out.length));
    for (let b = 0; b < out.length; b++) {
      let m = 0;
      for (let i = b * per, e = Math.min(n, i + per); i < e; i++) { const v = Math.abs(pcm.readInt16LE(i * 2)); if (v > m) m = v; }
      out[b] = m / 32768;
    }
    return out;
  }

  /** The clip library (library/index.ts): roots scanned once per session, probes cached in SQLite. */
  private lib: LibraryIndex | null = null;
  private scanned = new Set<string>();
  private library(): LibraryIndex { return (this.lib ??= new LibraryIndex(path.join(this.o.cacheDir, 'library.db'), this.o.ffmpeg)); }

  async libraryFolders(): Promise<LibraryFolder[]> {
    const out: LibraryFolder[] = [];
    for (const root of this.o.libraryRoots ?? []) {
      if (!fs.existsSync(root)) continue;
      if (!this.scanned.has(root)) { await this.library().scan(root); this.scanned.add(root); }
      out.push(this.library().folders(root));
    }
    return out;
  }

  /**
   * E14: change the library roots at runtime (Settings → Media folder) without a restart. Every
   * root is walked again, so calling it with the same roots is a rescan. Ratings and tags survive.
   */
  /** A folder's subfolders, for navigating the disk; '' lists the drives. Hidden and system folders are skipped. */
  async listDir(dir: string): Promise<DirListing> {
    if (!dir) {
      // Async checks (bug hunt): a disconnected mapped drive must not stall the engine's thread.
      const letters = [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `${l}:\\`);
      const ok = await Promise.all(letters.map((d) => fs.promises.access(d).then(() => true, () => false)));
      const drives = letters.filter((_, i) => ok[i]);
      return { path: '', parent: null, dirs: drives.map((d) => ({ name: d.slice(0, 2), path: d })) };
    }
    const full = path.resolve(dir);
    const st = await fs.promises.stat(full).catch(() => null);
    if (!st?.isDirectory()) throw new MoshpitError('MEDIA_FILE_MISSING', { path: dir, why: 'folder not found' });
    const parent = path.dirname(full) === full ? '' : path.dirname(full);
    let entries: fs.Dirent[] = [];
    try { entries = await fs.promises.readdir(full, { withFileTypes: true }); } catch { /* unreadable: no subfolders */ }
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && e.name !== 'System Volume Information')
      .map((e) => ({ name: e.name, path: path.join(full, e.name) })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { path: full, parent, dirs };
  }

  async setLibraryRoots(roots: string[]): Promise<LibraryFolder[]> {
    this.o.libraryRoots = roots.map((r) => r.trim()).filter(Boolean);
    this.scanned.clear();
    return this.libraryFolders();
  }

  async libraryClips(folder: string): Promise<LibraryClip[]> {
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new MoshpitError('MEDIA_FILE_MISSING', { path: folder, why: 'library folder not found' });
    // Navigation reaches folders outside the roots: index such a folder's own files the first time it opens.
    const key = path.resolve(folder).toLowerCase();
    const root = (this.o.libraryRoots ?? []).find((r) => isUnder(folder, r));
    // A folder under a root that was never walked (asked for before the tree was listed, e.g. the
    // Starter Mosh from Home): walk that root first, or the folder reads empty.
    if (root && !this.scanned.has(root) && fs.existsSync(root)) { await this.library().scan(root); this.scanned.add(root); }
    if (!root && !this.scanned.has('dir:' + key)) { await this.library().scan(folder, undefined, undefined, true); this.scanned.add('dir:' + key); }
    const empty: SourceProbe = { codec: '?', width: 0, height: 0, fps: { num: 30, den: 1 }, durationSec: 0, pixFmt: '?', hasAlpha: false };
    // A library row addresses the whole file. A prior ranged import has a different frame origin
    // and duration, so reusing its ID would offset/truncate the next browser selection.
    return (await this.library().clips(folder)).map((c) => ({ path: c.path, name: c.name, probe: c.probe ?? empty, rating: c.rating, tags: c.tags, pass: c.pass, sourceId: this.doc?.resources.sources.find((s) => s.path === c.path && !s.range)?.id }));
  }

  /**
   * One chunk of background fill. The worker calls this whenever its request queue is empty and
   * stops as soon as a request arrives, so a fill never delays an interaction by more than a chunk.
   * Returns false when there is nothing left to do.
   */
  async idle(chunk = 12, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const w = this.fillWin;
    const s = w && this.slots.get(w.slot);
    if (!w || !s) return false;
    for (;;) {
      const r = w.ranges[0];
      if (!r) { this.fillWin = null; return false; }
      while (r[0] <= r[1] && s.engine.hasCached(r[0])) r[0]++;
      // Do not discard an intact forward decoder merely to fill old neighbours.
      // An explicit backward seek still takes the exact replay path on demand.
      if (r[0] <= r[1] && s.engine.canWarmFrom(r[0])) break;
      w.ranges.shift();
    }
    const r = w.ranges[0];
    const b = Math.min(r[1], r[0] + chunk - 1);
    const t0 = performance.now();
    await s.engine.renderRange(r[0], b, { fill: true, signal });
    previewTiming({ ev: 'service.fill', slot: w.slot, range: [r[0], b], ms: Math.round(performance.now() - t0) });
    signal?.throwIfAborted();
    r[0] = b + 1;
    return true;
  }

  // ── raw-file preview for the source browser (engine/src/preview) ──
  // Disposable and approximate, on its own decoders: never an Engine, never a conform. Importing
  // the clip (drag to timeline) is what conforms it, through the proxy-first path above.

  private previews = new Map<string, Promise<PreviewSource>>();
  private static readonly OPEN_PREVIEWS = 4;

  /** What a raw file is and whether it scrubs live ('native') or shows a filmstrip. */
  previewInfo(file: string): Promise<PreviewInfo> { return previewInfo(file, undefined, this.o.ffmpeg); }

  /**
   * One frame of a raw file. `exact: false` snaps to the keyframe at or before `timeSec` (hover);
   * `exact: true` is the frame shown at `timeSec` (pointer at rest). Resolves null when a newer
   * request for the same file superseded it. PREVIEW_UNSUPPORTED for filmstrip-only files.
   */
  async previewFrame(file: string, timeSec: number, req: FrameRequest): Promise<PreviewFrame | null> {
    let src = this.previews.get(file);
    if (src) { this.previews.delete(file); this.previews.set(file, src); }
    else {
      src = PreviewSource.open(file);
      this.previews.set(file, src);
      src.catch(() => this.previews.delete(file));
      while (this.previews.size > EngineService.OPEN_PREVIEWS) {
        const [old, p] = this.previews.entries().next().value!;
        this.previews.delete(old);
        p.then((x) => x.close(), () => {});
      }
    }
    return (await src).frame(timeSec, req);
  }

  /** Release a file's preview decoder (the browser moved on). Opening again is cheap. */
  /** Free a trial role's engines (integration audit: they lived until the next trial or dispose). */
  releaseTrials(role: 'audition' | 'thumb'): void {
    for (const name of [...this.slots.keys()]) {
      if (!name.startsWith(`trial-${role}:`)) continue;
      this.releaseSlot(name);
    }
  }

  closePreview(file: string): void {
    const p = this.previews.get(file);
    this.previews.delete(file);
    p?.then((x) => x.close(), () => {});
  }

  /** Evenly spaced stills from ffmpeg, cached on disk. Works for every file ffmpeg reads. */
  filmstrip(file: string, o: Omit<FilmstripOptions, 'ffmpeg'> = {}): Promise<Filmstrip> {
    return filmstrip(file, this.o.cacheDir, { ...o, ffmpeg: this.o.ffmpeg });
  }

  setRating(file: string, rating: number): void { this.library().setRating(file, rating); }
  setTags(file: string, tags: string[]): void { this.library().setTags(file, tags); }

  dispose(): void {
    this.queue = [];
    this.running?.ac.abort();
    for (const f of [...this.previews.keys()]) this.closePreview(f);
    this.releaseSlots();
    this.lib?.close(); this.lib = null;
    this.slots.clear();
  }
}
