// The runtime: executes a stage-1 plan (one encoded stream) through the decode boundary into the
// per-block stage-2 plans, on the GPU. Built on the spike's Engine (moshpit-v3-spike/engine.js,
// 5463c31): same decode driver, checkpoint+replay seek, frame hashing and freeze, generalised
// from one clip and one fixed chain to a spliced timeline of per-block graphs.
//
// The rules it keeps (each proven by the spike's 9 cases, re-run in harness/gate):
//   L9   time is the timeline frame; the decoder's timestamp carries the decode-sample index only
//   L10  a frame is a function of project state: seek = restore the nearest valid state, replay
//   L11  same plan + seed + range ⇒ same pixels, whatever was rendered before
//   L21  nothing allocates in the per-frame path
//   S1   stage-2 state resets at every block repetition start
//   S2   one global checkpoint pool, LRU, spilling to disk instead of dropping (F3)
//   B2   export never serves a stale freeze

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MoshpitError } from '../errors';
import type { Block, BlockId, Lfo, NodeId, ProjectValue } from '../model';
import type { BlockPlan } from '../graph/stage2';
import { type Stage1Plan, type BlockSpan, sampleBytes } from '../timeline/stage1';
import { GL2Backend, COLOUR_SHADERS, type Program, type Target } from '../gpu/backend';
import { createGpuNode, SeamProxy, type GpuNode } from '../gpu/nodes';
import { compileParams, resolveInto, type ParamProgram } from '../control/params';
import { RationalClock } from '../time/clock';
import { hash30, hash53, seeded } from '../util/determinism';
import { executionFingerprint, freezeKey, graphHash } from './freeze';
import { inlineContainers } from '../graph/container';
import { previewTiming, previewTimingOn } from '../telemetry/previewTiming';

export interface EngineOptions {
  /** The stream to decode: the moshed plan, or the clean plan when moshPreview is 'gpu-proxy'. */
  plan: Stage1Plan;
  /** With a clean `plan`: the moshed plan whose hold points and ranges the GPU proxy follows. */
  moshed?: Stage1Plan;
  blocks: Block[];
  blockPlans: Map<BlockId, BlockPlan>;
  lfos: Lfo[];
  /** Phase 1.5: project Values that bindings read (absent in older callers: none). */
  values?: ProjectValue[];
  bpm: number;
  seed: number;
  /** L30: 'prefer-software' is the authoritative path; hardware is preview-only. */
  decodeAccel?: HardwareAcceleration;
  budgetBytes?: number;
  cacheDir: string;
  canvas?: HTMLCanvasElement;
  checkpointEvery?: number;
  /** Checkpoint pool capacity, in working-frame state textures. Derived from the budget if absent. */
  checkpointTextures?: number;
  /** Disk cap for spilled checkpoints, bytes. Past it the oldest spill is dropped (a far seek replays further). Default 2 GiB. */
  spillBytes?: number;
  maxLiveBlocks?: number;
  role?: 'export' | 'preview';
  /**
   * Audit S4: a RAM cache of egress frames for scrubbing, in bytes. Preview role only — an export
   * never fills it, so the long-render loop stays allocation-free (L21). 0 disables.
   */
  frameCacheBytes?: number;
}

interface Step {
  node: GpuNode;
  nodeId: NodeId;
  inputs: (Target | null)[];
  inSlots: number[];
  out: Target;
  u: Float32Array;
  params: ParamProgram[];
  instHash: number;
  noiseHash: number;
}

interface BlockRuntime {
  blockId: BlockId;
  plan: BlockPlan;
  steps: Step[];
  nodes: GpuNode[];
  delays: Target[];
  commits: { from: number; to: Target }[];
  slotTargets: (Target | null)[];
  output: Target | null; // null = the decode input itself
  /** Everything a checkpoint must snapshot, in a fixed order. */
  state: Target[];
  stateful: boolean;
  lastUsed: number;
}

interface Checkpoint {
  t: number;
  blockId: BlockId;
  targets: Target[];
  spilled: string | null;
  used: number;
}

interface ActiveFreeze {
  key: string;
  a: number;
  b: number;
  file: string;
  fd: number;
}

export interface RenderOptions {
  /** Superseded interactive work stops at a safe decode/frame boundary. */
  signal?: AbortSignal;
  /** Read pixels back and hash every sunk frame (tests, cache, export). Preview leaves it off. */
  hash?: boolean;
  /** Receives the egress RGBA8 pixels of each frame in range. The buffer is reused: copy what you keep. */
  onFrame?: ((px: Uint8Array, t: number) => void) | null;
  /** Draw each frame to the canvas (preview). */
  present?: boolean;
  /** Skip frames already hashed (preview cache). */
  useCache?: boolean;
  /** Awaited every 8 decode submissions: the caller's backpressure (an encoder queue). */
  gate?: (() => Promise<void>) | null;
  /** Ignore freezes entirely (a forced re-render). */
  live?: boolean;
  /** Fill the frame cache without a sink: the background fill of audit S4. */
  fill?: boolean;
}

/** Backpressure: one promise per wait, resolved once the queue is short again. */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('superseded', 'AbortError');
}

function drain(dec: VideoDecoder, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { dec.removeEventListener('dequeue', f); signal?.removeEventListener('abort', abort); };
    const f = () => { if (dec.decodeQueueSize <= 4) { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(new DOMException('superseded', 'AbortError')); };
    dec.addEventListener('dequeue', f);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else f();
  });
}

export class Engine {
  readonly be: GL2Backend;
  readonly w: number;
  readonly h: number;
  readonly stats = { resumedRanges: 0, previewFlushes: 0, decoded: 0, gpuFrames: 0, stepPasses: 0, sinked: 0, cacheHits: 0, replayed: 0, frozenFrames: 0, orderErrors: 0, spills: 0, unspills: 0, spillDrops: 0, runtimesCreated: 0, runtimesDisposed: 0 };
  readonly hashes: Float64Array;
  readonly cached: Uint8Array;
  readonly fingerprint: string;
  anomalies: unknown[] = [];

