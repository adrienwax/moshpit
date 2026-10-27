import { describe, expect, it, vi } from 'vitest';
import { sameSourceRange, transposeRange } from '../src/lib/sourceRange';
import { rangeDrag } from '../src/lib/rangeDrag';

describe('duration-preserving source range movement', () => {
  it('clamps a single delta at both ends including one-frame and full-source ranges', () => {
    expect(transposeRange({ in: 10, out: 30 }, -50, 100)).toEqual({ in: 0, out: 20 });
    expect(transposeRange({ in: 10, out: 30 }, 100, 100)).toEqual({ in: 80, out: 100 });
    expect(transposeRange({ in: 0, out: 100 }, 5, 100)).toEqual({ in: 0, out: 100 });
    expect(transposeRange({ in: 99, out: 100 }, -200, 100)).toEqual({ in: 0, out: 1 });
  });
  it('keeps integer source frames and length across fractional pointer movement at any source rate', () => {
    for (const frames of [1, 24, 240, 299, 1000]) {
      for (const delta of [-2000, -4.8, -.3, 0, .7, 3.1, 2000]) {
        const original = { in: Math.floor(frames / 4), out: Math.max(1, Math.ceil(frames * .75)) };
        const moved = transposeRange(original, delta, frames);
        expect(moved.out - moved.in).toBe(original.out - original.in);
        expect(moved.in).toBeGreaterThanOrEqual(0); expect(moved.out).toBeLessThanOrEqual(frames);
        expect(Number.isInteger(moved.in) && Number.isInteger(moved.out)).toBe(true);
      }
    }
  });
});

function setup() {
  class Target extends EventTarget {
    ownerDocument = new EventTarget();
    captures = new Set<number>();
    setPointerCapture(id: number) { this.captures.add(id); }
    hasPointerCapture(id: number) { return this.captures.has(id); }
    releasePointerCapture(id: number) { this.captures.delete(id); }
  }
  const target = new Target(); let current = true;
  const move = vi.fn(), restore = vi.fn(), end = vi.fn();
  const cancel = rangeDrag({ target: target as unknown as HTMLElement, pointerId: 7, startX: 30, current: () => current, move, restore, end });
  const pointer = (type: string, clientX: number, pointerId = 7) => target.dispatchEvent(Object.assign(new Event(type), { clientX, pointerId }));
  const escape = () => target.ownerDocument.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
  return { target, move, restore, end, cancel, pointer, escape, changed: () => { current = false; } };
}
describe('range grip pointer lifecycle', () => {
  it('keeps the initial grab offset, filters other pointers and finishes only once', () => {
    const g = setup(); g.pointer('pointermove', 40); g.pointer('pointermove', 100, 8); g.pointer('pointermove', 50); g.pointer('pointerup', 55);
    expect(g.move.mock.calls).toEqual([[10], [20], [25]]); expect(g.restore).not.toHaveBeenCalled(); expect(g.end).toHaveBeenCalledOnce();
    expect(g.end).toHaveBeenCalledWith(false);
    expect(g.target.captures.size).toBe(0); g.pointer('pointermove', 500); g.escape(); g.cancel(); expect(g.end).toHaveBeenCalledOnce();
  });
  it.each(['Escape', 'pointercancel', 'lostpointercapture', 'unmount'])('restores original marks and detaches input on %s', reason => {
    const g = setup(); g.pointer('pointermove', 70);
    if (reason === 'Escape') g.escape(); else if (reason === 'unmount') g.cancel(); else g.pointer(reason, 70);
    expect(g.restore).toHaveBeenCalledOnce(); expect(g.end).toHaveBeenCalledExactlyOnceWith(true); expect(g.target.captures.size).toBe(0);
    g.pointer('pointerup', 90); g.pointer('pointermove', 100); g.escape(); expect(g.move).toHaveBeenCalledTimes(1); expect(g.restore).toHaveBeenCalledOnce();
  });
  it('cancels without writing or restoring into a replacement clip', () => {
    const g = setup(); g.pointer('pointermove', 50); g.changed(); g.pointer('pointermove', 70); g.pointer('pointerup', 90);
    expect(g.move).toHaveBeenCalledExactlyOnceWith(20); expect(g.restore).not.toHaveBeenCalled(); expect(g.end).toHaveBeenCalledOnce();
  });
});

describe('source selection identity', () => {
  it.each([{num:60,den:1},{num:120,den:1},{num:60000,den:1001}])('distinguishes adjacent ranges at $num/$den while reusing identical roundtrips', fps => {
    const range = (start: number, end: number) => ({startSec:start*fps.den/fps.num,durSec:(end-start)*fps.den/fps.num});
    const original=range(72,132);
    expect(sameSourceRange(original,JSON.parse(JSON.stringify(original)),fps)).toBe(true);
    expect(sameSourceRange(original,range(73,133),fps)).toBe(false);
    expect(sameSourceRange(original,range(72,133),fps)).toBe(false);
    expect(sameSourceRange(undefined,undefined,fps)).toBe(true);
    expect(sameSourceRange(original,undefined,fps)).toBe(false);
  });
});
