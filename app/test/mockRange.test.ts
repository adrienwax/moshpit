// P0-B (independent audit): the mock engine honours importClip's range like the real one — the
// slice keeps its range, its conform counts only the slice's frames, and a sub-frame range is one frame.
import { describe, expect, it } from 'vitest';
import { createMockEngine } from '../src/engine/mockEngine';
import { LIBRARY } from '../src/engine/mockProject';

const clip = Object.values(LIBRARY).flat().find((c) => c.name === 'street_night.mp4')!; // 272 s

describe('mock importClip range', () => {
  it('a range import is a slice: source.range set, conform frames = slice length (24 fps default)', async () => {
    const r = await createMockEngine().importClip(clip.path, undefined, { range: { startSec: 10, durSec: 2 } }).promise;
    expect(r.source.range).toEqual({ startSec: 10, durSec: 2 });
    expect(r.conform.frames).toBe(48);
  }, 10000);

  it('a sub-frame range is clamped to one frame, never the whole file', async () => {
    const r = await createMockEngine().importClip(clip.path, undefined, { range: { startSec: 10, durSec: 0.01 } }).promise;
    expect(r.conform.frames).toBe(1);
  }, 10000);

  it('no range is the whole file, and slices of one file get distinct ids', async () => {
    const eng = createMockEngine();
    const whole = await eng.importClip(clip.path).promise;
    const a = await eng.importClip(clip.path, undefined, { range: { startSec: 0, durSec: 1 } }).promise;
    expect(whole.source.range).toBeUndefined();
    expect(whole.conform.frames).toBe(272 * 24);
    expect(a.source.id).not.toBe(whole.source.id);
  }, 10000);
});