  private o: EngineOptions;
  private plan!: Stage1Plan;
  private moshed: Stage1Plan | null = null;
  private clock: RationalClock;
  private blocksById = new Map<BlockId, Block>();
  private spanOf!: Int32Array;
  private rangeActive!: Uint8Array;
  private runtimes = new Map<BlockId, BlockRuntime>();
  private pool: Target[] = [];
  private cps = new Map<number, Checkpoint>();
  private spillUsed = 0;
  // Several preview/export engines share a process and cache root. Their temporal
  // state at the same timeline frame is private, even when dimensions match.
  private readonly spillOwner = randomUUID();
  private cpFree: Target[] = [];
  private cpTextures: number;
  private freezes = new Map<BlockId, ActiveFreeze>();
  /** Egress frames by timeline frame, LRU by Map order. Disposable cache scope (L13). */
  private fcache = new Map<number, Uint8Array>();
  private fcacheBytes = 0;
  private tick = 0;
  private readonly cpEvery: number;

  private src8: Target;
  private lin: Target;
  private proxyOut: Target | null = null;
  private proxy: SeamProxy | null = null;
  private out8: Target;
  private px: Uint8Array;
  private px32: Uint32Array;
  /** Frozen frames are stored at working size (their key says so) and resampled to the output. */
  private frozen8: Target;
  private fpx: Uint8Array;
  /** Output size: the working size unless an export asked for another (custom resolution export). */
  outW: number;
  outH: number;
  private ingress: Program;
  private egress: Program;
  private uProxy = new Float32Array(16);
  /** One init object, mutated per chunk: a literal per chunk is an allocation per frame (L21). */
  private chunkInit: EncodedVideoChunkInit = { type: 'key', timestamp: 0, duration: 1, data: new Uint8Array(0) };

  private decoder: VideoDecoder | null = null;
  private decodeErr: unknown = null;
  // A preview may continue the exact decoder reference chain and GPU state. A flush
  // requires another key chunk, so only completed, unflushed forward work is reusable.
  private forward: { plan: Stage1Plan; sample: number; through: number } | null = null;
  // A stateless parameter edit can reprocess the last decoded linear input without decoding it again.
  private paramRefresh: Engine['forward'] = null;
  private decoderGeneration = 0;
  private decodedThrough = -1;
  private outputWait: (() => void) | null = null;
  private cancelOutputWait: (() => void) | null = null;
  // per-render state (the hot path reads fields, never closures)
  private nextT = 0;
  private gpuFrom = 0;
  private sinkFrom = 0;
  private sinkTo = -1;
  private nextShownT!: Int32Array;
  /** Decode samples before this are fed for the decoder's sake only, never uploaded. */
  private uploadFromK = 0;
  /** False when the proxy's state came back from a checkpoint and must not be re-primed. */
  private primeProxy = true;
  private ro: RenderOptions = {};
  private decoding = false;

  constructor(opts: EngineOptions) {
    this.o = opts;
    this.cpEvery = opts.checkpointEvery ?? 30;
    this.clock = new RationalClock(opts.plan.fps);
    this.w = opts.plan.width; this.h = opts.plan.height;
    const frameBytes16 = this.w * this.h * 8;
    const budget = opts.budgetBytes ?? 3 * 1024 ** 3;
    this.be = new GL2Backend({ bytes: budget }, opts.canvas);
    this.src8 = this.be.target(this.w, this.h, 'rgba8', 'decode upload');
    this.lin = this.be.target(this.w, this.h, 'rgba16f', 'decoded, linear');
    this.out8 = this.be.target(this.w, this.h, 'rgba8', 'egress');
    this.ingress = this.be.program('colour.ingress', COLOUR_SHADERS.ingress, 1);
    this.egress = this.be.program('colour.egress', COLOUR_SHADERS.egress, 1);
    this.px = new Uint8Array(this.w * this.h * 4);
    this.px32 = new Uint32Array(this.px.buffer);
    this.frozen8 = this.be.target(this.w, this.h, 'rgba8', 'frozen frame');
    this.fpx = new Uint8Array(this.w * this.h * 4);
    this.outW = this.w; this.outH = this.h;
    // §6: whatever the budget leaves after the working set, up to a third of it, holds checkpoints.
    this.cpTextures = opts.checkpointTextures ?? Math.max(4, Math.floor((budget / 3) / frameBytes16));
    this.hashes = new Float64Array(opts.plan.frames);
    this.cached = new Uint8Array(opts.plan.frames);
    this.fingerprint = executionFingerprint({ chrome: (globalThis as { process?: { versions?: { chrome?: string } } }).process?.versions?.chrome ?? 'unknown', gpu: this.be.gpuName, decode: opts.decodeAccel ?? 'prefer-software', colour: 'linear-rec709/rgba16f' });
    this.setPlans(opts);
  }

  // ── plans ──

