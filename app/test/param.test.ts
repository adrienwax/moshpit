// Typed values stay exact; compact percent readouts do not change the stored value.
import { describe, expect, it } from 'vitest';
import { fmtValue, parseTyped, type ParamSpec } from '../src/params/Param';

const rate: ParamSpec = { label: 'Rate', type: 'float', min: 10, max: 400, default: 100, unit: '%' };
const trim: ParamSpec = { label: 'IN', type: 'int', min: 0, max: 3000, step: 1, default: 0 };
const time: ParamSpec = { label: 'Period', type: 'beats', min: 0.25, max: 32, default: 4 };

describe('typed values', () => {
  it('keeps a float exactly as typed (no snapping to the drag step), with or without its unit', () => {
    expect(parseTyped(rate, '137.43', 120, false)).toBe(137.43);
    expect(parseTyped(rate, '137.43 %', 120, false)).toBe(137.43);
    expect(parseTyped(rate, '137,5', 120, false)).toBe(137.5); // a decimal comma works too
  });
  it('clamps to the range and rounds an int', () => {
    expect(parseTyped(rate, '9999', 120, false)).toBe(400);
    expect(parseTyped(trim, '1234.6', 120, false)).toBe(1235);
    expect(parseTyped(trim, '-5', 120, false)).toBe(0);
  });
  it('reads beats as beats, or seconds when the field shows seconds', () => {
    expect(parseTyped(time, '2', 120, false)).toBe(2);
    expect(parseTyped(time, '1 s', 120, true)).toBe(2); // 1 s at 120 BPM = 2 beats
  });
  it('refuses what is not a number (the editor stays open and says so)', () => {
    expect(parseTyped(rate, 'abc', 120, false)).toBeNaN();
    expect(parseTyped(rate, '', 120, false)).toBeNaN();
  });
});

describe('readouts', () => {
  it('keeps percent readouts compact while retaining small nonzero amounts', () => {
    expect(fmtValue(rate, 137, 120, false)).toBe('137%');
    expect(fmtValue(rate, 137.43, 120, false)).toBe('137.4%');
    expect(fmtValue(rate, 0.01234, 120, false)).toBe('0.012%');
    expect(fmtValue(rate, 0.000001, 120, false)).toBe('<0.0001%');
    expect(fmtValue(rate, 0, 120, false)).toBe('0%');
    expect(parseTyped(rate, '137.43', 120, false)).toBe(137.43);
    expect(fmtValue(trim, 1235, 120, false)).toBe('1235');
  });
});
