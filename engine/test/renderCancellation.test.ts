// Exercise the real runtime control flow with a deterministic decoder/backend double.
// These checks establish cancellation/queue safety, not native GPU pixel parity.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Engine, type RenderOptions } from '../src/runtime/engine';

vi.mock('../src/timeline/stage1', async original => ({
  ...await original<typeof import('../src/timeline/stage1')>(),
  sampleBytes: () => new Uint8Array([1]),
}));

class Decoder extends EventTarget {
  state = 'unconfigured';
  decodeQueueSize = 0;
  resets = 0;
  submitted = 0;
  mode: 'normal' | 'drain' | 'flush' = 'normal';
  pendingFlush: ((error: Error) => void) | undefined;
  output: (frame: VideoFrame) => void;
  constructor(init: VideoDecoderInit) { super(); this.output = init.output; }
  configure() { this.state = 'configured'; }
  reset() {
    this.resets++;
    this.state = 'unconfigured'; this.decodeQueueSize = 0;
    this.pendingFlush?.(new DOMException('reset', 'AbortError')); this.pendingFlush = undefined;
    this.dispatchEvent(new Event('dequeue'));
  }
  decode(chunk: EncodedVideoChunk) {
    this.submitted++;
    if (this.mode === 'drain') { this.decodeQueueSize++; return; }
    this.output({ timestamp: chunk.timestamp, close: vi.fn() } as unknown as VideoFrame);
  }
  flush() { return this.mode === 'flush' ? new Promise<void>((_resolve, reject) => { this.pendingFlush = reject; }) : Promise.resolve(); }
}

function setup(frames = 40) {
  const decoders: Decoder[] = [];
  vi.stubGlobal('VideoDecoder', class extends Decoder { constructor(init: VideoDecoderInit) { super(init); decoders.push(this); } });
  vi.stubGlobal('EncodedVideoChunk', class { timestamp: number; constructor(init: EncodedVideoChunkInit) { this.timestamp = init.timestamp; } });
  const e = Object.create(Engine.prototype) as any;
  const span = { start: 0, end: frames, blockId: 'block' };
  Object.assign(e, {
    plan: { frames, blocks: [span], samples: Array.from({ length: frames }, (_, t) => ({ t, key: t === 0 })),
      segStart: new Int32Array(frames), shown: Int32Array.from({ length: frames }, (_, i) => i), held: new Uint8Array(frames) },
    spanOf: new Int32Array(frames), nextShownT: Int32Array.from({ length: frames }, (_, i) => i),
    rangeActive: new Uint8Array(frames), cps: new Map(), fcache: new Map(),
    cached: new Uint8Array(frames), moshed: null, decoder: null, o: {}, ro: {}, decoding: false,
    chunkInit: {}, anomalies: [], stats: { replayed: 0, decoded: 0, orderErrors: 0, cacheHits: 0, frozenFrames: 0 },
    stateStart: () => 0, runtime: () => ({}), usableFreeze: () => null,
    be: { uploadFrame: vi.fn(), draw: vi.fn(), uploadRGBA8: vi.fn(), copy: vi.fn() },
    processFrame: vi.fn(), sink: vi.fn(),
  });
  const prime = async (mode: Decoder['mode']) => {
    await e.renderRange(0, 0);
    decoders[0].mode = mode;
    decoders[0].submitted = 0;
  };
  return { e, decoders, prime };
}

afterEach(() => vi.unstubAllGlobals());

describe('interactive render cancellation', () => {
  it('aborts while waiting for decoder drain and then renders normally on the same engine', async () => {
    const { e, decoders, prime } = setup(); await prime('drain');
    const ac = new AbortController();
    const render = e.renderRange(39, 39, { signal: ac.signal });
    expect(decoders[0].decodeQueueSize).toBeGreaterThan(16);
    ac.abort();
    await expect(render).rejects.toMatchObject({ name: 'AbortError' });
    expect(decoders[0].submitted).toBeLessThan(40);
    expect(e.ro).toEqual({}); expect(e.decoding).toBe(false);
    decoders[0].mode = 'normal';
    await e.renderRange(4, 4);
    expect(e.nextT).toBe(5);
  });

  it('reset interrupts a pending decoder flush, and late output is closed without uploading', async () => {
    const { e, decoders, prime } = setup(); await prime('flush');
    const ac = new AbortController();
    const render = e.renderRange(4, 4, { signal: ac.signal });
    expect(decoders[0].pendingFlush).toBeTypeOf('function');
    ac.abort();
    await expect(render).rejects.toMatchObject({ name: 'AbortError' });
    const late = { timestamp: 3, close: vi.fn() };
    e.be.uploadFrame.mockClear(); decoders[0].output(late as unknown as VideoFrame);
    expect(late.close).toHaveBeenCalledOnce(); expect(e.be.uploadFrame).not.toHaveBeenCalled();
    expect(e.ro).toEqual({});
    decoders[0].mode = 'normal'; await e.renderRange(2, 2);
    expect(e.nextT).toBe(3);
  });

  it('cleans up an exception from the submission gate, before flush is reached', async () => {
    const { e, decoders } = setup();
    await expect(e.renderRange(0, 0, { gate: async () => { throw new Error('gate failed'); } })).rejects.toBeDefined();
    expect(e.ro).toEqual({}); expect(e.decoding).toBe(false);
    expect(decoders[0].state).toBe('unconfigured');
    await e.renderRange(1, 1); expect(e.nextT).toBe(2);
  });

  it('does not deliver a cached frame for an already cancelled request', async () => {
    const { e } = setup(); const ac = new AbortController(); ac.abort();
    e.fcache.set(0, new Uint8Array(4)); const onFrame = vi.fn();
    await expect(e.renderRange(0, 0, { signal: ac.signal, onFrame })).rejects.toMatchObject({ name: 'AbortError' });
    expect(onFrame).not.toHaveBeenCalled(); expect(e.decoder).toBeNull();
    await e.renderRange(0, 0, { onFrame }); expect(onFrame).toHaveBeenCalledOnce();
  });

  it('cancels frozen-file work after an awaited gate and releases its render options', async () => {
    const { e } = setup(); const ac = new AbortController();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mosh-cancel-'));
    const file = path.join(dir, 'freeze.rgba'); fs.writeFileSync(file, new Uint8Array(8));
    const fd = fs.openSync(file, 'r');
    try {
      e.fpx = new Uint8Array(4); e.usableFreeze = () => ({ a: 0, fd });
      const options: RenderOptions = { signal: ac.signal, gate: async () => { ac.abort(); } };
      await expect(e.renderRange(0, 1, options)).rejects.toMatchObject({ name: 'AbortError' });
      expect(e.sink).not.toHaveBeenCalled(); expect(e.ro).toEqual({});
      await e.renderRange(0, 1); expect(e.sink).toHaveBeenCalledTimes(2);
    } finally { fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
