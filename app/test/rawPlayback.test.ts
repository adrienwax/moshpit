import { describe, expect, it, vi } from 'vitest';
import { createPlaybackPump } from '../src/state/rawPlayback';
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function fixture(direction = 1) {
  const pending: { time: number; resolve: (value: any) => void; reject: (error: unknown) => void }[] = [];
  const show = vi.fn(), fail = vi.fn();
  const read = vi.fn((time: number) => new Promise<any>((resolve, reject) => pending.push({ time, resolve, reject })));
  const pump = createPlaybackPump(read, show, fail, direction);
  const finish = async () => { const work = pending.shift()!, frame = { time: work.time, image: { close: vi.fn() } }; work.resolve(frame); await flush(); return frame; };
  return { pump, pending, read, show, fail, finish };
}
describe('raw playback decode clock', () => {
  it('does not starve a slow in-flight frame, coalesces newer clock ticks and closes every image', async () => {
    const f = fixture(); f.pump.request(0);
    f.pump.request(1 / 60); f.pump.request(2 / 60); f.pump.request(3 / 60);
    expect(f.read).toHaveBeenCalledTimes(1);
    const first = await f.finish(); expect(f.show).toHaveBeenCalledWith(first); expect(first.image.close).toHaveBeenCalledOnce();
    expect(f.read.mock.calls).toEqual([[0], [3 / 60]]);
    await f.finish(); expect(f.show).toHaveBeenCalledTimes(2);
    f.pump.request(3 / 60); expect(f.read).toHaveBeenCalledTimes(2);
  });
  it('discards the old decoded frame on backward looping/seek, then requests the new position', async () => {
    const f = fixture(); f.pump.request(1); await f.finish(); f.pump.request(1.03); f.pump.request(0);
    const old = await f.finish(); expect(old.image.close).toHaveBeenCalledOnce(); expect(f.show).toHaveBeenCalledTimes(1);
    const current = await f.finish(); expect(f.show).toHaveBeenLastCalledWith(current);
  });
  it('rejects an immediate loop before the first decode and preserves normal reverse cadence', async () => {
    const f = fixture(); f.pump.request(.5); f.pump.request(.1);
    await f.finish(); expect(f.show).not.toHaveBeenCalled();
    await f.finish(); expect(f.show).toHaveBeenCalledOnce();
    const reverse = fixture(-1); reverse.pump.request(.5); reverse.pump.request(.4);
    await reverse.finish(); await reverse.finish(); expect(reverse.show).toHaveBeenCalledTimes(2);
  });
  it('stops work on unmount/source replacement and ignores late errors', async () => {
    const f = fixture(); f.pump.request(0); f.pump.request(.1); f.pump.stop();
    const old = await f.finish(); expect(old.image.close).toHaveBeenCalledOnce(); expect(f.show).not.toHaveBeenCalled();
    expect(f.read).toHaveBeenCalledTimes(1); f.pump.request(.2); expect(f.read).toHaveBeenCalledTimes(1);
    const g = fixture(); g.pump.request(0); g.pump.stop(); g.pending[0].reject(new Error('old decoder')); await flush(); expect(g.fail).not.toHaveBeenCalled();
  });
  it('reports a current decode failure and can display the next clock frame', async () => {
    const f = fixture(); f.pump.request(0); f.pump.request(.1); f.pending.shift()!.reject(new Error('decode')); await flush();
    expect(f.fail).toHaveBeenCalledOnce(); await f.finish(); expect(f.show).toHaveBeenCalledOnce();
  });
});
