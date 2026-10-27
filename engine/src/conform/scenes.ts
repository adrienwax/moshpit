// §1b: scene detection → advisory chapters, stored per source clip in rational frames.
// Ported from Moshpit 2.0 (host/server.mjs:176 scdet route, host/media-tools.mjs:51
// parseSceneSuggestions, 0.5 s minimum shot as in shotlab analyze.mjs) with two changes:
//   - no 600 s cap (audit W7): a 90-minute source is the case §1b exists for;
//   - it runs on the keyframe-locked proxy, so a cut lands on the conform's own frame index and
//     the pass costs a fraction of the master's decode (the sweep measured ~13 min per 90 min).
// Deterministic for a given {conform hash, threshold}, so results are cacheable (L11).

import type { Chapter, ChapterId, ConformedSource } from '../model';
import { newId } from '@moshpit/core';
import { findFfmpeg, run } from './ffmpeg';

export interface Cut { frame: number; score: number | null }

/** Moshpit 2.0's parser, returning frames instead of seconds. */
export function parseScdet(stderr: string, fps: { num: number; den: number }, frames: number, minShotFrames: number): Cut[] {
  const cuts: Cut[] = [];
  let score: number | null = null, prev = 0;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /lavfi\.scd\.score=([\d.]+)/.exec(line);
    if (s) score = Number(s[1]);
    const t = /lavfi\.scd\.time=([\d.]+)/.exec(line);
    if (!t) continue;
    const frame = Math.round((Number(t[1]) * fps.num) / fps.den);
    if (frame - prev < minShotFrames || frames - frame < minShotFrames) continue;
    cuts.push({ frame, score: Number.isFinite(score) ? score : null });
    prev = frame;
  }
  return cuts;
}

/** Chapters between cuts. User-edited chapters in `keep` survive a re-run (§1b). */
export function chaptersFromCuts(cuts: Cut[], frames: number, threshold: number, keep: Chapter[] = []): Chapter[] {
  const edges = [0, ...cuts.map((c) => c.frame), frames];
  const auto: Chapter[] = [];
  for (let i = 0; i + 1 < edges.length; i++) auto.push({ id: newId<ChapterId>(), start: edges[i], end: edges[i + 1], autoDetected: true, threshold, label: `Scene ${i + 1}` });
  return [...keep.filter((c) => !c.autoDetected), ...auto].sort((a, b) => a.start - b.start);
}

export async function detectCuts(c: ConformedSource, sensitivity = 0.5, opts: { ffmpeg?: string; minShotSec?: number; signal?: AbortSignal } = {}): Promise<Cut[]> {
  const { ffmpeg } = findFfmpeg(opts.ffmpeg);
  // scdet's threshold is a percentage score: high sensitivity → low threshold. 0.5 maps to ~10,
  // ffmpeg's own default; hard cuts in the fixtures score 23–25.
  const k = Math.max(0, Math.min(1, sensitivity));
  const threshold = 3 + (1 - k) * (1 - k) * 27;
  const file = c.proxy?.path ?? c.path;
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'info', '-i', file, '-an', '-vf', `scdet=threshold=${threshold.toFixed(1)}:sc_pass=1,metadata=mode=print`, '-f', 'null', '-'], { signal: opts.signal });
  const minShot = Math.round(((opts.minShotSec ?? 0.5) * c.fps.num) / c.fps.den);
  return parseScdet(stderr, c.fps, c.frames, minShot);
}