  private setPlans(o: Pick<EngineOptions, 'plan' | 'moshed' | 'blocks' | 'blockPlans' | 'lfos' | 'values'>): void {
    this.forward = null;
    this.paramRefresh = null;
    this.plan = o.plan;
    this.moshed = o.moshed ?? null;
    if (this.moshed && !this.proxy) {
      this.proxy = new SeamProxy(this.be, this.w, this.h);
      this.proxyOut = this.be.target(this.w, this.h, 'rgba16f', 'seam proxy output');
    }
    // Containers (3.2 Phase 3) are inlined here once: every runtime lookup by node id sees the flat graph.
    this.blocksById = new Map(o.blocks.map((b) => [b.id, { ...b, graph: inlineContainers(b.graph).graph }]));
    this.o = { ...this.o, ...o };
    const n = o.plan.frames;
    this.spanOf = new Int32Array(n);
    o.plan.blocks.forEach((s, i) => this.spanOf.fill(i, s.start, s.end));
    this.rangeActive = new Uint8Array(n);
    for (const [s, e] of (this.moshed ?? o.plan).moshRanges) this.rangeActive.fill(1, s, e);
    this.nextShownT = new Int32Array(o.plan.samples.length);
    let nt = n;
    for (let k = o.plan.samples.length - 1; k >= 0; k--) { const t = o.plan.samples[k].t; if (t >= 0) nt = t; this.nextShownT[k] = nt; }
    for (const p of o.blockPlans.values()) if (!p.ok) throw p.errors[0];
    const need = Math.max(1, ...[...o.blockPlans.values()].map((p) => p.slotCount));
    while (this.pool.length < need) this.pool.push(this.be.target(this.w, this.h, 'rgba16f', 'shared slot'));
  }

  /**
   * Swap in recompiled plans after an edit and invalidate exactly what changed (T4): frames whose
   * stage-1 key changed, every frame of a block whose graph changed, and — for blocks with state —
   * everything after the first dirty frame up to the block-repetition end (S1).
   */
  update(next: Pick<EngineOptions, 'plan' | 'moshed' | 'blocks' | 'blockPlans' | 'lfos' | 'values'>): [number, number][] {
    const prev = this.plan, prevBlocks = this.blocksById, prevLfos = this.o.lfos, prevValues = this.o.values ?? [];
    if (next.plan.frames !== prev.frames || next.plan.width !== prev.width) throw new MoshpitError('INTERNAL', { why: 'timeline length or size changed: build a new engine' });
    const dirty = new Uint8Array(prev.frames);
    for (let t = 0; t < prev.frames; t++) if (prev.frameKey[t] !== next.plan.frameKey[t]) dirty[t] = 1;
    for (const s of next.plan.blocks) {
      const a = prevBlocks.get(s.blockId), b = next.blocks.find((x) => x.id === s.blockId);
      if (!a || !b || graphHash(a, prevLfos, prevValues) !== graphHash(b, next.lfos, next.values ?? [])) dirty.fill(1, s.start, s.end);
    }
    for (const s of next.plan.blocks) {
      if (!next.blockPlans.get(s.blockId)?.pastDependent && !(this.moshed && next.moshed)) continue;
      const first = dirty.subarray(s.start, s.end).indexOf(1);
      if (first >= 0) dirty.fill(1, s.start + first, s.end);
    }
    for (const id of [...this.runtimes.keys()]) this.disposeRuntime(id);
    this.setPlans(next);
    for (let t = 0; t < dirty.length; t++) if (dirty[t]) { this.cached[t] = 0; const c = this.fcache.get(t); if (c) { this.fcacheBytes -= c.length; this.fcache.delete(t); } }
    for (const [t, cp] of [...this.cps]) {
      const s = this.plan.blocks[this.spanOf[t]];
      if (dirty.subarray(Math.min(s.start, this.rangeStartBefore(t)), t).includes(1)) this.dropCp(cp);
    }
    const out: [number, number][] = [];
    for (let i = 0; i < dirty.length; i++) if (dirty[i]) { const s = i; while (i < dirty.length && dirty[i]) i++; out.push([s, i]); }
    return out;
  }

  /** Egress to another size (export at a custom resolution). The GPU resamples; hashes then describe the output size. */
  setOutputSize(w: number, h: number): void {
    if (w === this.outW && h === this.outH) return;
    this.forward = null;
    this.be.release(this.out8);
    this.out8 = this.be.target(w, h, 'rgba8', 'egress');
    this.px = new Uint8Array(w * h * 4);
    this.px32 = new Uint32Array(this.px.buffer);
    this.outW = w; this.outH = h;
    this.cached.fill(0);
    this.fcache.clear(); this.fcacheBytes = 0;
  }

  /** Frames currently held in the scrub cache. */
  get cachedFrames(): number { return this.fcache.size; }
  hasCached(t: number): boolean { return this.fcache.has(t); }

  /** Whether a foreground preview can advance without replaying its decoder chain. */
  canContinue(t: number): boolean {
    const tail = this.forward;
    // A distant scrub can skip GPU work via stateStart; do not turn it into
    // thousands of additional GPU steps merely to preserve decoder continuity.
    return this.o.role === 'preview' && !this.moshed && !!tail && tail.plan === this.plan &&
      t > tail.through && t - tail.through <= 120 && this.decoder?.state === 'configured' && !this.decodeErr;
  }

  /** Background warming must not rewind a retained foreground decoder chain. */
  canWarmFrom(t: number): boolean { return !this.forward || t > this.forward.through; }

  /** A param edit that needs no recompile: the live path for drags and the CT (L24: outside React). */
  setParam(blockId: BlockId, nodeId: NodeId, key: string, value: number | boolean | string): void {
    const blk = this.blocksById.get(blockId);
    const node = blk?.graph.nodes.find((n) => n.id === nodeId);
    if (!blk || !node) throw new MoshpitError('PARAM_UNKNOWN', { blockId, nodeId, key });
    const next: Block = { ...blk, graph: { ...blk.graph, nodes: blk.graph.nodes.map((n) => (n.id === nodeId ? { ...n, params: { ...n.params, [key]: value } } : n)) } };
    const tail = this.forward, blockPlan = this.o.blockPlans.get(blockId);
    // Only this API keeps the encoded plan identical. General update/BPM/temporal changes
    // remain conservative. Rebuilding a stateless runtime cannot require prior GPU frames.
    const keepInput = this.o.role === 'preview' && !this.moshed && !this.decoding && !this.decodeErr &&
      this.decoder?.state === 'configured' && tail?.plan === this.plan &&
      this.plan.blocks[this.spanOf[tail.through]]?.blockId === blockId &&
      blockPlan?.ok && blockPlan.pastDependent === false &&
      blockPlan.steps.some((s) => s.node === nodeId && s.def.domain !== 'ENCODED_STREAM' && s.def.temporal.mode !== 'past-dependent');
    this.update({ plan: this.plan, moshed: this.moshed ?? undefined, blocks: this.o.blocks.map((b) => (b.id === blockId ? next : b)), blockPlans: this.o.blockPlans, lfos: this.o.lfos, values: this.o.values });
    if (keepInput) { this.forward = tail; this.paramRefresh = tail; }
  }

