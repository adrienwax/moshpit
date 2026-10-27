import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFile: vi.fn() }));
vi.mock('../src/conform/ffmpeg', () => ({ findFfmpeg: () => ({ ffmpeg: 'owned-ffmpeg' }) }));
vi.mock('../src/runtime/audio', () => ({ planAudio: (_a: unknown, _c: unknown, _f: unknown, _r: unknown, file: string) => ({ args: ['audio', file], samples: 2400 }) }));
vi.mock('../src/audio/mirror', () => ({ lanesFor: () => [], mirrorWav: vi.fn() }));
import { exportRange } from '../src/runtime/export';
import { H264Encoder } from '../src/runtime/encode';
import type { Engine } from '../src/runtime/engine';
import type { ExportConfig, ProjectDoc } from '../src/model';
import type { Stage1Plan } from '../src/timeline/stage1';

class Codec extends EventTarget {
  static all: Codec[] = [];
  static failConfigure = false;
  static stallFlush = false;
  static queue = 0;
  state = 'unconfigured'; encodeQueueSize = Codec.queue; closed = 0;
  rejectFlush?: (e: Error) => void;
  static async isConfigSupported() { return { supported: true }; }
  constructor(readonly callbacks: VideoEncoderInit) { super(); Codec.all.push(this); }
  configure() { if (Codec.failConfigure) throw Error('configure failed'); this.state = 'configured'; }
  encode() { this.callbacks.output({ byteLength: 1, copyTo: (b: Uint8Array) => { b[0] = 1; } } as unknown as EncodedVideoChunk, {}); }
  flush() { return Codec.stallFlush ? new Promise<void>((_r, reject) => { this.rejectFlush = reject; }) : Promise.resolve(); }
  close() { this.closed++; this.state = 'closed'; this.rejectFlush?.(new DOMException('closed', 'AbortError')); }
}
class Child extends EventEmitter {
  stdout = { resume: vi.fn() }; stderr = new EventEmitter();
  stdin = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  killed = 0; closed = false; blocked = false;
  constructor(readonly target: string, readonly automatic = true) {
    super(); fs.writeFileSync(target, 'partial');
    this.stdin.write = vi.fn(() => !this.blocked);
    this.stdin.end = vi.fn(() => { if (automatic) queueMicrotask(() => this.finish(0)); });
    this.stdin.destroy = vi.fn();
  }
  kill() { this.killed++; return true; } // Tests explicitly release close to check awaited cleanup.
  finish(code: number) { this.closed = true; if (code === 0) fs.writeFileSync(this.target, 'complete'); this.emit('close', code); }
}
let root: string, children: Child[];
const plan = { frames: 8, fps: { num: 60, den: 1 }, audio: [], blocks: [] } as unknown as Stage1Plan;
const doc = { resources: { sources: [], conforms: [] }, timeline: { blocks: [] }, settings: { bpm: 120 } } as unknown as ProjectDoc;
let cfg: ExportConfig;
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function fixture(render?: Engine['renderRange']) {
  const out = path.join(root, 'result.mp4'), tmp = path.join(root, 'tmp');
  const engine = { setOutputSize: vi.fn(), renderRange: render ?? (async (a, b, o) => {
    for (let t = a; t <= b; t++) { if (o?.signal?.aborted) throw new DOMException('abort', 'AbortError'); await o?.gate?.(); o?.onFrame?.(new Uint8Array(16), t); }
  }) } as unknown as Engine;
  return { out, tmp, engine, run: (signal?: AbortSignal) => exportRange(engine, doc, plan, cfg, out, { tmpDir: tmp, signal }) };
}
function noPartials(f: ReturnType<typeof fixture>) { expect(fs.existsSync(f.out)).toBe(false); expect(fs.readdirSync(f.tmp)).toEqual([]); }
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosh-export-life-')); children = [];
  Codec.all = []; Codec.failConfigure = false; Codec.stallFlush = false; Codec.queue = 0;
  vi.stubGlobal('VideoEncoder', Codec);
  vi.stubGlobal('VideoFrame', class { close() {} });
  cfg = { format: 'mp4-h264', width: 2, height: 2, audio: false };
  mocks.spawn.mockImplementation((_bin: string, args: string[]) => { const child = new Child(args.at(-1)!); children.push(child); return child; });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('export resource lifetime (real owned files, controlled codecs and child processes)', () => {
  it('retains successful output and removes all intermediates', async () => {
    cfg.audio = true; const f = fixture(); const report = await f.run();
    expect(report.frames).toBe(8); expect(fs.readFileSync(f.out, 'utf8')).toBe('complete');
    expect(fs.readdirSync(f.tmp)).toEqual([]); expect(Codec.all[0].closed).toBe(1); expect(children.every(p => p.closed && p.killed === 0)).toBe(true);
  });
  it('declares display-sRGB input and repairs only SPS/container primaries and transfer', async () => {
    const frameInputs: VideoFrameBufferInit[] = [];
    vi.stubGlobal('VideoFrame', class { constructor(_data: unknown, init: VideoFrameBufferInit) { frameInputs.push(init); } close() {} });
    await fixture().run();
    expect(frameInputs).toHaveLength(8);
    for (const init of frameInputs) expect(init.colorSpace).toEqual({ primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true });
    const args = mocks.spawn.mock.calls.at(-1)![1] as string[];
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
    expect(args[args.indexOf('-bsf:v') + 1]).toBe('h264_metadata=colour_primaries=1:transfer_characteristics=13');
    expect(args[args.indexOf('-color_primaries') + 1]).toBe('bt709');
    expect(args[args.indexOf('-color_trc') + 1]).toBe('iec61966-2-1');
    expect(args).not.toContain('-colorspace'); expect(args).not.toContain('-color_range');
    expect(args.join(' ')).not.toContain('matrix_coefficients'); expect(args.join(' ')).not.toContain('video_full_range_flag');
  });
  it('propagates abort during dependency decoding and cleans encoder before retry', async () => {
    const ac = new AbortController(); let signal: AbortSignal | undefined;
    const f = fixture(async (_a, _b, o) => { signal = o?.signal; await new Promise<void>((_r, reject) => o?.signal?.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')), { once: true })); });
    const run = f.run(ac.signal); const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' }); await flush(); expect(signal).toBe(ac.signal);
    ac.abort(); await rejected; noPartials(f); expect(Codec.all[0].closed).toBe(1);
    await fixture().run(); expect(fs.existsSync(f.out)).toBe(true);
  });
  it('cleans up a frame-processing exception and a configure failure', async () => {
    const f = fixture(async () => { throw Error('frame failed'); });
    await expect(f.run()).rejects.toMatchObject({ code: 'EXPORT_FAILED' }); noPartials(f); expect(Codec.all[0].closed).toBe(1);
    Codec.failConfigure = true;
    await expect(fixture().run()).rejects.toMatchObject({ code: 'EXPORT_FAILED' }); noPartials(f); expect(Codec.all[1].closed).toBe(1);
  });
  it('interrupts an encoder drain and an encoder flush without leaking listeners or files', async () => {
    Codec.queue = 5; let ac = new AbortController(); let f = fixture();
    let run = f.run(ac.signal); let rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' }); await flush(); ac.abort(); await rejected;
    noPartials(f); expect(Codec.all[0].closed).toBe(1);
    Codec.queue = 0; Codec.stallFlush = true; ac = new AbortController(); f = fixture();
    run = f.run(ac.signal); rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    for (let i = 0; i < 10 && !Codec.all.at(-1)?.rejectFlush; i++) await flush();
    expect(Codec.all.at(-1)?.rejectFlush).toBeTypeOf('function'); ac.abort(); await rejected; noPartials(f); expect(Codec.all.at(-1)?.closed).toBe(1);
  });
  it.each(['audio', 'mux'] as const)('awaits child close before cleaning an aborted %s step', async step => {
    cfg.audio = step === 'audio'; const ac = new AbortController();
    mocks.spawn.mockImplementation((_bin: string, args: string[]) => { const child = new Child(args.at(-1)!, false); children.push(child); return child; });
    const f = fixture(); let settled = false; const run = f.run(ac.signal); void run.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    for (let i = 0; i < 10 && !children.length; i++) await flush();
    expect(children).toHaveLength(1); ac.abort(); await flush();
    expect(settled).toBe(false); expect(children[0].killed).toBe(1); expect(fs.existsSync(children[0].target)).toBe(true);
    children[0].finish(1); await rejected; noPartials(f);
  });
  it('settles raw-video backpressure cancellation only after its owned child closes', async () => {
    cfg.format = 'prores-422hq'; const ac = new AbortController();
    mocks.spawn.mockImplementation((_bin: string, args: string[]) => { const p = new Child(args.at(-1)!, false); p.blocked = true; children.push(p); return p; });
    const f = fixture(); const run = f.run(ac.signal); const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' }); await flush();
    expect(children[0].stdin.listenerCount('drain')).toBe(1); ac.abort(); await flush(); expect(children[0].killed).toBe(1);
    children[0].finish(1); await rejected; noPartials(f); expect(children[0].stdin.listenerCount('drain')).toBe(0);
  });
  it('reports raw child failure as failure rather than user cancellation', async () => {
    cfg.format = 'hap';
    mocks.spawn.mockImplementation((_bin: string, args: string[]) => { const p = new Child(args.at(-1)!, false); p.blocked = true; children.push(p); return p; });
    const f = fixture(); const run = f.run(); const rejected = expect(run).rejects.toMatchObject({ code: 'EXPORT_FAILED' }); await flush();
    children[0].finish(2); await rejected; noPartials(f); expect(children[0].stdin.listenerCount('drain')).toBe(0);
  });
  it('awaits close after spawn failure before publishing failure', async () => {
    const f = fixture();
    mocks.spawn.mockImplementation((_bin: string, args: string[]) => { const p = new Child(args.at(-1)!, false); children.push(p); queueMicrotask(() => p.emit('error', Object.assign(Error('missing'), { code: 'ENOENT' }))); return p; });
    let settled = false; const run = f.run(); void run.catch(() => { settled = true; }); const rejected = expect(run).rejects.toMatchObject({ code: 'EXPORT_FAILED' });
    for (let i = 0; i < 10 && !children.length; i++) await flush(); await flush(); expect(settled).toBe(false);
    children[0].finish(-1); await rejected; noPartials(f);
  });
  it('releases raw stdin and awaits close when frame processing fails', async () => {
    cfg.format = 'prores-422hq';
    mocks.spawn.mockImplementation((_bin: string, args: string[]) => { const p = new Child(args.at(-1)!, false); children.push(p); return p; });
    const f = fixture(async () => { throw Error('GPU processing failed'); });
    const run = f.run(); const rejected = expect(run).rejects.toMatchObject({ code: 'EXPORT_FAILED' }); await flush();
    expect(children[0].killed).toBe(1); expect(children[0].stdin.destroy).toHaveBeenCalledOnce(); expect(fs.existsSync(f.out)).toBe(true);
    children[0].finish(1); await rejected; noPartials(f);
  });
  it('handles EPIPE during raw backpressure without an unhandled stream error', async () => {
    cfg.format = 'hap';
    mocks.spawn.mockImplementation((_bin: string, args: string[]) => { const p = new Child(args.at(-1)!, false); p.blocked = true; children.push(p); return p; });
    const f = fixture(); const run = f.run(); const rejected = expect(run).rejects.toMatchObject({ code: 'EXPORT_FAILED' }); await flush();
    children[0].stdin.emit('error', Object.assign(Error('broken pipe'), { code: 'EPIPE' })); await flush(); expect(children[0].killed).toBe(1);
    children[0].finish(1); await rejected; noPartials(f); expect(children[0].stdin.listenerCount('drain')).toBe(0);
  });
  it('removes a failed mux partial and leaves a prior unrelated output untouched', async () => {
    const existing = path.join(root, 'prior.mp4'); fs.writeFileSync(existing, 'prior');
    mocks.spawn.mockImplementation((_bin: string, args: string[]) => { const p = new Child(args.at(-1)!, false); children.push(p); p.stdin.end = vi.fn(() => queueMicrotask(() => p.finish(1))); return p; });
    const f = fixture(); await expect(f.run()).rejects.toMatchObject({ code: 'EXPORT_FAILED' }); noPartials(f);
    expect(fs.readFileSync(existing, 'utf8')).toBe('prior'); expect(Codec.all[0].closed).toBe(1);
  });
  it('keeps a successful raw export and clears its writer listeners', async () => {
    cfg.format = 'prores-422hq'; const f = fixture(); expect((await f.run()).frames).toBe(8);
    expect(fs.readFileSync(f.out, 'utf8')).toBe('complete'); expect(children[0].killed).toBe(0);
    expect(children[0].stdin.listenerCount('drain')).toBe(0); expect(fs.readdirSync(f.tmp)).toEqual([]);
  });
  it('does not claim outputs or start codecs for an already aborted request; never deletes an existing output', async () => {
    const f = fixture(), ac = new AbortController(); ac.abort(); await expect(f.run(ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.existsSync(f.out)).toBe(false); expect(Codec.all).toHaveLength(0);
    fs.writeFileSync(f.out, 'existing'); await expect(f.run()).rejects.toMatchObject({ code: 'EXPORT_EXISTS' }); expect(fs.readFileSync(f.out, 'utf8')).toBe('existing');
  });
  it('settles backpressure on asynchronous codec error and ignores late output after disposal', async () => {
    const file = path.join(root, 'codec.h264'); const enc = await H264Encoder.open(file, 2, 2, plan.fps);
    Codec.all[0].encodeQueueSize = 8; const ready = enc.ready(); const rejected = expect(ready).rejects.toMatchObject({ code: 'EXPORT_FAILED' });
    Codec.all[0].callbacks.error(new DOMException('codec failed')); await rejected; enc.dispose(); enc.dispose();
    expect(() => Codec.all[0].encode()).not.toThrow(); expect(Codec.all[0].closed).toBe(1); expect(fs.statSync(file).size).toBe(0);
  });
});
