import type { Rational } from '@moshpit/engine';

export { MUSDIV, fmtBeats, beatsToSec } from '../../../shared/ui/musicalTime';

export const fpsValue = (r: Rational) => r.num / r.den;

/** Frames → m:ss.ff (frame remainder, not centiseconds). */
/**
 * The one timecode (DESIGN-SYSTEM.md §6.1): HH:MM:SS:FF, non-drop-frame at the nominal rate
 * (29.97 counts 30 frames a second, as edit systems do). Exact frame numbers sit beside it.
 */
export function timecode(frame: number, fps: Rational): string {
  const n = Math.max(1, Math.round(fpsValue(fps)));
  const f = Math.max(0, Math.round(frame));
  const ss = Math.floor(f / n), p = (v: number) => String(v).padStart(2, '0');
  return `${p(Math.floor(ss / 3600))}:${p(Math.floor(ss / 60) % 60)}:${p(ss % 60)}:${p(f % n)}`;
}

export const fmtFps = (r: Rational) => (r.den === 1 ? String(r.num) : (r.num / r.den).toFixed(3));

/** Timeline frame → "bar.beat" at the project BPM (4/4). */
export function barsBeats(frame: number, fps: Rational, bpm: number): string {
  const beats = (frame / fpsValue(fps)) * (bpm / 60);
  return `${Math.floor(beats / 4) + 1}.${Math.floor(beats % 4) + 1}`;
}
