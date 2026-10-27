export interface SourceRange { in: number; out: number }
/** Exclusive OUT, integer source frames. Clamp the delta once so duration cannot change. */
export function transposeRange(range: SourceRange, requested: number, total: number): SourceRange {
  const delta = Math.max(-range.in, Math.min(total - range.out, Number.isFinite(requested) ? Math.round(requested) : 0));
  return { in: range.in + delta, out: range.out + delta };
}

/** Compare source-frame boundaries, preserving adjacent selections at high/fractional rates. */
export function sameSourceRange(a: { startSec: number; durSec: number } | undefined, b: { startSec: number; durSec: number } | undefined, fps: { num: number; den: number }): boolean {
  if (!a || !b) return a === b;
  const frame = (seconds: number) => Math.round(seconds * fps.num / fps.den);
  return frame(a.startSec) === frame(b.startSec) && frame(a.startSec + a.durSec) === frame(b.startSec + b.durSec);
}
