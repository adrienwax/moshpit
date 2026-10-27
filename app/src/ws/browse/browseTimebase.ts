import type { Chapter, ConformedSource, SourceProbe } from '@moshpit/engine';
import { conformToRaw, rawFrames, rawToConform } from '../../lib/frames';

type RawClock = Pick<SourceProbe, 'fps' | 'frames' | 'durationSec'>;
type ConformClock = Pick<ConformedSource, 'fps' | 'frames'>;
const clamp = (frame: number, end: number) => Math.max(0, Math.min(end, Number.isFinite(frame) ? Math.round(frame) : 0));

/** IN addresses the original file even when its stopped preview is served from a conform. */
export function rawPreviewFrame(frame: number, raw: RawClock, conform: ConformClock): number {
  return clamp(rawToConform(clamp(frame, rawFrames(raw) - 1), raw.fps, conform.fps), Math.max(0, conform.frames - 1));
}

/** A chapter thumbnail should show its first actual conform frame, not the raw ruler's rounding. */
export function chapterPreviewFrame(chapter: Chapter, originals: Chapter[], raw: RawClock, conform: ConformClock): number {
  const original = originals.find(ch => ch.id === chapter.id);
  return original ? clamp(original.start, Math.max(0, conform.frames - 1)) : rawPreviewFrame(chapter.start, raw, conform);
}

function mapChapters(chapters: Chapter[], convert: (frame: number) => number, total: number): Chapter[] {
  return chapters.flatMap(ch => {
    const start = clamp(convert(ch.start), total), end = clamp(convert(ch.end), total);
    // A conform shot shorter than one raw frame cannot be represented by this raw ruler.
    return end > start ? [{ ...ch, start, end }] : [];
  });
}

export const chaptersToRaw = (chapters: Chapter[], raw: RawClock, conform: ConformClock): Chapter[] =>
  mapChapters(chapters, frame => conformToRaw(frame, raw.fps, conform.fps), rawFrames(raw));

export const chaptersToConform = (chapters: Chapter[], raw: RawClock, conform: ConformClock): Chapter[] =>
  mapChapters(chapters, frame => rawToConform(frame, raw.fps, conform.fps), conform.frames);

/** Merge in the chapters' native clock; never round-trip surviving conform boundaries via raw. */
export function mergeChapterIds(chapters: Chapter[], previousId: Chapter['id'], currentId: Chapter['id']): Chapter[] {
  const previous = chapters.findIndex(ch => ch.id === previousId), current = chapters.findIndex(ch => ch.id === currentId);
  if (previous < 0 || current <= previous) return chapters;
  const next = chapters.map(ch => ({ ...ch }));
  next[previous].end = next[current].end;
  next.splice(previous + 1, current - previous);
  return next.map((ch, i) => ({ ...ch, label: `Chapter ${i + 1}` }));
}