  // ── block runtimes (dispose contract, §6) ──

  private runtime(blockId: BlockId): BlockRuntime {
    let rt = this.runtimes.get(blockId);
    if (rt) { rt.lastUsed = ++this.tick; return rt; }
    const plan = this.o.blockPlans.get(blockId);
    const block = this.blocksById.get(blockId);
    if (!plan || !block) throw new MoshpitError('INTERNAL', { why: 'no plan for block', blockId });
    const max = this.o.maxLiveBlocks ?? 4;
    while (this.runtimes.size >= max) {
      let lru: BlockRuntime | null = null;
      for (const r of this.runtimes.values()) if (!lru || r.lastUsed < lru.lastUsed) lru = r;
      this.disposeRuntime(lru!.blockId);
    }
    const slotTargets: (Target | null)[] = [];
    const delays: Target[] = [];
    for (let s = 0; s < plan.slotCount; s++) slotTargets.push(this.pool[s]);
    for (const [, slot] of plan.delaySlots) { const t = this.be.target(this.w, this.h, 'rgba16f', `delay ${blockId}`); delays.push(t); slotTargets[slot] = t; }
    slotTargets[plan.decodeSlot] = null; // the decode input, bound per frame
    const nodes: GpuNode[] = [];
    const steps: Step[] = [];
    for (const st of plan.steps) {
      if (st.def.kind === 'output.sink') continue;
      const inst = block.graph.nodes.find((n) => n.id === st.node)!;
      const node = createGpuNode(st.def, st.passThrough, this.be, this.w, this.h, inst.params);
      nodes.push(node);
      steps.push({
        node, nodeId: st.node, inSlots: st.inputs, inputs: st.inputs.map(() => null), out: slotTargets[st.output]!,
        u: new Float32Array(16), params: compileParams(st.def.params, inst, this.o.lfos, this.clock, this.o.bpm, { seed: this.o.seed, nodeHash: hash30(st.node) }, this.o.values ?? []),
        instHash: hash30(st.node), noiseHash: hash30('noise'),
      });
    }
    const commits = plan.commits.map((c) => ({ from: c.from, to: slotTargets[plan.delaySlots.get(c.node)!]! }));
    const output = plan.outputSlot === plan.decodeSlot ? null : slotTargets[plan.outputSlot];
    const state = [...nodes.flatMap((n) => n.state), ...delays];
    rt = { blockId, plan, steps, nodes, delays, commits, slotTargets, output, state, stateful: state.length > 0, lastUsed: ++this.tick };
    this.runtimes.set(blockId, rt);
    this.stats.runtimesCreated++;
    return rt;
  }

  private disposeRuntime(blockId: BlockId): void {
    const rt = this.runtimes.get(blockId);
    if (!rt) return;
    for (const n of rt.nodes) n.dispose();
    for (const d of rt.delays) this.be.release(d);
    this.runtimes.delete(blockId);
    this.stats.runtimesDisposed++;
  }

  private resetRuntime(rt: BlockRuntime): void {
    for (const n of rt.nodes) n.reset();
    for (const d of rt.delays) this.be.clear(d); // Delay: transparent black at the block's first frame
  }

  // ── checkpoints (L10 seek, S2 global pool, F3 spill) ──

  private rangeStartBefore(t: number): number {
    if (!this.moshed) return t;
    let s = t;
    while (s > 0 && this.rangeActive[s - 1]) s--;
    return s;
  }

  private proxyStateAt(t: number): Target[] { return this.proxy && this.rangeActive[t] ? [this.proxy.prevOut, this.proxy.prevClean] : []; }

  private saveCp(t: number, rt: BlockRuntime): void {
    const src = [...rt.state, ...this.proxyStateAt(t)];
    if (!src.length || src.length > this.cpTextures) return;
    while (this.cpFree.length + (this.cpTextures - this.cpUsed()) < src.length) this.evictCp();
    const targets = src.map(() => this.cpFree.pop() ?? this.be.target(this.w, this.h, 'rgba16f', 'checkpoint'));
    src.forEach((s, i) => this.be.blit(s, targets[i]));
    this.cps.set(t, { t, blockId: rt.blockId, targets, spilled: null, used: ++this.tick });
  }

  private cpUsed(): number { let n = this.cpFree.length; for (const c of this.cps.values()) n += c.targets.length; return n; }

