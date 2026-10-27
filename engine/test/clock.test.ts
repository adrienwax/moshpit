import { describe, expect, it } from 'vitest';
import { AudioClock, RationalClock, lfoValue, parseRational } from '../src/time/clock';
import { canonicalJSON, hash53, seeded } from '../src/util/determinism';

const ntsc = new RationalClock(parseRational('30000/1001'));

describe('rational clock (L9)', () => {
  it('derives timestamps from the index, never by accumulation', () => {
    let acc = 0;
    for (let i = 0; i < 72000; i++) acc += ntsc.durationUs(i); // 40 minutes
    expect(acc).toBe(ntsc.us(72000));
    expect(ntsc.us(72000)).toBe(2402400000);
  });
  it('round-trips frame → µs → frame for every frame of a 40-minute timeline', () => {
    for (let i = 0; i < 72000; i++) if (ntsc.frameAtUs(ntsc.us(i)) !== i) throw new Error(`frame ${i}`);
  });
  it('reduces the rational', () => {
    expect(new RationalClock({ num: 60, den: 2 }).fps).toEqual({ num: 30, den: 1 });
  });
  it('flags musical lengths that do not land on a frame (D4: ≈)', () => {
    const c30 = new RationalClock({ num: 30, den: 1 });
    expect(c30.beatsToFrames(1, 120)).toEqual({ frames: 15, exact: true });
    expect(ntsc.beatsToFrames(1, 120)).toEqual({ frames: 15, exact: false });
  });
});

describe('audio clock (L28)', () => {
  const a = new AudioClock(ntsc, 48000);
  it('tiles the sample line with no gap or overlap over 40 minutes', () => {
    let total = 0;
    for (let n = 0; n < 72000; n++) total += a.samplesInFrame(n);
    expect(total).toBe(a.sample(72000));
    expect(a.sample(72000)).toBe(Math.round((72000 * 48000 * 1001) / 30000));
  });
  it('alternates 1601/1602 samples per frame at 48k NTSC', () => {
    const counts = new Set(Array.from({ length: 100 }, (_, n) => a.samplesInFrame(n)));
    expect([...counts].sort()).toEqual([1601, 1602]);
  });
  it('maps every sample back to the frame that owns it', () => {
    for (const n of [0, 1, 2, 999, 35999, 71999]) {
      expect(a.frameOfSample(a.sample(n))).toBe(n);
      expect(a.frameOfSample(a.sample(n + 1) - 1)).toBe(n);
    }
  });
});

describe('LFO (L8)', () => {
  it('is a pure function of the timeline frame, so phase is continuous across a block boundary', () => {
    const v = (f: number) => lfoValue('sine', 60, 0.25, f);
    expect(v(100)).toBe(v(100));
    expect(Math.abs(v(101) - v(100))).toBeLessThan(0.11);
  });
  it('starts sine and triangle quiet at phase 0 (Moshpit 1 behaviour)', () => {
    expect(lfoValue('sine', 60, 0, 0)).toBe(0);
    expect(lfoValue('triangle', 60, 0, 0)).toBe(0);
    expect(lfoValue('square', 60, 0, 45)).toBe(1);
  });
});

describe('determinism helpers (L11)', () => {
  it('seeded values depend on every input and nothing else', () => {
    const base = seeded(1, 2, 3, 4, 5);
    expect(seeded(1, 2, 3, 4, 5)).toBe(base);
    for (const v of [seeded(9, 2, 3, 4, 5), seeded(1, 9, 3, 4, 5), seeded(1, 2, 9, 4, 5), seeded(1, 2, 3, 9, 5), seeded(1, 2, 3, 4, 9)]) expect(v).not.toBe(base);
    const out = new Float32Array(1);
    expect(seeded(1, 2, 3, 4, 5, out)).toBe(0);
    expect(out[0]).toBeCloseTo(base, 6);
  });
  it('hash53 writes into a slot without returning a double', () => {
    const w = new Uint32Array([1, 2, 3]), out = new Float64Array(2);
    expect(hash53(w, out, 1)).toBe(0);
    expect(out[1]).toBe(hash53(w));
  });
  it('canonical JSON ignores key order', () => {
    expect(canonicalJSON({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 3 } })).toBe(canonicalJSON({ a: { c: 3, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  });
});
