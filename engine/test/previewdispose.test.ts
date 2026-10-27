// Waxy's fatal (2026-10-08): INTERNAL from previewFrame, cause InputDisposedError. The Source browser
// closed a file's preview (or the 4-file LRU evicted it) while a frame was still decoding; close()
// disposed the Mediabunny input under it. Now the input outlives the request in flight, which
// resolves null (superseded), and is disposed when that request settles.
import { describe, expect, it } from 'vitest';
import { PreviewSource } from '../src/preview/source';

class InputDisposedError extends Error { constructor() { super('Input has been disposed.'); this.name = 'InputDisposedError'; } }

/** A PreviewSource on a fake input whose decode the test releases by hand, like the real race. */
function rig() {
  let disposed = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const input = { dispose: () => { disposed = true; } };
  const sink = {
    // Mediabunny throws InputDisposedError if the input went away while it was reading.
    getSample: async () => { await gate; if (disposed) throw new InputDisposedError(); return { timestamp: 1, close() {}, draw() {} }; },
  };
  const packets = { getKeyPacket: async () => { await gate; if (disposed) throw new InputDisposedError(); return { timestamp: 0 }; } };
  const track = { getFirstTimestamp: async () => 0 };
  const Ctor = PreviewSource as unknown as new (...a: unknown[]) => PreviewSource;
  const src = new Ctor('clip.mp4', input, track, sink, sink, packets, { w: 64, h: 36 }, 10);
  return { src, release, isDisposed: () => disposed };
}

describe('PreviewSource close() during a frame request', () => {
  it('an exact frame in flight resolves null, and the input is disposed only after it settles', async () => {
    const { src, release, isDisposed } = rig();
    const req = src.frame(1, { exact: true, size: { w: 64, h: 36 } });
    await Promise.resolve();
    src.close();
    expect(isDisposed()).toBe(false); // still in use by the request
    release();
    await expect(req).resolves.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(isDisposed()).toBe(true);
  });

  it('a snap (keyframe lookup) in flight is safe too', async () => {
    const { src, release, isDisposed } = rig();
    const req = src.frame(1, { size: { w: 64, h: 36 } });
    await Promise.resolve();
    src.close();
    release();
    await expect(req).resolves.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(isDisposed()).toBe(true);
  });

  it('a request after close is refused without touching the disposed input', async () => {
    const { src, release } = rig();
    release();
    src.close();
    await expect(src.frame(1, { size: { w: 64, h: 36 } })).rejects.toThrow(/preview closed|PREVIEW_UNSUPPORTED/);
  });
});

// Frame stepping (Waxy, 2026-10-08): t counts from the file's first frame. A GoPro file starts at
// 0.0334 s; asking at t = 0 used to hit "before the first frame", and every frame read one early.
describe('PreviewSource time counts from the first frame', () => {
  it('t = 0 asks for the first frame, and the time returned is relative to it', async () => {
    const asked: number[] = [];
    const sink = { getSample: async (at: number) => (asked.push(at), { timestamp: at, close() {}, draw() {} }) };
    const track = { getFirstTimestamp: async () => 0.0334 };
    const Ctor = PreviewSource as unknown as new (...a: unknown[]) => PreviewSource;
    const src = new Ctor('gopro.mp4', { dispose() {} }, track, sink, sink, {}, { w: 64, h: 36 }, 10);
    const f = await src.frame(0.5 / 29.97, { exact: true, size: { w: 64, h: 36 } }).catch((e) => e);
    expect(asked[0]).toBeCloseTo(0.0334 + 0.5 / 29.97, 9);
    if (f && !(f instanceof Error)) expect(f.time).toBeCloseTo(0.5 / 29.97, 9);
  });
});
