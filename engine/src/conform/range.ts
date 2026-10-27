// Browser-safe: the engine service and the UI's mock engine both clamp ranges with this one function.
import { MoshpitError } from '../errors';
import type { SourceRange } from '@moshpit/core';

/**
 * A requested slice, clipped to the file and at least ONE FRAME long at the project rate (P0-A,
 * independent audit). It never returns "no range": a 1-frame selection at 25/30/60 fps used to fall
 * under a 0.04 s floor and silently become a whole-file conform. Nothing usable → SLICE_RANGE_INVALID.
 */
export function validRange(r: SourceRange, durationSec: number, fps: { num: number; den: number }): SourceRange {
  const frame = fps.den / fps.num;
  if (!Number.isFinite(r.startSec) || !Number.isFinite(r.durSec) || r.durSec <= 0) throw new MoshpitError('SLICE_RANGE_INVALID', { range: r, why: 'empty or not a number' });
  const end = durationSec > 0 ? durationSec : Infinity;
  if (r.startSec >= end) throw new MoshpitError('SLICE_RANGE_INVALID', { range: r, durationSec, why: 'starts after the end of the file' });
  let start = Math.max(0, r.startSec);
  let dur = Math.min(r.durSec, end - start);
  if (dur < frame) {
    dur = frame;
    if (start + dur > end) start = Math.max(0, end - dur); // the last frame: keep it, move the start back
  }
  return { startSec: start, durSec: dur };
}
