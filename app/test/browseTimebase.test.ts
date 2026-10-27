import { describe, expect, it } from 'vitest';
import type { Chapter } from '@moshpit/engine';
import { chapterPreviewFrame, chaptersToConform, chaptersToRaw, mergeChapterIds, rawPreviewFrame } from '../src/ws/browse/browseTimebase';
const raw = { fps: { num: 25, den: 1 }, frames: 250, durationSec: 10 };
const conform = { fps: { num: 60, den: 1 }, frames: 600 };
const chapter = (id: string, start: number, end: number): Chapter => ({ id: id as Chapter['id'], start, end, label: id, autoDetected: true });

describe('IN raw file and conform clocks', () => {
  it('previews the same five-second moment at 25-to-60 fps and clamps actual frame requests', () => {
    expect(rawPreviewFrame(125, raw, conform)).toBe(300);
    expect(rawPreviewFrame(-1, raw, conform)).toBe(0);
    expect(rawPreviewFrame(999, raw, conform)).toBe(598);
    expect(rawPreviewFrame(125, raw, { ...conform, frames: 120 })).toBe(119);
  });
  it('uses conform metadata rather than an assumed project clock, including fractional source rates', () => {
    expect(rawPreviewFrame(300, { fps: { num: 30000, den: 1001 }, frames: 600, durationSec: 20.02 }, conform)).toBe(599);
    expect(rawPreviewFrame(240, { fps: { num: 24000, den: 1001 }, frames: 480, durationSec: 20.02 }, { ...conform, frames: 1201 })).toBe(601);
    expect(rawPreviewFrame(125, raw, { fps: { num: 24, den: 1 }, frames: 240 })).toBe(120);
  });
  it('shows detected chapters in raw frames and keeps exclusive OUT at the raw endpoint', () => {
    const originals = [chapter('a', 0, 300), chapter('b', 300, 600)];
    expect(chaptersToRaw(originals, raw, conform).map(ch => [ch.start, ch.end])).toEqual([[0, 125], [125, 250]]);
    expect(originals[1].start).toBe(300);
    expect(chaptersToConform(chaptersToRaw(originals, raw, conform), raw, conform)).toEqual(originals);
  });
  it('omits sub-raw-frame chapters rather than drawing negative, empty or overlapping ranges', () => {
    expect(chaptersToRaw([chapter('a', -30, 300), chapter('tiny', 300, 301), chapter('b', 301, 999)], raw, conform)
      .map(ch => [ch.id, ch.start, ch.end])).toEqual([['a', 0, 125], ['b', 125, 250]]);
  });
  it('merges native conform boundaries without a lossy raw-frame round trip', () => {
    const originals = [chapter('a', 0, 301), chapter('tiny', 301, 302), chapter('b', 302, 421), chapter('c', 421, 600)];
    const next = mergeChapterIds(originals, originals[0].id, originals[2].id);
    expect(next.map(ch => [ch.id, ch.start, ch.end])).toEqual([['a', 0, 421], ['c', 421, 600]]);
    expect(originals[0].end).toBe(301);
  });
  it('chapter thumbnails keep the exact native cut frame instead of its rounded raw position', () => {
    const original = chapter('b', 301, 600), display = chaptersToRaw([original], raw, conform)[0];
    expect(display.start).toBe(125);
    expect(chapterPreviewFrame(display, [original], raw, conform)).toBe(301);
  });
  it('converts session chapters on import and bounds the last endpoint to the actual conform', () => {
    expect(chaptersToConform([chapter('a', 0, 125), chapter('b', 125, 250)], raw, { ...conform, frames: 599 })
      .map(ch => [ch.start, ch.end])).toEqual([[0, 300], [300, 599]]);
  });
});
