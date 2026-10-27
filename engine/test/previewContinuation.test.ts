// Real Engine scheduling with deterministic decoder/GPU doubles. Native pixel parity
// is a separate gate: these tests prove submission, state-order and cancellation rules.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/runtime/engine';
import { newBlock, withChain } from '../src/project/build';
import { compileBlockGraph } from '../src/graph/stage2';
const timing = vi.hoisted(() => ({ previewTimingOn: true, previewTiming: vi.fn() }));
vi.mock('../src/telemetry/previewTiming', () => timing);
vi.mock('../src/timeline/stage1', async original => ({
  ...await original<typeof import('../src/timeline/stage1')>(), sampleBytes: () => new Uint8Array([1]),
}));
class Decoder extends EventTarget {
  state = 'unconfigured'; decodeQueueSize = 0; submissions: number[] = [];
  configurations = 0; flushes = 0; resets = 0;
  mode: 'immediate' | 'buffered' | 'waiting' = 'immediate';
  pending: number[] = [];
  constructor(readonly callbacks: VideoDecoderInit) { super(); }
  configure() { this.state = 'configured'; this.configurations++; }
  reset() { this.state = 'unconfigured'; this.resets++; this.pending = []; }
  close() { this.state = 'closed'; this.pending = []; }
  emit(timestamp: number) { const frame = { timestamp, close: vi.fn() }; this.callbacks.output(frame as unknown as VideoFrame); return frame; }
  decode(chunk: EncodedVideoChunk) {
    this.submissions.push(chunk.timestamp);
    if (this.mode === 'immediate') this.emit(chunk.timestamp); else this.pending.push(chunk.timestamp);
  }
  async flush() { this.flushes++; for (const k of this.pending.splice(0)) this.emit(k); }
}
function setup(frames = 40, role: 'preview' | 'export' = 'preview') {
  const decoders: Decoder[] = [];
  let mode: Decoder['mode'] = 'immediate';
  vi.stubGlobal('VideoDecoder', class extends Decoder { constructor(callbacks: VideoDecoderInit) { super(callbacks); this.mode = mode; decoders.push(this); } });
  vi.stubGlobal('EncodedVideoChunk', class { timestamp: number; constructor(init: EncodedVideoChunkInit) { this.timestamp = init.timestamp; } });
  const e = Object.create(Engine.prototype) as any;
  const span = { start: 0, end: frames, blockId: 'block' };
  const processed: number[] = [];
  let state = 0;
  Object.assign(e, {
    plan: { frames, width: 1, blocks: [span], samples: Array.from({ length: frames }, (_, t) => ({ t, key: t === 0 })),
      segStart: new Int32Array(frames), shown: Int32Array.from({ length: frames }, (_, i) => i), held: new Uint8Array(frames), frameKey: new Float64Array(frames), moshRanges: [] },
    spanOf: new Int32Array(frames), nextShownT: Int32Array.from({ length: frames }, (_, i) => i),
    rangeActive: new Uint8Array(frames), cps: new Map(), fcache: new Map(), runtimes: new Map(), blocksById: new Map(), pool: [{}],
    cached: new Uint8Array(frames), moshed: null, decoder: null, o: { role, lfos: [] }, ro: {}, decoding: false,
    decoderGeneration: 0, decodedThrough: -1, forward: null, freezes: new Map(),
    chunkInit: {}, anomalies: [], stats: { resumedRanges: 0, previewFlushes: 0, replayed: 0, decoded: 0, orderErrors: 0, cacheHits: 0, frozenFrames: 0 },
    stateStart: () => 0, runtime: () => ({}), usableFreeze: () => null,
    be: { uploadFrame: vi.fn(), draw: vi.fn(), uploadRGBA8: vi.fn(), copy: vi.fn(), dispose: vi.fn(), release: vi.fn(), target: vi.fn() },
    processFrame: (t: number) => { if (t === 0) state = 0; state = (state * 31 + t + 1) >>> 0; processed.push(t); }, sink: vi.fn(),
  });
  return { e, decoders, processed, state: () => state, mode: (m: Decoder['mode']) => { mode = m; if (decoders.length) decoders.at(-1)!.mode = m; } };
}
beforeEach(() => { timing.previewTiming.mockClear(); timing.previewTimingOn = true; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('exact forward preview continuation', () => {
  it('decodes a long chain once, then only new samples for adjacent and gapped seeks', async () => {
    const f = setup(3100);
    await f.e.renderRange(3000, 3000); await f.e.renderRange(3001, 3001); await f.e.renderRange(3006, 3006);
    expect(f.decoders).toHaveLength(1); expect(f.decoders[0].submissions).toHaveLength(3007);
    expect(f.decoders[0].configurations).toBe(1); expect(f.decoders[0].flushes).toBe(0);
    expect(f.e.stats.resumedRanges).toBe(2); expect(f.e.stats.previewFlushes).toBe(0);
    expect(f.processed).toEqual(Array.from({ length: 3007 }, (_, i) => i));
    const sequential = setup(3100); await sequential.e.renderRange(0, 3006);
    expect(f.state()).toBe(sequential.state());
  });
  it('shares a non-mutating eligibility check with playback scheduling', async () => {
    const f = setup(200);
    expect(f.e.canContinue(5)).toBe(false);
    await f.e.renderRange(4, 4); const tail = f.e.forward;
    expect(f.e.canContinue(5)).toBe(true); expect(f.e.canContinue(124)).toBe(true);
    expect(f.e.canContinue(125)).toBe(false); expect(f.e.canContinue(4)).toBe(false); expect(f.e.canContinue(3)).toBe(false);
    expect(f.e.forward).toBe(tail);
    const plan = f.e.plan; f.e.plan = { ...plan }; expect(f.e.canContinue(5)).toBe(false); f.e.plan = plan;
    f.e.decodeErr = new Error('lost decoder'); expect(f.e.canContinue(5)).toBe(false); f.e.decodeErr = null;
    f.e.moshed = plan; expect(f.e.canContinue(5)).toBe(false); f.e.moshed = null;
    f.e.o.role = 'export'; expect(f.e.canContinue(5)).toBe(false); f.e.o.role = 'preview';
    f.decoders[0].state = 'closed'; expect(f.e.canContinue(5)).toBe(false); f.decoders[0].state = 'configured';
    await f.e.renderRange(5, 5); expect(f.decoders[0].submissions).toHaveLength(6);
    expect(f.e.canContinue(6)).toBe(true);
  });
  it('uses the seek path for distant scrubs instead of replaying the entire GPU gap', async () => {
    const f = setup(300); f.e.stateStart = (t: number) => t;
    await f.e.renderRange(3, 3); await f.e.renderRange(200, 200);
    expect(f.decoders).toHaveLength(2); expect(f.processed).toEqual([3, 200]);
  });
  it('keeps the cursor on cache hits and refuses backward background warming', async () => {
    const f = setup(); await f.e.renderRange(8, 12);
    const tail = f.e.forward; f.e.fcache.set(10, new Uint8Array(4)); f.e.serveCached = vi.fn();
    await f.e.renderRange(10, 10); expect(f.e.forward).toBe(tail);
    expect(f.e.canWarmFrom(9)).toBe(false); expect(f.e.canWarmFrom(12)).toBe(false); expect(f.e.canWarmFrom(13)).toBe(true);
    await f.e.renderRange(13, 15, { fill: true }); expect(f.decoders[0].submissions).toHaveLength(16);
    await f.e.renderRange(3, 3); expect(f.decoders).toHaveLength(2); expect(f.decoders[0].state).toBe('closed');
    expect(f.decoders[1].submissions).toEqual([0, 1, 2, 3]);
  });
  it('advances held slots without decoding again and retains the preceding picture', async () => {
    const f = setup(3);
    f.e.plan.samples = [{ t: 0, key: true }, { t: 2, key: false }];
    f.e.plan.shown = new Int32Array([0, 0, 1]); f.e.plan.held = new Uint8Array([0, 1, 0]); f.e.nextShownT = new Int32Array([0, 2]);
    await f.e.renderRange(0, 0); await f.e.renderRange(1, 1); await f.e.renderRange(2, 2);
    expect(f.decoders[0].submissions).toEqual([0, 1]); expect(f.processed).toEqual([0, 1, 2]);
    expect(f.e.be.uploadFrame).toHaveBeenCalledTimes(2);
  });
  it('flushes buffered output after a bounded wait and never resumes its invalid reference chain', async () => {
    vi.useFakeTimers(); const f = setup(); f.mode('buffered');
    const first = f.e.renderRange(4, 4); await vi.advanceTimersByTimeAsync(101); await first;
    expect(f.decoders[0].flushes).toBe(1); expect(f.e.stats.previewFlushes).toBe(1); expect(f.e.forward).toBeNull(); expect(f.e.canContinue(5)).toBe(false);
    const second = f.e.renderRange(5, 5); await vi.advanceTimersByTimeAsync(101); await second;
    expect(f.decoders).toHaveLength(2); expect(f.decoders[1].submissions).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it('aborts output waiting, rejects old-generation callbacks during a new request, then recovers', async () => {
    const f = setup(); await f.e.renderRange(2, 2); f.mode('waiting');
    const ac = new AbortController(); const pending = f.e.renderRange(3, 3, { signal: ac.signal }); ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(f.e.forward).toBeNull();
    const old = f.decoders[0]; const fresh = f.e.renderRange(4, 4);
    const uploads = f.e.be.uploadFrame.mock.calls.length; const stale = old.emit(3);
    expect(stale.close).toHaveBeenCalledOnce(); expect(f.e.be.uploadFrame).toHaveBeenCalledTimes(uploads);
    for (const k of f.decoders[1].pending.splice(0)) f.decoders[1].emit(k);
    await fresh; expect(f.e.forward.through).toBe(4);
  });
  it('waits for actual asynchronous output even when decodeQueueSize is already zero', async () => {
    vi.useFakeTimers(); const f = setup(); f.mode('waiting'); let done = false;
    const request = f.e.renderRange(3, 3).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(50); expect(done).toBe(false); expect(f.decoders[0].decodeQueueSize).toBe(0);
    for (const k of f.decoders[0].pending.splice(0)) f.decoders[0].emit(k);
    await request; expect(done).toBe(true); expect(f.decoders[0].flushes).toBe(0); expect(f.e.forward.through).toBe(3);
    await vi.advanceTimersByTimeAsync(100); expect(f.decoders[0].flushes).toBe(0);
  });
  it('retains continuation when a slow output tail continues advancing past 100 ms', async () => {
    vi.useFakeTimers(); const f = setup(); f.mode('waiting');
    const request = f.e.renderRange(4, 4);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(60);
      f.decoders[0].emit(f.decoders[0].pending.shift()!);
    }
    await request; expect(f.decoders[0].flushes).toBe(0); expect(f.e.canContinue(5)).toBe(true);
    expect(timing.previewTiming).toHaveBeenCalledExactlyOnceWith({ ev: 'decoder.wait', requested: 4, initial: -1, final: 4, progress: 5, ms: 300, outcome: 'complete' });
    expect(vi.getTimerCount()).toBe(0); expect(f.e.outputWait).toBeNull();
  });
  it('does not extend the inactivity deadline for repeated output notifications', async () => {
    vi.useFakeTimers(); const f = setup(); const wait = f.e.waitForOutput(3);
    await vi.advanceTimersByTimeAsync(60); f.e.outputWait(); // no new sample
    await vi.advanceTimersByTimeAsync(40); await expect(wait).resolves.toBe(false);
    expect(timing.previewTiming).toHaveBeenCalledExactlyOnceWith({ ev: 'decoder.wait', requested: 3, initial: -1, final: -1, progress: 0, ms: 100, outcome: 'idle-timeout' });
    expect(vi.getTimerCount()).toBe(0); expect(f.e.outputWait).toBeNull();
  });
  it('caps continuously advancing output waiting at one second', async () => {
    vi.useFakeTimers(); const f = setup(); const wait = f.e.waitForOutput(30);
    for (let k = 0; k < 12; k++) { await vi.advanceTimersByTimeAsync(80); f.e.decodedThrough = k; f.e.outputWait(); }
    await vi.advanceTimersByTimeAsync(40); await expect(wait).resolves.toBe(false);
    expect(timing.previewTiming).toHaveBeenCalledExactlyOnceWith({ ev: 'decoder.wait', requested: 30, initial: -1, final: 11, progress: 12, ms: 1000, outcome: 'hard-timeout' });
    expect(vi.getTimerCount()).toBe(0); expect(f.e.outputWait).toBeNull();
  });
  it.each(['abort', 'error'] as const)('cleans both deadlines and reports one %s outcome', async outcome => {
    vi.useFakeTimers(); const f = setup(); const ac = new AbortController();
    const wait = f.e.waitForOutput(4, ac.signal); const rejected = expect(wait).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(40); f.e.decodedThrough = 0; f.e.outputWait();
    if (outcome === 'abort') ac.abort(); else { f.e.decodeErr = new Error('failed'); f.e.outputWait(); }
    await rejected; expect(vi.getTimerCount()).toBe(0); expect(f.e.outputWait).toBeNull();
    expect(timing.previewTiming).toHaveBeenCalledExactlyOnceWith({ ev: 'decoder.wait', requested: 4, initial: -1, final: 0, progress: 1, ms: 40, outcome });
    await vi.advanceTimersByTimeAsync(1500); expect(timing.previewTiming).toHaveBeenCalledTimes(1);
  });
  it('times out after progress stalls; duplicate and out-of-order notifications cannot extend it', async () => {
    vi.useFakeTimers(); const f = setup(); const wait = f.e.waitForOutput(9);
    await vi.advanceTimersByTimeAsync(60); f.e.decodedThrough = 2; f.e.outputWait();
    await vi.advanceTimersByTimeAsync(60); f.e.decodedThrough = 1; f.e.outputWait();
    await vi.advanceTimersByTimeAsync(30); f.e.decodedThrough = 2; f.e.outputWait();
    const lateCheck = f.e.outputWait;
    await vi.advanceTimersByTimeAsync(10); await expect(wait).resolves.toBe(false);
    expect(timing.previewTiming).toHaveBeenCalledExactlyOnceWith({ ev: 'decoder.wait', requested: 9, initial: -1, final: 2, progress: 1, ms: 160, outcome: 'idle-timeout' });
    f.e.decodedThrough = 3; lateCheck(); expect(vi.getTimerCount()).toBe(0);
    expect(timing.previewTiming).toHaveBeenCalledTimes(1);
  });
  it.each(['idle', 'hard'] as const)('abort just before the %s deadline removes both timers', async deadline => {
    vi.useFakeTimers(); const f = setup(); const ac = new AbortController();
    const wait = f.e.waitForOutput(30, ac.signal); const rejected = expect(wait).rejects.toMatchObject({ name: 'AbortError' });
    if (deadline === 'hard') {
      for (let k = 0; k < 11; k++) { await vi.advanceTimersByTimeAsync(90); f.e.decodedThrough = k; f.e.outputWait(); }
      await vi.advanceTimersByTimeAsync(9);
    } else await vi.advanceTimersByTimeAsync(99);
    const lateCheck = f.e.outputWait; ac.abort(); await rejected;
    f.e.decodedThrough = 20; lateCheck(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(timing.previewTiming).toHaveBeenCalledTimes(1);
    expect(timing.previewTiming.mock.calls[0][0]).toMatchObject({ outcome: 'abort', ms: deadline === 'hard' ? 999 : 99 });
  });
  it('disposing an engine settles its pending output wait immediately', async () => {
    vi.useFakeTimers(); const f = setup(); f.mode('waiting');
    const render = f.e.renderRange(4, 4); const rejected = expect(render).rejects.toMatchObject({ name: 'AbortError' });
    const lateCheck = f.e.outputWait; f.e.dispose(); await rejected;
    f.e.decodedThrough = 2; lateCheck(); expect(vi.getTimerCount()).toBe(0);
    expect(f.e.outputWait).toBeNull(); expect(f.e.cancelOutputWait).toBeNull();
    expect(f.decoders[0].state).toBe('closed'); expect(timing.previewTiming).toHaveBeenCalledTimes(1);
    expect(timing.previewTiming.mock.calls[0][0]).toMatchObject({ outcome: 'abort', ms: 0 });
  });
  it('emits no wait diagnostic when disabled or output was already complete', async () => {
    vi.useFakeTimers(); const f = setup(); f.e.decodedThrough = 4;
    await expect(f.e.waitForOutput(4)).resolves.toBe(true); expect(timing.previewTiming).not.toHaveBeenCalled();
    timing.previewTimingOn = false; const wait = f.e.waitForOutput(5);
    await vi.advanceTimersByTimeAsync(100); await expect(wait).resolves.toBe(false);
    expect(timing.previewTiming).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('decoder error wakes pending output waiting and destroys continuation', async () => {
    const f = setup(); f.mode('waiting'); const request = f.e.renderRange(3, 3);
    f.decoders[0].callbacks.error(new DOMException('decoder failure', 'EncodingError'));
    await expect(request).rejects.toMatchObject({ code: 'DECODE_FAILED' }); expect(f.e.forward).toBeNull(); expect(f.e.decoder).toBeNull();
  });
  it('output-size changes, frozen rendering and disposal invalidate retained state', async () => {
    const f = setup(); await f.e.renderRange(4, 4); f.e.outW = 1; f.e.outH = 1;
    f.e.setOutputSize(2, 2); expect(f.e.forward).toBeNull();
    await f.e.renderRange(5, 5); expect(f.decoders).toHaveLength(2);
    f.e.fpx = new Uint8Array(4); f.e.usableFreeze = () => ({ a: 0, fd: -1 });
    // Cancellation before file IO exercises the actual frozen-path invalidation.
    const ac = new AbortController();
    await expect(f.e.renderRange(6, 6, { signal: ac.signal, gate: async () => { ac.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.e.forward).toBeNull();
    f.e.usableFreeze = () => null; await f.e.renderRange(7, 7); f.e.dispose();
    expect(f.e.forward).toBeNull(); expect(f.decoders.at(-1)!.state).toBe('closed');
  });
  it('invalidates continuation on plan updates and freeze changes', async () => {
    const f = setup(); await f.e.renderRange(4, 4);
    f.e.update({ plan: f.e.plan, blocks: [], blockPlans: new Map([['block', { ok: true, slotCount: 1 }]]), lfos: [], values: [] });
    expect(f.e.forward).toBeNull(); await f.e.renderRange(5, 5); expect(f.decoders).toHaveLength(2);
    f.e.unfreeze('block'); expect(f.e.forward).toBeNull();
  });
  it('preserves export and forced-live configure/reset/flush behavior', async () => {
    const f = setup(20, 'export'); await f.e.renderRange(4, 4); await f.e.renderRange(5, 5);
    expect(f.decoders[0].flushes).toBe(2); expect(f.decoders[0].configurations).toBe(2); expect(f.decoders[0].resets).toBe(1);
    expect(f.decoders[0].submissions).toHaveLength(11); expect(f.e.forward).toBeNull();
    const p = setup(); await p.e.renderRange(4, 4, { live: true }); expect(p.decoders[0].flushes).toBe(1); expect(p.e.forward).toBeNull();
  });
});

// Real block compilation and Engine.setParam/update, with a scalar pixel stand-in.
// This proves decoded-input identity/invalidation, not native colour or GPU parity.
function parameterFixture(frames = 3100, kinds = ['fx.plane-desync']) {
  const f = setup(frames);
  const block = withChain(newBlock('picture', 'source' as never, 0, frames, { id: 'block' as never }), kinds.map(kind => ({ kind })));
  const plan = compileBlockGraph(block.id, block.graph);
  expect(plan.ok).toBe(true);
  f.e.o = { ...f.e.o, blocks: [block], blockPlans: new Map([[block.id, plan]]), lfos: [], values: [] };
  f.e.blocksById = new Map([[block.id, block]]);
  f.e.stateStart = (t: number) => t;
  const node = block.graph.nodes.find(n => n.kind === 'fx.plane-desync')!;
  let input = -1;
  const outputs: { t: number; input: number; value: number }[] = [];
  f.e.be.uploadFrame.mockImplementation((_target: unknown, frame: VideoFrame) => { input = frame.timestamp; });
  f.e.processFrame = (t: number) => outputs.push({ t, input, value: input + Number(f.e.blocksById.get(block.id).graph.nodes.find((n: any) => n.id === node.id).params.dx) });
  return { ...f, block, node, outputs, edit: (value: number) => f.e.setParam(block.id, node.id, 'dx', value) };
}

describe('stateless parameter refresh retains decoded input', () => {
  it('reprocesses the same long-chain frame and restored parameter value without new submissions, then continues forward', async () => {
    const f = parameterFixture(); await f.e.renderRange(3000, 3000);
    const original = f.outputs.at(-1), originalDx = Number(f.node.params.dx);
    f.e.fcache.set(3000, new Uint8Array(4)); f.e.fcacheBytes = 4; f.e.cached[3000] = 1;
    f.edit(90); expect(f.e.fcache.has(3000)).toBe(false); expect(f.e.cached[3000]).toBe(0);
    await f.e.renderRange(3000, 3000);
    expect(f.outputs.at(-1)).toEqual({ t: 3000, input: 3000, value: 3090 });
    f.edit(originalDx); await f.e.renderRange(3000, 3000); expect(f.outputs.at(-1)).toEqual(original);
    expect(f.decoders).toHaveLength(1); expect(f.decoders[0].submissions).toHaveLength(3001);
    expect(f.e.nextT).toBe(3001);
    await f.e.renderRange(3001, 3001); expect(f.decoders[0].submissions).toHaveLength(3002);
    const fresh = parameterFixture(); fresh.edit(originalDx); await fresh.e.renderRange(3001, 3001);
    expect(f.outputs.at(-1)).toEqual(fresh.outputs.at(-1));
  });
  it('coalesces successive edits before drawing and preserves held-frame input', async () => {
    const f = parameterFixture(3);
    f.e.plan.samples = [{ t: 0, key: true }, { t: 2, key: false }];
    f.e.plan.shown = new Int32Array([0, 0, 1]); f.e.plan.held = new Uint8Array([0, 1, 0]); f.e.nextShownT = new Int32Array([0, 2]);
    await f.e.renderRange(0, 0); await f.e.renderRange(1, 1);
    f.edit(30); f.edit(45); await f.e.renderRange(1, 1);
    expect(f.outputs.at(-1)).toEqual({ t: 1, input: 0, value: 45 });
    expect(f.decoders[0].submissions).toEqual([0]);
    await f.e.renderRange(2, 2); expect(f.decoders[0].submissions).toEqual([0, 1]);
  });
  it('does not use retained input after a different uncached seek or general plan update', async () => {
    const f = parameterFixture(20); await f.e.renderRange(10, 10); f.edit(90);
    await f.e.renderRange(3, 3); expect(f.outputs.at(-1)).toEqual({ t: 3, input: 3, value: 93 });
    await f.e.renderRange(10, 10); expect(f.outputs.at(-1)?.input).toBe(10);
    f.edit(30); f.e.update({ plan: f.e.plan, blocks: f.e.o.blocks, blockPlans: f.e.o.blockPlans, lfos: [], values: [] });
    expect(f.e.forward).toBeNull(); expect(f.e.paramRefresh).toBeNull();
    const before = f.decoders.length; await f.e.renderRange(10, 10); expect(f.decoders.length).toBe(before + 1);
  });
  it('does not reuse GPU history when a stateless node belongs to a temporal graph', async () => {
    const f = parameterFixture(20, ['fx.plane-desync', 'fx.echo-taps']);
    expect(f.e.o.blockPlans.get('block').pastDependent).toBe(true);
    await f.e.renderRange(10, 10); f.edit(60); expect(f.e.forward).toBeNull(); expect(f.e.paramRefresh).toBeNull();
    await f.e.renderRange(10, 10); expect(f.decoders).toHaveLength(2);
  });
  it.each(['export', 'proxy', 'busy', 'closed', 'error', 'other-block', 'encoded', 'missing-plan'] as const)('keeps the conservative path for %s', async reason => {
    const f = parameterFixture(20); await f.e.renderRange(10, 10);
    if (reason === 'export') f.e.o.role = 'export';
    if (reason === 'proxy') { f.e.moshed = f.e.plan; f.e.proxy = {}; }
    if (reason === 'busy') f.e.decoding = true;
    if (reason === 'closed') f.decoders[0].state = 'closed';
    if (reason === 'error') f.e.decodeErr = new Error('decode failed');
    if (reason === 'other-block') f.e.plan.blocks[0].blockId = 'other';
    if (reason === 'encoded') {
      const bp = f.e.o.blockPlans.get('block'); bp.steps = bp.steps.map((s: any) => s.node === f.node.id ? { ...s, def: { ...s.def, domain: 'ENCODED_STREAM' } } : s);
    }
    if (reason === 'missing-plan') f.e.o.blockPlans = new Map();
    f.edit(80); expect(f.e.forward).toBeNull(); expect(f.e.paramRefresh).toBeNull();
  });
  it('a failed reprocess drops continuation and an aborted refresh never paints', async () => {
    const f = parameterFixture(20); await f.e.renderRange(10, 10); f.edit(40);
    const count = f.outputs.length, ac = new AbortController(); ac.abort();
    await expect(f.e.renderRange(10, 10, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.outputs).toHaveLength(count);
    f.e.processFrame = () => { throw new Error('GPU failure'); };
    await expect(f.e.renderRange(10, 10)).rejects.toThrow('GPU failure'); expect(f.e.forward).toBeNull(); expect(f.e.ro).toEqual({});
  });
});