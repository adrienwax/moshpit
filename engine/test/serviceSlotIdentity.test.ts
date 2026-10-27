// Service cache decisions only. The engine stub models its persistent attachments/frame cache;
// these tests do not exercise GPU rendering or establish pixel parity.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConformedSource, FreezeRecord, NodeId, ProjectDoc, SourceClip, SourceId } from '../src/model';
import type { EngineOptions } from '../src/runtime/engine';
import type { FrameTarget } from '../src/client';
import { EngineService } from '../src/service/service';
import { newBlock, newProject } from '../src/project/build';
import { compileProject } from '../src/runtime/session';

const observed = vi.hoisted(() => ({ options: [] as EngineOptions[], disposed: 0, updates: 0, alive: 0, peak: 0, height: undefined as number | undefined, rendered: [] as EngineOptions[], ranges: [] as { a: number; b: number; signal?: AbortSignal }[], warmFrom: 0, continuable: false, duringRender: undefined as (() => void) | undefined }));
vi.mock('../src/runtime/session', async original => ({
  ...await original<typeof import('../src/runtime/session')>(),
  compileProject: vi.fn((doc: ProjectDoc) => ({
    plan: { frames: 30, width: doc.settings.working.w, height: observed.height ?? doc.settings.working.h,
      blocks: [{ blockId: doc.timeline.blocks[0].id, kind: 'picture', start: 0, end: 30 }], moshRanges: [], held: [] },
    blockPlans: new Map(), close: vi.fn(),
  })),
}));
vi.mock('../src/runtime/engine', () => ({ Engine: class {
  w: number; h: number; outW: number; outH: number;
  hashes = new Float64Array(30);
  fingerprint = 'stub-fingerprint';
  attached = new Map<string, string>();
  cache: Uint8Array | undefined;
  cachedFrames = new Set<number>();
  dead = false;
  constructor(private options: EngineOptions) {
    observed.options.push(options);
    observed.peak = Math.max(observed.peak, ++observed.alive);
    this.w = this.outW = options.plan.width; this.h = this.outH = options.plan.height;
  }
  update() { if (this.dead) throw new Error('update after dispose'); observed.updates++; this.cachedFrames.clear(); }
  attachFreeze(block: string, _a: number, _b: number, key: string) { this.attached.set(block, key); return true; }
  unfreeze(block: string) { this.attached.delete(block); }
  freezeState(block: string) { return this.attached.has(block) ? 'stale' : 'none'; }
  async freeze(block: string) { this.attached.set(block, 'new-freeze'); return { key: 'new-freeze', hit: false, file: 'stub.rgba' }; }
  canContinue(_t: number) { return observed.continuable; }
  canWarmFrom(t: number) { return t >= observed.warmFrom; }
  hasCached(t: number) { if (this.dead) throw new Error('cache read after dispose'); return this.cachedFrames.has(t); }
  async renderRange(_a: number, _b: number, options: { signal?: AbortSignal; onFrame?(pixels: Uint8Array): void }) {
    if (this.dead) throw new Error('render after dispose');
    observed.ranges.push({ a: _a, b: _b, signal: options.signal });
    observed.duringRender?.();
    options.signal?.throwIfAborted();
    observed.rendered.push(this.options);
    // Like the real engine, cache lookup precedes freeze lookup and update() alone can leave it.
    this.cache ??= new Uint8Array([this.attached.size ? 9 : 1]);
    for (let t = _a; t <= _b; t++) this.cachedFrames.add(t);
    options.onFrame?.(this.cache);
  }
  dispose() { if (this.dead) throw new Error('double dispose'); this.dead = true; observed.alive--; observed.disposed++; this.attached.clear(); this.cache = undefined; }
} }));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3-slot-identity-'));
const proxyPath = path.join(dir, 'stub-proxy.mp4'); fs.writeFileSync(proxyPath, 'stub');
const services: EngineService[] = [];
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => { for (const svc of services.splice(0)) svc.dispose(); });
beforeEach(() => { observed.options.length = 0; observed.rendered.length = 0; observed.ranges.length = 0; observed.duringRender = undefined; observed.warmFrom = 0; observed.continuable = false; observed.disposed = 0; observed.updates = 0; observed.alive = 0; observed.peak = 0; observed.height = undefined; vi.mocked(compileProject).mockClear(); });
function setup() {
  const doc = newProject('slot', { working: { w: 640, h: 360 } });
  doc.timeline.blocks = [newBlock('picture', 'source' as SourceId, 0, 30)];
  doc.resources.sources = [{ id: 'source', conformId: 'conform' } as SourceClip];
  doc.resources.conforms = [{ id: 'conform', sourceId: 'source', path: proxyPath, frames: 30, keyframes: [0], status: 'ready', proxy: { path: proxyPath } } as ConformedSource];
  const svc = new EngineService({ cacheDir: dir });
  services.push(svc);
  const frame = () => svc.frame({ kind: 'output', frame: 0 }, { w: 640, h: 360 });
  const record = (key = 'old-freeze'): FreezeRecord => ({ id: 'freeze-1', target: { kind: 'block', blockId: doc.timeline.blocks[0].id }, range: [0, 29], key, codec: 'raw-rgba8', fingerprint: 'old', createdAt: '2026-10-10' }) as FreezeRecord;
  return { svc, doc, frame, record };
}

