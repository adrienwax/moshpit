import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewSource } from '../src/preview/source';
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const samples: { timestamp: number; close: ReturnType<typeof vi.fn> }[] = [];
  const ended = vi.fn(), seek = vi.fn(async (at: number) => make(Math.floor(at * 30) / 30));
  const make = (timestamp: number) => { const sample = { timestamp, draw() {}, close: vi.fn() }; samples.push(sample); return sample; };
  const sequential = vi.fn(async function* (at: number) {
    try { for (let frame = Math.floor(at * 30); frame < 90; frame++) yield make(frame / 30); }
    finally { ended(); }
  });
  vi.stubGlobal('OffscreenCanvas', class { getContext() { return { getImageData: () => ({ data: new Uint8Array(16) }) }; } });
  const input = { dispose: vi.fn() }, track = { getFirstTimestamp: async () => 0 };
  const sink = { getSample: seek, samples: sequential }, packets = { getKeyPacket: vi.fn(async () => ({ timestamp: 0 })) };
  const Ctor = PreviewSource as unknown as new (...args: unknown[]) => PreviewSource;
  const src = new Ctor('test', input, track, sink, sink, packets, { w: 2, h: 2 }, 3);
  return { src, samples, sequential, ended, seek, input, packets };
}
const req = { playback: true, size: { w: 2, h: 2 } };
describe('raw forward playback keeps one presentation-order decoder', () => {
  it('decodes every requested frame in sequence without keyframe/exact re-seeks', async () => {
    const f = fixture();
    for (let n = 0; n < 30; n++) {
      const frame = await f.src.frame((n + .5) / 30, req);
      expect(frame?.time).toBeCloseTo(n / 30); expect(frame?.exact).toBe(true);
    }
    expect(f.sequential).toHaveBeenCalledOnce(); expect(f.seek).not.toHaveBeenCalled(); expect(f.packets.getKeyPacket).not.toHaveBeenCalled();
    f.src.close(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.ended).toHaveBeenCalledOnce(); expect(f.input.dispose).toHaveBeenCalledOnce();
    expect(f.samples.every(sample => sample.close.mock.calls.length === 1)).toBe(true);
  });
  it('restarts for a loop/backward seek and exact paused stepping releases the playback iterator', async () => {
    const f = fixture(); await f.src.frame(.5, req); await f.src.frame(.6, req); await f.src.frame(.1, req);
    expect(f.sequential).toHaveBeenCalledTimes(2); expect(f.ended).toHaveBeenCalledOnce();
    await f.src.frame(.2, { exact: true, size: req.size });
    expect(f.seek).toHaveBeenCalledExactlyOnceWith(.2); expect(f.ended).toHaveBeenCalledTimes(2);
    f.src.close(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.samples.every(sample => sample.close.mock.calls.length === 1)).toBe(true);
  });
});
