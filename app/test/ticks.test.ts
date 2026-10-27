import { describe, expect, it } from 'vitest';
import { compactRulerLabel, musicSteps, pickTicks, tickFrames, timeSteps } from '../src/lib/ticks';
import { conformToRaw, rawFrames, rawToConform } from '../src/lib/frames';

describe('timeline ticks', () => {
  it('labels seconds compactly and reveals frame detail only when zoomed', () => {
    expect(compactRulerLabel('00:00:05:12', false)).toBe('5s');
    expect(compactRulerLabel('00:00:05:12', true)).toBe('5s+12f');
    expect(compactRulerLabel('00:00:00:00', true)).toBe('0s');
    expect(compactRulerLabel('00:01:05:00', false)).toBe('1:05');
    expect(compactRulerLabel('01:02:05:23', false)).toBe('1:02:05');
    expect(compactRulerLabel('bar 1', true)).toBe('bar 1');
  });
  it('a whole 2-minute clip at 30 fps across 1000px: labelled every 15 s (10 s would be 83px), minor 5 s, fine 1 s', () => {
    const t = pickTicks(3600, 1000, timeSteps(30));
    expect(t.major).toBe(450);
    expect(t.minor).toBe(150);
    expect(t.fine).toBe(30);
  });
  it('zoomed to 60 frames across 1000px: fine single frames appear under the minor tier', () => {
    const t = pickTicks(60, 1000, timeSteps(30));
    expect(t.fine).toBe(1);
    expect(t.minor).toBeGreaterThan(1);
    expect(t.major % t.minor).toBe(0);
  });
  it('musical: 16 bars across 1200px label every 2 bars (one bar is 75px), bars minor, beats fine', () => {
    const beat = 15; // 120 BPM at 30 fps
    const t = pickTicks(60 * 16, 1200, musicSteps(beat));
    expect(t.major).toBe(120);
    expect(t.minor).toBe(60);
    expect(t.fine).toBe(15);
  });
  it('tick positions stay inside the view and are capped', () => {
    expect(tickFrames(30, 45, 100)).toEqual([60, 90, 120]);
    expect(tickFrames(1, 0, 10_000, 600).length).toBe(600);
    expect(tickFrames(0, 0, 100)).toEqual([]);
  });
});

describe('raw ↔ conform frames', () => {
  const f = (num: number, den = 1) => ({ num, den });
  it('distrusts a container frame count that overruns the duration (measured GoPro case)', () => {
    expect(rawFrames({ frames: 666, durationSec: 19.983267, fps: f(30000, 1001) })).toBe(599);
    expect(rawFrames({ frames: 598, durationSec: 19.983267, fps: f(30000, 1001) })).toBe(598);
  });
  it('a mark moves by time across rates: 10 s at 25 fps is 10 s at 24 fps', () => {
    expect(rawToConform(250, f(25), f(24))).toBe(240);
    expect(conformToRaw(240, f(25), f(24))).toBe(250);
  });
});