describe('preview service slot identity', () => {
  it.each(['absent', 'missing-file'])('falls back to the master for an %s proxy in interactive Auto', async mode => {
    const { svc, doc } = setup();
    doc.resources.conforms[0].proxy = mode === 'absent' ? undefined : { path: path.join(dir, 'missing.mp4'), width: 160, height: 90, conformedHash: 'missing' };
    svc.updateProject(doc);
    const result = await svc.frame({ kind: 'output', frame: 4 }, { w: 640, h: 360, interactive: true });
    expect(result.route).toContain('master');
    expect(vi.mocked(compileProject).mock.calls.at(-1)?.[1]?.variant).toBe('master');
  });

  it.each(['absent', 'missing-file'])('uses available masters for small source/node/scope/trial views with an %s proxy', async mode => {
    const { svc, doc } = setup();
    doc.resources.conforms[0].proxy = mode === 'absent' ? undefined : { path: path.join(dir, 'missing.mp4'), width: 160, height: 90, conformedHash: 'missing' };
    svc.updateProject(doc);
    const block = doc.timeline.blocks[0];
    const targets: FrameTarget[] = [
      { kind: 'source', sourceId: block.sourceId, frame: 4 },
      { kind: 'node', blockId: block.id, nodeId: block.graph.nodes[0].id, frame: 4 },
      { kind: 'output', frame: 4 },
      { kind: 'trial', blockId: block.id, graph: block.graph, frame: 4 },
    ];
    for (const target of targets) {
      expect((await svc.frame(target, { w: 160, h: 90 })).route).toContain('master');
      expect(vi.mocked(compileProject).mock.calls.at(-1)?.[1]?.variant).toBe('master');
    }
  });

  it('uses a proxy for a wide interactive Auto request and keeps Full explicit', async () => {
    const { svc, doc } = setup(); svc.updateProject(doc);
    const target = { kind: 'output', frame: 4 } as const;
    expect((await svc.frame(target, { w: 640, h: 360, interactive: true })).route).toContain('proxy');
    expect(vi.mocked(compileProject).mock.calls.at(-1)?.[1]?.variant).toBe('proxy');
    expect((await svc.frame(target, { w: 640, h: 360, quality: 'full', interactive: true })).route).toContain('master');
    expect(vi.mocked(compileProject).mock.calls.at(-1)?.[1]?.variant).toBe('master');
  });

  it('serves a current cached master immediately but never reuses it after a project edit', async () => {
    const { svc, doc } = setup(); svc.updateProject(doc);
    const target = { kind: 'output', frame: 4 } as const;
    await svc.frame(target, { w: 640, h: 360, quality: 'full' });
    expect((await svc.frame(target, { w: 640, h: 360, interactive: true })).route).toContain('master');
    expect(observed.options).toHaveLength(1);
    svc.updateProject({ ...doc, name: 'edited' });
    expect((await svc.frame(target, { w: 640, h: 360, interactive: true })).route).toContain('proxy');
  });

  it('does not substitute an unfrozen interactive proxy inside a recorded output freeze', async () => {
    const { svc, doc, record } = setup(); doc.freezes = [record()]; svc.updateProject(doc);
    const result = await svc.frame({ kind: 'output', frame: 4 }, { w: 640, h: 360, interactive: true });
    expect(result.route).toContain('master'); expect(result.freeze).toBe('stale'); expect(result.data[0]).toBe(9);
  });

  it('keeps audition identity at the original viewport width and checks its graph before reusing a master', async () => {
    const { svc, doc } = setup(); svc.updateProject(doc);
    const target = { kind: 'trial', frame: 4, blockId: doc.timeline.blocks[0].id, graph: doc.timeline.blocks[0].graph } as const;
    const size = { w: 640, h: 360 };
    await svc.frame(target, { ...size, quality: 'full' });
    expect((await svc.frame(target, { ...size, interactive: true })).route).toContain('master');
    const changed = { ...target, graph: { ...target.graph, nodes: target.graph.nodes.map(n => ({ ...n, label: 'changed' })) } };
    expect((await svc.frame(changed, { ...size, interactive: true })).route).toContain('proxy');
    const thumb = { ...size, w: 160, h: 90 };
    await svc.frame(target, { ...thumb, quality: 'full' });
    expect(observed.options).toHaveLength(3); // audition master/proxy and separate thumbnail master
    expect((await svc.frame(target, { ...size, interactive: true })).route).toContain('master');
  });

  it.each([
    { w: 1920, h: 1080, bytes: undefined, capacity: 16 },
    { w: 3840, h: 2160, bytes: undefined, capacity: 4 },
    { w: 480, h: 270, bytes: undefined, capacity: 258 },
    { w: 1920, h: 1080, bytes: 0, capacity: 0 },
    { w: 1920, h: 1080, bytes: 100, capacity: 0 },
    { w: 1920, h: 1080, bytes: 1920 * 1080 * 4, capacity: 1 },
    { w: 1920, h: 1080, bytes: 1920 * 1080 * 4 * 3, capacity: 3 },
  ])('fits warm-up around the requested frame within $capacity cached frames ($w x $h)', async ({ w, h, bytes, capacity }) => {
    const doc = newProject('warm cache', { working: { w, h } });
    doc.timeline.blocks = [newBlock('picture', 'source' as SourceId, 0, 30)];
    const svc = new EngineService({ cacheDir: dir, frameCacheBytes: bytes }); services.push(svc); svc.updateProject(doc);
    // Small requested viewer still caches full engine-size pixels before the worker fits them.
    await svc.frame({ kind: 'output', frame: 15 }, { w: 160, h: 90, quality: 'full' });
    for (let n = 0; await svc.idle(); n++) expect(n).toBeLessThan(12);
    const ranges = observed.ranges;
    const requests = ranges.flatMap(r => Array.from({ length: r.b - r.a + 1 }, (_, i) => r.a + i));
    expect(requests.length).toBeLessThanOrEqual(Math.max(1, Math.min(30, capacity)));
    expect(requests.every(t => t >= 0 && t < 30)).toBe(true);
    if (capacity <= 1) expect(ranges).toHaveLength(1);
    // Reproduce the runtime's byte-limited LRU using actual service render ranges. The old
    // fixed window evicted frame 15 in this model for full-HD/4K/small explicit budgets.
    const lru = new Set<number>();
    for (const frame of requests) {
      if (!capacity) continue;
      lru.delete(frame); lru.add(frame);
      while (lru.size > capacity) lru.delete(lru.values().next().value!);
    }
    if (capacity) expect(lru.has(15)).toBe(true);
  });

  it('rejects an already superseded frame without allocating an engine', async () => {
    const { svc, doc } = setup(); svc.updateProject(doc);
    const ac = new AbortController(); ac.abort();
    await expect(svc.frame({ kind: 'output', frame: 4 }, { w: 640, h: 360 }, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(observed.options).toHaveLength(0);
  });

  it('passes active frame cancellation to the renderer without scheduling stale fill work', async () => {
    const { svc, doc } = setup(); svc.updateProject(doc);
    const ac = new AbortController(); observed.duringRender = () => ac.abort();
    await expect(svc.frame({ kind: 'output', frame: 4 }, { w: 640, h: 360 }, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(observed.ranges[0].signal).toBe(ac.signal);
    expect(await svc.idle()).toBe(false);
  });

  it('does not skip an interrupted cache-fill range when idle resumes', async () => {
    const { svc, doc, frame } = setup(); svc.updateProject(doc); await frame();
    const ac = new AbortController(); observed.duringRender = () => ac.abort();
    await expect(svc.idle(12, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(observed.ranges.at(-1)).toEqual({ a: 1, b: 12, signal: ac.signal });
    observed.duringRender = undefined;
    expect(await svc.idle(12)).toBe(true);
    expect(observed.ranges.at(-1)).toEqual({ a: 1, b: 12, signal: undefined });
  });

  it('bounds repeated node/source navigation before allocation, then reopens evicted targets correctly', async () => {
    const { svc, doc } = setup();
    for (let i = 0; i < 20; i++) {
      doc.resources.sources.push({ id: `source-${i}`, conformId: `conform-${i}` } as SourceClip);
      doc.resources.conforms.push({ id: `conform-${i}`, sourceId: `source-${i}`, frames: 30, keyframes: [0], status: 'ready' } as ConformedSource);
    }
    svc.updateProject(doc);
    const blockId = doc.timeline.blocks[0].id;
    for (let i = 0; i < 20; i++) {
      await svc.frame({ kind: 'node', blockId, nodeId: `node-${i}` as NodeId, frame: 5 }, { w: 640, h: 360 });
      expect(vi.mocked(compileProject).mock.calls.at(-1)?.[1]?.viewer).toEqual({ blockId, nodeId: `node-${i}` });
      await svc.frame({ kind: 'source', sourceId: `source-${i}` as SourceId, frame: 7 }, { w: 640, h: 360 });
      expect(observed.rendered.at(-1)?.blocks[0].sourceId).toBe(`source-${i}`);
    }
    expect(observed.peak).toBe(6);
    expect(observed.alive).toBe(6);
    expect(observed.disposed).toBe(34);
    expect(observed.options.every(o => o.frameCacheBytes === 128 << 20)).toBe(true);
    const firstCompiled = vi.mocked(compileProject).mock.results[0].value;
    expect(firstCompiled.close).toHaveBeenCalledOnce();
    await svc.frame({ kind: 'node', blockId, nodeId: 'node-0' as NodeId, frame: 5 }, { w: 640, h: 360 });
    expect(vi.mocked(compileProject).mock.calls.at(-1)?.[1]?.viewer).toEqual({ blockId, nodeId: 'node-0' });
    expect(observed.options).toHaveLength(41);
    await svc.idle(); // The new target's fill must never run on the evicted decoder.
    expect(observed.rendered.at(-1)).toBe(observed.options.at(-1));
  });

  it('keeps recently used program and selected-node slots when source/node browsing evicts older entries', async () => {
    const { svc, doc, frame } = setup(); svc.updateProject(doc);
    const blockId = doc.timeline.blocks[0].id;
    const node = (i: number) => svc.frame({ kind: 'node', blockId, nodeId: `node-${i}` as NodeId, frame: 0 }, { w: 640, h: 360 });
    await frame();
    for (let i = 0; i < 5; i++) await node(i);
    await frame(); await node(0); // Touch the two oldest: node-1 now becomes LRU.
    await node(5);
    expect(observed.options).toHaveLength(7);
    await frame(); await node(0);
    expect(observed.options).toHaveLength(7);
    await node(1);
    expect(observed.options).toHaveLength(8);
    expect(observed.peak).toBe(6);
  });

  it('shares one retention limit across master/proxy variants and restores recorded freezes after eviction', async () => {
    const { svc, doc, frame, record } = setup();
    doc.freezes = [record()]; svc.updateProject(doc);
    expect((await frame()).freeze).toBe('stale');
    for (let i = 0; i < 4; i++) for (const w of [100, 640]) {
      await svc.frame({ kind: 'node', blockId: doc.timeline.blocks[0].id, nodeId: `node-${i}` as NodeId, frame: 0 }, { w, h: Math.round(w * 9 / 16) });
    }
    expect(observed.peak).toBe(6);
    const returned = await frame();
    expect(returned.freeze).toBe('stale');
    expect(returned.data[0]).toBe(9);
    expect(observed.options).toHaveLength(10);
  });

  it('drops all retained resources and the idle window on project replacement', async () => {
    const { svc, doc, frame } = setup(); svc.updateProject(doc);
    await frame();
    await svc.frame({ kind: 'node', blockId: doc.timeline.blocks[0].id, nodeId: 'other' as NodeId, frame: 0 }, { w: 640, h: 360 });
    svc.updateProject({ ...doc, id: 'different' as ProjectDoc['id'] });
    expect(observed.alive).toBe(0);
    expect(await svc.idle()).toBe(false);
    await frame(); expect(observed.alive).toBe(1);
  });

  it('releasing a trial clears its pending fill without disposing the independent program slot', async () => {
    const { svc, doc, frame } = setup(); svc.updateProject(doc);
    await frame();
    const b = doc.timeline.blocks[0];
    await svc.frame({ kind: 'trial', blockId: b.id, graph: b.graph, frame: 0 }, { w: 640, h: 360 });
    svc.releaseTrials('audition');
    expect(observed.alive).toBe(1);
    expect(await svc.idle()).toBe(false);
    await frame(); expect(observed.options).toHaveLength(2);
    svc.dispose();
    expect(observed.alive).toBe(0);
    expect(await svc.idle()).toBe(false);
  });

  it('Full preview selects the master even in a small panel; Auto can choose a proxy', async () => {
    const { svc, doc } = setup();
    doc.settings.working = { w: 1920, h: 1080 };
    svc.updateProject(doc);
    await svc.frame({ kind: 'output', frame: 0 }, { w: 320, h: 180 });
    expect(vi.mocked(compileProject).mock.calls.at(-1)?.[1]?.variant).toBe('proxy');
    const full = await svc.frame({ kind: 'output', frame: 0 }, { w: 320, h: 180, quality: 'full' });
    expect(vi.mocked(compileProject).mock.calls.at(-1)?.[1]?.variant).toBe('master');
    expect(full.route).toContain('1920×1080 master');
  });
  it('Unfreeze clears an attached stale freeze and its cached frames; Undo attaches it again', async () => {
    const { svc, doc, frame, record } = setup();
    doc.freezes = [record()]; svc.updateProject(doc);
    expect((await frame()).data[0]).toBe(9);
    const unfrozen = { ...doc, freezes: [] };
    svc.updateProject(unfrozen);
    const live = await frame();
    expect(live.freeze).toBeUndefined();
    expect(live.data[0]).toBe(1);
    expect(observed.disposed).toBe(1);
    svc.updateProject(doc);
    const restored = await frame();
    expect(restored.freeze).toBe('stale');
    expect(restored.data[0]).toBe(9);
    expect(observed.options).toHaveLength(3);
  });

  it('rebuilds when the freeze key or range changes even with identical timeline dimensions', async () => {
    const { svc, doc, frame, record } = setup();
    doc.freezes = [record()]; svc.updateProject(doc); await frame();
    const next = { ...doc, freezes: [{ ...record('replacement'), range: [2, 20] as [number, number] }] };
    svc.updateProject(next); await frame();
    expect(observed.options).toHaveLength(2);
    expect(observed.updates).toBe(0);
  });

  it('a produced freeze stays inactive until its document record is committed', async () => {
    const { svc, doc, frame } = setup();
    svc.updateProject(doc);
    const record = await svc.freeze({ kind: 'block', blockId: doc.timeline.blocks[0].id }, [0, 29]);
    expect((await frame()).freeze).toBeUndefined();
    svc.updateProject({ ...doc, freezes: [record] });
    expect((await frame()).freeze).toBe('stale');
  });

  it('a discarded freeze result cannot leave a ghost attachment after an edit or project replacement', async () => {
    const { svc, doc, frame } = setup();
    svc.updateProject(doc);
    await svc.freeze({ kind: 'block', blockId: doc.timeline.blocks[0].id }, [0, 29]);
    svc.updateProject({ ...doc, name: 'edited before UI callback' });
    expect((await frame()).freeze).toBeUndefined();
    svc.updateProject({ ...doc, id: 'replacement-project' as ProjectDoc['id'] });
    expect((await frame()).freeze).toBeUndefined();
  });

  it.each(['bpm', 'seed', 'fps'] as const)('recreates constructor settings after a %s change', async setting => {
    const { svc, doc, frame } = setup();
    svc.updateProject(doc); await frame();
    const settings = { ...doc.settings, ...(setting === 'fps' ? { fps: { num: 25, den: 1 } } : { [setting]: doc.settings[setting] + 17 }) };
    svc.updateProject({ ...doc, settings }); await frame();
    expect(observed.options).toHaveLength(2);
    expect(observed.disposed).toBe(1);
    expect(observed.options[1]).toMatchObject({ bpm: settings.bpm, seed: settings.seed });
  });

  it('rebuilds for a changed compiled height even when width, frame count and settings match', async () => {
    const { svc, doc, frame } = setup();
    svc.updateProject(doc); await frame();
    observed.height = 480;
    svc.updateProject(doc);
    expect((await frame()).h).toBe(480);
    expect(observed.options).toHaveLength(2);
  });

  it('keeps fast reuse for ordinary edits with unchanged settings and freeze records', async () => {
    const { svc, doc, frame } = setup();
    svc.updateProject(doc); await frame();
    svc.updateProject({ ...doc, name: 'renamed' }); await frame();
    expect(observed.options).toHaveLength(1);
    expect(observed.updates).toBe(1);
    expect(observed.disposed).toBe(0);
  });

  it('reads ahead only for a Program request the UI marks as playback', async () => {
    const { svc, doc } = setup(); svc.updateProject(doc);
    const size = { w: 640, h: 360, interactive: true };
    await svc.frame({ kind: 'output', frame: 2 }, size); // paused seek: one frame
    await svc.frame({ kind: 'output', frame: 4 }, { ...size, playback: true }); // play tick: reads ahead
    await svc.frame({ kind: 'output', frame: 12 }, { w: 640, h: 360, playback: true }); // not Program (master slot): never
    await svc.frame({ kind: 'trial', blockId: doc.timeline.blocks[0].id, graph: doc.timeline.blocks[0].graph, frame: 2 }, { ...size, playback: true }); // not output: never
    expect(observed.ranges.map(({ a, b }) => [a, b])).toEqual([[2, 2], [4, 29], [12, 12], [2, 2]]);
    const before = observed.ranges.length;
    expect((await svc.frame({ kind: 'output', frame: 5 }, { ...size, playback: true })).data).toBeDefined(); // cached by the read-ahead
    expect(observed.ranges.length).toBe(before + 1);
    expect(observed.ranges.at(-1)).toMatchObject({ a: 5, b: 5 });
  });

  it('returns a continuing playback frame without first rendering a batch of future frames', async () => {
    const { svc, doc } = setup(); svc.updateProject(doc);
    observed.continuable = true;
    const size = { w: 640, h: 360, interactive: true, playback: true };
    await svc.frame({ kind: 'output', frame: 4 }, size);
    await svc.frame({ kind: 'output', frame: 6 }, size);
    expect(observed.ranges.map(({ a, b }) => [a, b])).toEqual([[4, 4], [6, 6]]);
    // Losing continuation retains the bounded fallback used by non-continuing decoders.
    observed.continuable = false;
    await svc.frame({ kind: 'output', frame: 8 }, size);
    expect(observed.ranges.at(-1)).toMatchObject({ a: 8, b: 29 });
  });

  // Before the explicit playback flag, read-ahead was inferred from a Program request 1–120 frames
  // after the previous one, so the first paused step or short forward seek also rendered 120 frames
  // ahead (draft 185 → 448 ms, measured). Paused requests now never read ahead.
  it('never reads ahead for a short forward seek or step while paused', async () => {
    const { svc, doc } = setup(); svc.updateProject(doc);
    const paused = (frame: number) => svc.frame({ kind: 'output', frame }, { w: 640, h: 360, interactive: true });
    await paused(3); await paused(4); await paused(9); await paused(10);
    expect(observed.ranges.map(({ a, b }) => [a, b])).toEqual([[3, 3], [4, 4], [9, 9], [10, 10]]);
  });
});


it('background fill preserves an intact forward decoder instead of rewinding for old neighbours', async () => {
  const { svc, doc } = setup(); svc.updateProject(doc);
  await svc.frame({ kind: 'output', frame: 15 }, { w: 640, h: 360 });
  observed.warmFrom = 16;
  for (let n = 0; await svc.idle(); n++) expect(n).toBeLessThan(5);
  expect(observed.ranges.slice(1).every(range => range.a >= 16)).toBe(true);
  expect(observed.ranges.slice(1).length).toBeGreaterThan(0);
  // Foreground backward requests remain exact, never replaced by a nearby cached image.
  await svc.frame({ kind: 'output', frame: 4 }, { w: 640, h: 360 });
  expect(observed.ranges.at(-1)).toMatchObject({ a: 4, b: 4 });
});


it('range scopes keep their own decoder slot and cannot replace Program idle warming', async () => {
  const { svc, doc } = setup(); svc.updateProject(doc);
  const size = { w: 640, h: 360 };
  await svc.frame({ kind: 'output', frame: 15 }, size);
  const program = observed.rendered.at(-1);
  await svc.frame({ kind: 'output', frame: 2 }, { ...size, priority: 'background' });
  const scope = observed.rendered.at(-1);
  expect(scope).not.toBe(program);
  await svc.frame({ kind: 'output', frame: 4 }, { ...size, priority: 'background' });
  expect(observed.rendered.at(-1)).toBe(scope);
  await svc.idle();
  expect(observed.rendered.at(-1)).toBe(program);
  expect(observed.ranges.at(-1)).toMatchObject({ a: 16, b: 27 });
});

it('isolated full scopes retain timeline freeze attachments and rebuild them when freezes change', async () => {
  const { svc, doc, record } = setup(); doc.freezes = [record()]; svc.updateProject(doc);
  const target = { kind: 'output', frame: 4 } as const;
  const size = { w: 640, h: 360, quality: 'full', priority: 'background' } as const;
  expect((await svc.frame(target, size)).data[0]).toBe(9);
  const first = observed.rendered.at(-1);
  svc.updateProject({ ...doc, freezes: [] });
  expect((await svc.frame(target, size)).data[0]).toBe(1);
  expect(observed.rendered.at(-1)).not.toBe(first);
});

it('selected-node scopes cannot rewind a visible node viewer decoder', async () => {
  const { svc, doc } = setup(); svc.updateProject(doc);
  const target = { kind: 'node', blockId: doc.timeline.blocks[0].id, nodeId: 'viewer' as NodeId, frame: 15 } as const;
  const size = { w: 640, h: 360 };
  await svc.frame(target, size); const viewer = observed.rendered.at(-1);
  await svc.frame({ ...target, frame: 2 }, { ...size, priority: 'background' });
  expect(observed.rendered.at(-1)).not.toBe(viewer);
  await svc.frame({ ...target, frame: 16 }, size);
  expect(observed.rendered.at(-1)).toBe(viewer);
});
