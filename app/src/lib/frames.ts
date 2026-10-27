// Which frames a slice is counted in. Two spaces exist and must not be mixed:
//   raw     — the file as it is, at its own rate (Source's browser and raw preview)
//   conform — the clip conformed to the project rate (L9); blocks and saved marks live here
// Moving a mark across the import boundary converts by time, never by index.
import type { ConformedSource, Rational, SourceClip, SourceProbe } from '@moshpit/engine';
import { fpsValue } from './time';

/**
 * Frames in the raw file. The container's own count is not trusted when it disagrees with the
 * duration: a GoPro clip measured probe.frames 666 for 19.98 s at 29.97 (599 real frames).
 */
export function rawFrames(p: Pick<SourceProbe, 'frames' | 'durationSec' | 'fps'>): number {
  const byTime = Math.max(1, Math.round(p.durationSec * fpsValue(p.fps)));
  return p.frames && p.frames <= byTime + 1 ? p.frames : byTime;
}

/** Frames on the conform: its own count when there is one, else the raw length at the project rate. */
export function conformFrames(src: SourceClip, conform: ConformedSource | undefined, projectFps: Rational): number {
  if (conform?.frames) return conform.frames;
  return Math.max(1, Math.round(src.probe.durationSec * fpsValue(projectFps)));
}

/** A raw-file frame → the conform frame at the same time, and back. */
export const rawToConform = (f: number, rawFps: Rational, projectFps: Rational) => Math.round((f / fpsValue(rawFps)) * fpsValue(projectFps));
export const conformToRaw = (f: number, rawFps: Rational, projectFps: Rational) => Math.round((f / fpsValue(projectFps)) * fpsValue(rawFps));
