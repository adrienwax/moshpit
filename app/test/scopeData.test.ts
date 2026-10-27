import { describe, expect, it } from 'vitest';
import { accumulateScope, analyse, chromaPosition, newScopeData, PARADE_COLUMNS, PARADE_LEVELS, scopeRange, VECTOR_SIZE } from '../src/scopes/data';

function pixels(width: number, rows: number[][][]) {
  return { width, height: rows.length, data: new Uint8ClampedArray(rows.flatMap(row => row.flatMap(rgb => rgb.length === 4 ? rgb : [...rgb, 255]))) };
}
const sum = (values: ArrayLike<number>) => Array.from(values).reduce((a, b) => a + b, 0);

describe('shared display RGB scope measurements', () => {
  it('preserves two levels in one image column instead of reducing waveform to an average', () => {
    const data = analyse(pixels(1, [[[0, 0, 0]], [[255, 255, 255]]]));
    for (const channel of data.parade) {
      expect(channel[0]).toBe(1);
      expect(channel[(PARADE_LEVELS - 1) * PARADE_COLUMNS]).toBe(1);
      expect(channel[64 * PARADE_COLUMNS]).toBe(0);
      expect(sum(channel)).toBe(2);
    }
  });
  it('keeps red and blue pixels in their image positions in each separate channel', () => {
    const data = analyse(pixels(2, [[[255, 0, 0], [0, 0, 255]]]));
    expect(data.parade[0][127 * PARADE_COLUMNS]).toBe(1);
    expect(data.parade[0][48]).toBe(1);
    expect(data.parade[2][0]).toBe(1);
    expect(data.parade[2][127 * PARADE_COLUMNS + 48]).toBe(1);
  });
  it('counts full-resolution RGB bins and Rec.709 weighted luma separately', () => {
    const data = analyse(pixels(3, [[[255, 0, 0], [0, 255, 0], [0, 0, 255]]]));
    expect(data.hist.map(sum)).toEqual([3, 3, 3, 3]);
    expect(data.hist[0][255]).toBe(1);
    expect(data.hist[0][0]).toBe(2);
    expect(data.hist[3][54]).toBe(1);
    expect(data.hist[3][182]).toBe(1);
    expect(data.hist[3][18]).toBe(1);
  });
  it('places neutral RGB at the vectorscope centre regardless of brightness', () => {
    for (const value of [0, 32, 128, 255]) {
      const [x, y] = chromaPosition(value, value, value);
      expect(x).toBeCloseTo(.5); expect(y).toBeCloseTo(.5);
    }
    const data = analyse(pixels(1, [[[128, 128, 128]]]));
    expect(data.vectorDensity[64 * VECTOR_SIZE + 64]).toBe(1);
  });
  it('orients chroma as Cb right and Cr up', () => {
    const red = chromaPosition(255, 0, 0), blue = chromaPosition(0, 0, 255);
    expect(red[0]).toBeLessThan(.5); expect(red[1]).toBeLessThan(.5);
    expect(blue[0]).toBeGreaterThan(.5); expect(blue[1]).toBeGreaterThan(.5);
    const quarterRed = chromaPosition(63.75, 0, 0);
    expect(quarterRed[0] - .5).toBeCloseTo((red[0] - .5) / 4);
  });
  it('counts every visible pixel of odd image sizes with an actual sampled denominator', () => {
    const data = analyse(pixels(3, [[[255, 255, 255], [255, 255, 255, 0], [0, 0, 0]]]));
    expect(data.samples).toBe(2); expect(data.highlights).toBe(1); expect(data.clip).toBe(.5);
    expect(sum(data.vectorDensity)).toBe(2);
    expect(data.hist.map(sum)).toEqual([2, 2, 2, 2]);
  });
  it('pools range densities without turning frames into an average image', () => {
    const data = newScopeData();
    accumulateScope(data, pixels(1, [[[0, 0, 0]]]));
    accumulateScope(data, pixels(1, [[[255, 255, 255]]]));
    expect(data.frames).toBe(2); expect(data.samples).toBe(2);
    expect(data.hist[0][0]).toBe(1); expect(data.hist[0][255]).toBe(1);
    expect(data.hist[0][128]).toBe(0); expect(data.clip).toBe(.5);
  });
  it('returns finite empty measurements and excludes completely transparent signal', () => {
    const data = analyse(pixels(1, [[[255, 255, 255, 0]]]));
    expect(data.clip).toBe(0); expect(data.samples).toBe(0);
    expect(data.wave.every(Number.isFinite)).toBe(true);
    expect(sum(data.vectorDensity)).toBe(0);
  });
  it('does not confuse saturated red with near-white luma', () => {
    expect(analyse(pixels(1, [[[255, 0, 0]]])).clip).toBe(0);
  });
});

describe('scope range bounds', () => {
  it('fits an oversized old window to a shorter project like the arrangement does', () => {
    expect(scopeRange(20, { start: 900, len: 50, of: 1000 })).toEqual([0, 19]);
  });
  it('preserves the visible window length when a zoomed project is shortened', () => {
    expect(scopeRange(300, { start: 800, len: 100, of: 1000 })).toEqual([200, 299]);
  });
  it.each([undefined, { start: NaN, len: 5, of: 10 }, { start: 0, len: Infinity, of: 10 }, { start: 5, len: -2, of: 10 }])('falls back to the full timeline for invalid zoom %o', zoom => {
    expect(scopeRange(20, zoom)).toEqual([0, 19]);
  });
  it('returns no range for an empty timeline', () => expect(scopeRange(0)).toBeNull());
});