  /** S2/F3: the least-recently-used checkpoint goes to disk, not away. A far seek reads it back. */
  private evictCp(): void {
    let lru: Checkpoint | null = null;
    for (const c of this.cps.values()) if (c.targets.length && (!lru || c.used < lru.used)) lru = c;
    if (!lru) throw new MoshpitError('GPU_VRAM_EXCEEDED', { why: 'checkpoint pool too small for one state' });
    const dir = path.join(this.o.cacheDir, 'checkpoints');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${process.pid}-${this.spillOwner}-${lru.t}.f32`);
    const buf = new Float32Array(this.w * this.h * 4), fd = fs.openSync(file, 'w');
    try { for (const t of lru.targets) { this.be.readFloat(t, buf); fs.writeSync(fd, new Uint8Array(buf.buffer)); } } finally { fs.closeSync(fd); }
    this.cpFree.push(...lru.targets);
    lru.targets = []; lru.spilled = file;
    this.stats.spills++;
    this.spillUsed += fs.statSync(file).size;
    // The A16 run filled the system disk with 33 GB of these: spill is bounded, oldest-first.
    const cap = this.o.spillBytes ?? 2 ** 31;
    while (this.spillUsed > cap) {
      let old: Checkpoint | null = null;
      for (const c of this.cps.values()) if (c.spilled && c !== lru && (!old || c.used < old.used)) old = c;
      if (!old) break;
      this.dropCp(old);
      this.stats.spillDrops++;
    }
  }

  private restoreCp(cp: Checkpoint, rt: BlockRuntime): void {
    const dst = [...rt.state, ...this.proxyStateAt(cp.t)];
    if (cp.spilled) {
      const buf = new Float32Array(this.w * this.h * 4), fd = fs.openSync(cp.spilled, 'r');
      try { dst.forEach((t, i) => { fs.readSync(fd, new Uint8Array(buf.buffer), 0, buf.byteLength, i * buf.byteLength); this.be.uploadFloat(t, buf); }); } finally { fs.closeSync(fd); }
      this.stats.unspills++;
    } else dst.forEach((t, i) => this.be.blit(cp.targets[i], t));
    for (const n of rt.nodes) n.resumed();
    cp.used = ++this.tick;
  }

  private dropCp(cp: Checkpoint): void {
    this.cpFree.push(...cp.targets);
    if (cp.spilled) { this.spillUsed -= fs.statSync(cp.spilled, { throwIfNoEntry: false })?.size ?? 0; fs.rmSync(cp.spilled, { force: true }); }
    this.cps.delete(cp.t);
  }

  /** Where replay must start so every piece of state is correct at `a`. */
  private stateStart(a: number): number {
    for (let c = a; c > 0; c--) {
      if (this.cps.has(c)) return c;
      const s = this.plan.blocks[this.spanOf[c]];
      const blockOk = c === s.start || !this.o.blockPlans.get(s.blockId)!.pastDependent;
      const proxyOk = !this.moshed || !this.rangeActive[c - 1];
      if (blockOk && proxyOk) return c;
    }
    return 0;
  }

  // ── rendering ──

  /** Render timeline frames [a, b]. Valid freezes are read from disk; everything else runs live. */
  async renderRange(a: number, b: number, ro: RenderOptions = {}): Promise<void> {
    checkAbort(ro.signal);
    if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= a && b < this.plan.frames)) throw new MoshpitError('RANGE_INVALID', { a, b, frames: this.plan.frames });
    // Scrub cache: a fully cached range is served without decoding anything.
    if (this.fcache.size && !ro.live) {
      let all = true;
      for (let t = a; t <= b && all; t++) all = this.fcache.has(t);
      if (all) { this.serveCached(a, b, ro); return; }
    }
    const segs: { a: number; b: number; frozen: ActiveFreeze | null }[] = [];
    for (let t = a; t <= b;) {
      const span = this.plan.blocks[this.spanOf[t]];
      const end = Math.min(b, span.end - 1);
      const fz = ro.live ? null : this.usableFreeze(span, t, end);
      const last = segs[segs.length - 1];
      if (!fz && last && !last.frozen) last.b = end; else segs.push({ a: t, b: end, frozen: fz });
      t = end + 1;
    }
    for (const s of segs) {
      checkAbort(ro.signal);
      if (s.frozen) await this.renderFrozen(s.frozen, s.a, s.b, ro);
      else await this.renderLive(s.a, s.b, ro);
    }
  }

  private async renderLive(a: number, b: number, ro: RenderOptions): Promise<void> {
    checkAbort(ro.signal);
    const refresh = this.paramRefresh;
    this.paramRefresh = null;
    if (!ro.live && a === b && refresh && refresh === this.forward && refresh.plan === this.plan &&
        refresh.through === a && this.decoder?.state === 'configured' && !this.decodeErr) {
      // lin still holds this frame (also for held slots). Recompute effects and replace the
      // invalidated output cache; leave nextT and the decoder reference chain untouched.
      this.ro = ro; this.gpuFrom = a; this.sinkFrom = a; this.sinkTo = a;
      try { this.processFrame(a); } catch (error) { this.forward = null; throw error; }
      finally { this.ro = {}; }
      return;
    }
    let lo = a, hi = b;
    if (ro.useCache && !ro.onFrame) {
      while (lo <= b && this.cached[lo]) lo++;
      while (hi >= lo && this.cached[hi]) hi--;
      this.stats.cacheHits += lo - a + (b - hi);
      if (lo > hi) return;
    }
    const P = this.plan;
    // GPU-proxy and forced live/export renders retain their established replay path.
    const preview = this.o.role === 'preview' && !this.moshed && !ro.live;
    const tail = this.forward;
    const resume = !ro.live && this.canContinue(lo);
    if (resume) this.stats.resumedRanges++;
    const c = resume ? tail!.through + 1 : this.stateStart(lo);
    const span = P.blocks[this.spanOf[c]];
    const rt0 = this.runtime(span.blockId);
    const cp = resume ? undefined : this.cps.get(c);
    if (cp && cp.blockId === span.blockId) this.restoreCp(cp, rt0);
    this.primeProxy = !(cp && this.rangeActive[c]);
    this.stats.replayed += lo - c;
    this.ro = ro; this.gpuFrom = c; this.sinkFrom = lo; this.sinkTo = hi;
    const needPrev = this.moshed !== null && c > 0;
    const k0 = resume ? tail!.sample + 1 : P.segStart[P.shown[needPrev ? c - 1 : c]];
    const k1 = P.shown[hi];
    if (!resume) this.nextT = this.nextShownT[k0];
    // On continuation lin already contains the preceding decoded picture, including
    // when the requested range consists entirely of held (removed-keyframe) slots.
    this.uploadFromK = P.shown[c > 0 ? c - 1 : 0];
    this.forward = null;
    this.decodeErr = null;
    if (!resume) {
      if (preview && this.decoder && this.decoder.state !== 'closed') { this.decoder.close(); this.decoder = null; }
      this.decodedThrough = -1;
      if (!this.decoder || this.decoder.state === 'closed') {
        const generation = this.decoderGeneration = (this.decoderGeneration ?? 0) + 1;
        this.decoder = new VideoDecoder({
          output: f => {
            if (generation !== this.decoderGeneration) { f.close(); return; }
            const k = f.timestamp;
            this.onDecoded(f);
            this.decodedThrough = k;
            this.outputWait?.();
          },
          error: e => { if (generation === this.decoderGeneration) { this.decodeErr = e; this.forward = null; this.outputWait?.(); } },
        });
      } else this.decoder.reset();
    }
    const startErrors = this.stats.orderErrors;
    const init = this.chunkInit, dec = this.decoder!;
    const stop = () => {
      this.decoding = false;
      this.forward = null;
      if (dec.state !== 'closed') dec.reset();
      if (preview) { this.decoderGeneration++; if (dec.state !== 'closed') dec.close(); this.decoder = null; }
    };
    ro.signal?.addEventListener('abort', stop, { once: true });
    this.decoding = true;
    let flushing = false;
    let flushed = false;
    try {
      checkAbort(ro.signal);
      if (!resume) dec.configure({ codec: P.codecString, codedWidth: P.width, codedHeight: P.height, description: P.avcC, hardwareAcceleration: this.o.decodeAccel ?? 'prefer-software', optimizeForLatency: true });
      let lap = performance.now();
      for (let k = k0; k <= k1; k++) {
        if ((k & 7) === 0) {
          if (ro.gate) await ro.gate();
          // A fast decoder may never hit backpressure. Yield occasionally so queued
          // cancellation messages can arrive, without changing export scheduling.
          if (ro.signal && performance.now() - lap >= 16) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            lap = performance.now();
          }
          checkAbort(ro.signal);
          if (dec.decodeQueueSize > 16) await drain(dec, ro.signal);
          checkAbort(ro.signal);
        }
        const s = P.samples[k];
        init.type = s.key ? 'key' : 'delta'; init.timestamp = k; init.data = sampleBytes(P, k);
        dec.decode(new EncodedVideoChunk(init));
        this.stats.decoded++;
      }
      // dequeue only means submissions were accepted, not that their output arrived.
      // Some decoder implementations withhold output; bounded waiting falls back to
      // the original flush path and deliberately forfeits continuation for that run.
      if (!preview || !(await this.waitForOutput(k1, ro.signal))) {
        flushing = true; flushed = true;
        if (preview) this.stats.previewFlushes++;
        await dec.flush();
      }
      checkAbort(ro.signal);
      this.holdsUntil(hi + 1);
    } catch (e) {
      stop();
      checkAbort(ro.signal);
      // Preserve a caller's gate/submission error (including export cancellation).
      if (!flushing && !this.decodeErr) throw e;
      throw new MoshpitError('DECODE_FAILED', { range: [a, b] }, this.decodeErr ?? e);
    } finally {
      ro.signal?.removeEventListener('abort', stop);
      this.decoding = false;
      this.ro = {};
    }
    if (this.decodeErr) throw new MoshpitError('DECODE_FAILED', { range: [a, b] }, this.decodeErr);
    if (this.stats.orderErrors !== startErrors || this.nextT !== hi + 1) throw new MoshpitError('DECODE_FRAMES_WITHHELD', { expectedEnd: hi + 1, ended: this.nextT, anomalies: this.anomalies.slice(-10) });
    if (preview && !flushed) this.forward = { plan: P, sample: k1, through: hi };
  }

  private waitForOutput(sample: number, signal?: AbortSignal): Promise<boolean> {
    if (this.decodeErr) return Promise.reject(this.decodeErr);
    if (this.decodedThrough >= sample) return Promise.resolve(true);
    const started = performance.now(), initial = this.decodedThrough;
    let last = initial, progress = 0;
    return new Promise((resolve, reject) => {
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout>;
      type Outcome = 'complete' | 'idle-timeout' | 'hard-timeout' | 'abort' | 'error';
      const finish = (outcome: Outcome, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer); clearTimeout(hardTimer);
        signal?.removeEventListener('abort', abort);
        if (this.outputWait === check) this.outputWait = null;
        if (this.cancelOutputWait === abort) this.cancelOutputWait = null;
        if (previewTimingOn) previewTiming({ ev: 'decoder.wait', requested: sample, initial,
          final: this.decodedThrough, progress, ms: Math.round(performance.now() - started), outcome });
        if (outcome === 'abort' || outcome === 'error') reject(error);
        else resolve(outcome === 'complete');
      };
      const abort = () => finish('abort', new DOMException('superseded', 'AbortError'));
      const check = () => {
        if (settled) return;
        if (this.decodeErr) { finish('error', this.decodeErr); return; }
        const advanced = this.decodedThrough > last;
        if (advanced) { last = this.decodedThrough; progress++; }
        if (this.decodedThrough >= sample) { finish('complete'); return; }
        // Input dequeue is not output progress. Only a new decoded sample extends
        // inactivity, and a separate hard deadline bounds a continuously slow tail.
        if (advanced) { clearTimeout(idleTimer); idleTimer = setTimeout(() => finish('idle-timeout'), 100); }
      };
      idleTimer = setTimeout(() => finish('idle-timeout'), 100);
      const hardTimer = setTimeout(() => finish('hard-timeout'), 1000);
      this.outputWait = check; this.cancelOutputWait = abort;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else check();
    });
  }

  /** Held slots have no sample: they show the last decoded picture, still sitting in `lin`. */
  private holdsUntil(target: number): void {
    while (this.nextT < target) {
      const t = this.nextT++;
      if (!this.plan.held[t]) { this.stats.orderErrors++; if (this.anomalies.length < 50) this.anomalies.push(['missing', t]); continue; }
      if (t >= this.gpuFrom && t <= this.sinkTo) this.processFrame(t);
    }
  }

  private onDecoded(frame: VideoFrame): void {
    if (!this.decoding || this.ro.signal?.aborted) { frame.close(); return; }
    const k = frame.timestamp;
    const s = this.plan.samples[k];
    this.holdsUntil(s.t >= 0 ? s.t : this.nextShownT[k]);
    const t = s.t;
    if (t < 0 || k < this.uploadFromK || t > this.sinkTo) { frame.close(); if (t >= 0) this.nextT = t + 1; return; }
    if (t !== this.nextT) { this.stats.orderErrors++; if (this.anomalies.length < 50) this.anomalies.push([this.nextT, t]); }
    this.nextT = t + 1;
    this.be.uploadFrame(this.src8, frame);
    frame.close(); // bounded decode window: a frame lives only as long as its upload
    this.be.draw(this.ingress, this.lin, null, this.src8);
    if (t < this.gpuFrom) { if (t === this.gpuFrom - 1 && this.primeProxy) this.proxy?.prime(this.lin); return; }
    this.processFrame(t);
  }

  private processFrame(t: number): void {
    const be = this.be;
    const span = this.plan.blocks[this.spanOf[t]];
    const rt = this.runtime(span.blockId);
    if (t === span.start) this.resetRuntime(rt); // S1: no checkpoint is ever saved at a span start
    if (t !== this.gpuFrom && t % this.cpEvery === 0 && t !== span.start && !this.cps.has(t) && (rt.stateful || (this.proxy && this.rangeActive[t]))) this.saveCp(t, rt);
    let input: Target = this.lin;
    if (this.proxy) {
      this.uProxy[0] = this.moshed!.proxyHold[t]; this.uProxy[1] = this.rangeActive[t];
      this.proxy.render([this.lin], this.proxyOut!, this.uProxy);
      input = this.proxyOut!;
    }
    const steps = rt.steps;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i], u = st.u;
      for (let j = 0; j < st.inSlots.length; j++) { const sl = st.inSlots[j]; st.inputs[j] = sl < 0 ? null : sl === rt.plan.decodeSlot ? input : rt.slotTargets[sl]; }
      for (let j = 0; j < st.params.length && j < 12; j++) resolveInto(st.params[j], t, u, j);
      seeded(this.o.seed, st.instHash, st.noiseHash, t, 0, this.uProxy);
      u[12] = this.uProxy[0]; u[13] = t; u[14] = 1 / this.w; u[15] = 1 / this.h;
      st.node.render(st.inputs, st.out, u);
      this.stats.stepPasses++;
    }
    for (let i = 0; i < rt.commits.length; i++) { const c = rt.commits[i]; be.blit(c.from === rt.plan.decodeSlot ? input : rt.slotTargets[c.from]!, c.to); }
    be.draw(this.egress, this.out8, null, rt.output ?? input);
    this.stats.gpuFrames++;
    if (t >= this.sinkFrom && t <= this.sinkTo) this.sink(t);
  }

  private sink(t: number): void {
    const ro = this.ro;
    if (ro.present) this.be.present(this.out8);
    const cap = this.o.role === 'preview' ? this.o.frameCacheBytes ?? 0 : 0;
    if (ro.hash || ro.onFrame || (cap > 0 && !this.fcache.has(t))) {
      this.be.readRGBA8(this.out8, this.px);
      hash53(this.px32, this.hashes, t);
      this.cached[t] = 1;
      if (cap > 0 && !this.fcache.has(t)) this.cacheFrame(t, cap);
      if (ro.onFrame) ro.onFrame(this.px, t);
    }
    this.stats.sinked++;
  }

  private cacheFrame(t: number, cap: number): void {
    if (this.px.length > cap) return;
    while (this.fcacheBytes + this.px.length > cap) {
      const [k, v] = this.fcache.entries().next().value as [number, Uint8Array];
      this.fcache.delete(k); this.fcacheBytes -= v.length;
    }
    this.fcache.set(t, this.px.slice());
    this.fcacheBytes += this.px.length;
  }

  private serveCached(a: number, b: number, ro: RenderOptions): void {
    for (let t = a; t <= b; t++) {
      checkAbort(ro.signal);
      const px = this.fcache.get(t)!;
      this.fcache.delete(t); this.fcache.set(t, px); // LRU touch
      if (ro.present) { this.be.uploadRGBA8(this.out8, px); this.be.present(this.out8); }
      if (ro.hash) { this.px.set(px); hash53(this.px32, this.hashes, t); this.cached[t] = 1; }
      if (ro.onFrame) ro.onFrame(px, t);
      this.stats.cacheHits++;
    }
  }

  // ── freeze (L25) ──

  freezeKeyFor(blockId: BlockId, a: number, b: number): string {
    const span = this.spanContaining(blockId, a, b);
    const block = this.blocksById.get(blockId)!;
    return freezeKey({ stage1: this.plan, span, plan: this.o.blockPlans.get(blockId)!, graph: graphHash(block, this.o.lfos, this.o.values ?? []), range: [a, b], seed: this.o.seed, bpm: this.o.bpm, fingerprint: this.fingerprint, format: `rgba8-${this.w}x${this.h}` });
  }

  private spanContaining(blockId: BlockId, a: number, b: number): BlockSpan {
    if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= a && b < this.plan.frames)) throw new MoshpitError('RANGE_INVALID', { a, b, frames: this.plan.frames });
    const first = this.spanOf[a], last = this.spanOf[b], s = this.plan.blocks[first];
    // The arrangement freezes the whole block, including repeats. Every covered span must
    // belong to that same contiguous block; a range must never absorb a neighbouring block.
    let end = s?.start;
    for (let i = first; i <= last; i++) {
      const span = this.plan.blocks[i];
      if (!span || span.blockId !== blockId || span.start !== end) throw new MoshpitError('RANGE_INVALID', { why: 'freeze range must stay within contiguous repetitions of one block', blockId, a, b });
      end = span.end;
    }
    if (!s || a < s.start || end === undefined || b >= end) throw new MoshpitError('RANGE_INVALID', { blockId, a, b });
    return s;
  }

  /** Bounce [a, b] of a block to a raw clip in the cache (F4: raw first). Returns whether it was a cache hit. */
  async freeze(blockId: BlockId, a: number, b: number, { force = false } = {}): Promise<{ key: string; hit: boolean; file: string }> {
    const key = this.freezeKeyFor(blockId, a, b);
    const dir = path.join(this.o.cacheDir, 'freeze');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${key}${force ? '-forced' : ''}.rgba`);
    const hit = !force && fs.existsSync(file) && fs.statSync(file).size === (b - a + 1) * this.fpx.length;
    if (!hit) {
      const tmp = `${file}.part`;
      const fh = await fs.promises.open(tmp, 'w');
      const [ow, oh] = [this.outW, this.outH];
      this.setOutputSize(this.w, this.h); // a freeze is always stored at working size
      // Phase 0.1b: frames are written in order through one promise chain instead of a blocking
      // writeSync each (8 MB a 1080p frame); the decode gate waits when more than 4 are behind.
      let chain: Promise<unknown> = Promise.resolve(), behind = 0;
      const write = (px: Uint8Array) => {
        const buf = Buffer.from(px); // the engine reuses its readback buffer
        behind++;
        chain = chain.then(() => fh.write(buf)).finally(() => behind--);
      };
      try {
        await this.renderRange(a, b, { live: true, onFrame: write, gate: async () => { if (behind > 4) await chain; } });
        await chain;
      } finally { await fh.close(); this.setOutputSize(ow, oh); }
      fs.renameSync(tmp, file); // atomic: a crash mid-bounce never leaves a short file under the real key
    }
    if (!force) {
      this.unfreeze(blockId);
      this.freezes.set(blockId, { key, a, b, file, fd: fs.openSync(file, 'r') });
    }
    return { key, hit, file };
  }

  /**
   * Re-open a recorded freeze (project load, engine rebuild) without rendering anything. A record
   * whose file is gone returns false: the UI offers to re-freeze; nothing is lost (L25, D5).
   */
  attachFreeze(blockId: BlockId, a: number, b: number, key: string): boolean {
    const file = path.join(this.o.cacheDir, 'freeze', `${key}.rgba`);
    if (!fs.existsSync(file) || fs.statSync(file).size !== (b - a + 1) * this.fpx.length) return false;
    this.unfreeze(blockId);
    this.freezes.set(blockId, { key, a, b, file, fd: fs.openSync(file, 'r') });
    return true;
  }

  /** The freeze state of a block for the UI badge (L25): none, fresh, or stale-but-playing. */
  freezeState(blockId: BlockId): 'none' | 'fresh' | 'stale' {
    return !this.freezes.has(blockId) ? 'none' : this.isStale(blockId) ? 'stale' : 'fresh';
  }

  unfreeze(blockId: BlockId): void {
    this.forward = null;
    const f = this.freezes.get(blockId);
    if (f) { fs.closeSync(f.fd); this.freezes.delete(blockId); }
  }

  isStale(blockId: BlockId): boolean {
    const f = this.freezes.get(blockId);
    return !!f && this.freezeKeyFor(blockId, f.a, f.b) !== f.key;
  }

  /** Preview plays a stale freeze (flagged); export never does (B2). */
  private usableFreeze(span: BlockSpan, a: number, b: number): ActiveFreeze | null {
    const f = this.freezes.get(span.blockId);
    if (!f || a < f.a || b > f.b) return null;
    if ((this.o.role ?? 'export') === 'export' && this.isStale(span.blockId)) return null;
    return f;
  }

  /**
   * Frames from a freeze file, in order. Phase 0.1b: it yields every ~16 ms and honours the
   * caller's gate (an export's encoder backpressure). A run of frozen frames (the scrub cache fills
   * 120 around the playhead) used to read, upload and read back in one block: up to ~1 s with the
   * worker frozen. The frames and their order are unchanged.
   */
  private async renderFrozen(f: ActiveFreeze, a: number, b: number, ro: RenderOptions): Promise<void> {
    this.forward = null;
    this.ro = ro; this.sinkFrom = a; this.sinkTo = b;
    const n = this.fpx.length;
    let lap = performance.now();
    try {
      for (let t = a; t <= b; t++) {
        if (((t - a) & 7) === 0 && ro.gate) await ro.gate();
        if (performance.now() - lap > 16) {
          await new Promise((r) => setTimeout(r, 0));
          lap = performance.now();
          this.ro = ro; this.sinkFrom = a; this.sinkTo = b; // still ours: the engine queue is serial
        }
        checkAbort(ro.signal);
        fs.readSync(f.fd, this.fpx, 0, n, (t - f.a) * n);
        this.be.uploadRGBA8(this.frozen8, this.fpx);
        this.be.copy(this.frozen8, this.out8);
        this.sink(t);
        this.stats.frozenFrames++;
      }
    } finally { this.ro = {}; }
  }

  dispose(): void {
    this.cancelOutputWait?.();
    this.forward = null; this.decoderGeneration++;
    for (const id of [...this.runtimes.keys()]) this.disposeRuntime(id);
    for (const f of this.freezes.values()) fs.closeSync(f.fd);
    for (const cp of this.cps.values()) if (cp.spilled) fs.rmSync(cp.spilled, { force: true });
    this.freezes.clear(); this.cps.clear();
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.be.dispose();
  }

  get gpu() { return { liveBytes: this.be.liveBytes, peakBytes: this.be.peakBytes, gpuName: this.be.gpuName, checkpoints: this.cps.size, spilled: [...this.cps.values()].filter((c) => c.spilled).length }; }
}
