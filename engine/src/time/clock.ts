// L9: one authoritative rational media clock. The frame index is the truth; microseconds,
// seconds, beats and audio sample positions are all derived from it, never stored, never
// accumulated. Ported from the spike's `Clock` and extended with musical time (L23) and the
// derived audio clock (L28).

import type { Rational } from '@moshpit/core';

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));

export function rational(num: number, den: number): Rational {
  if (!Number.isInteger(num) || !Number.isInteger(den) || den <= 0 || num <= 0) throw new RangeError(`bad rational ${num}/${den}`);
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

/** ffprobe's `30000/1001` form. */
export function parseRational(s: string): Rational {
  const [n, d = '1'] = s.split('/');
  return rational(+n, +d);
}

export const rationalString = (r: Rational) => `${r.num}/${r.den}`;

export class RationalClock {
  readonly fps: Rational;
  constructor(fps: Rational) {
    this.fps = rational(fps.num, fps.den);
  }
  /** Start of frame `i` in microseconds (WebCodecs timestamps). Rounded once, from the index. */
  us(i: number): number {
    return Math.round((i * 1e6 * this.fps.den) / this.fps.num);
  }
  /** Duration of frame `i`, as the difference of two derived starts so durations sum exactly. */
  durationUs(i: number): number {
    return this.us(i + 1) - this.us(i);
  }
  /** The frame whose start is nearest to `us`. */
  frameAtUs(us: number): number {
    return Math.round((us * this.fps.num) / (this.fps.den * 1e6));
  }
  seconds(i: number): number {
    return (i * this.fps.den) / this.fps.num;
  }
  /** The frame containing time `sec` (floor), the rule a scrub bar uses. */
  frameAtSeconds(sec: number): number {
    return Math.floor((sec * this.fps.num) / this.fps.den + 1e-9);
  }
  /** Frames in `beats` at `bpm`, as an exact rational before rounding (D4: round to frame, show ≈). */
  framesPerBeat(bpm: number): number {
    return (60 * this.fps.num) / (this.fps.den * bpm);
  }
  /** Musical duration → whole frames. `exact` is false when rounding moved it (the UI shows ≈). */
  beatsToFrames(beats: number, bpm: number): { frames: number; exact: boolean } {
    const f = beats * this.framesPerBeat(bpm);
    const frames = Math.round(f);
    return { frames, exact: Math.abs(frames - f) < 1e-9 };
  }
  framesToBeats(frames: number, bpm: number): number {
    return frames / this.framesPerBeat(bpm);
  }
}

/**
 * L28: the audio clock is derived from the frame clock, cumulatively, anchored at a clip's start.
 * `sample(n) = round(n × sampleRate × fpsDen / fpsNum)`. Frame n's audio is [sample(n), sample(n+1)),
 * so consecutive frames tile the sample line with no gap and no overlap however long the clip is.
 */
export class AudioClock {
  constructor(readonly frames: RationalClock, readonly sampleRate: number) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError(`bad sample rate ${sampleRate}`);
  }
  sample(n: number): number {
    const { num, den } = this.frames.fps;
    return Math.round((n * this.sampleRate * den) / num);
  }
  /** Samples belonging to frame n. Varies by ±1 at non-integer rates (48k at 30000/1001 is 1601.6). */
  samplesInFrame(n: number): number {
    return this.sample(n + 1) - this.sample(n);
  }
  /** The frame a sample position falls in. */
  frameOfSample(s: number): number {
    const { num, den } = this.frames.fps;
    let n = Math.floor((s * num) / (this.sampleRate * den));
    while (this.sample(n + 1) <= s) n++;
    while (n > 0 && this.sample(n) > s) n--;
    return n;
  }
}

/**
 * Moshpit 1's global LFO (`ops.ts:427 lfoValue`), on the timeline frame so its phase is a pure
 * function of position (L8): two blocks linked to one LFO continue the swell across the cut.
 * Period is in beats by default (L23). Returns 0..1.
 */
export function lfoValue(shape: string, periodFrames: number, phase: number, frame: number): number {
  const p = Math.max(1, periodFrames);
  const u = ((((frame / p) % 1) + phase) % 1 + 1) % 1;
  switch (shape) {
    case 'triangle': return u < 0.5 ? u * 2 : 2 - u * 2;
    case 'ramp': return u;
    case 'square': return u < 0.5 ? 0 : 1;
    default: return (1 - Math.cos(2 * Math.PI * u)) / 2;
  }
}
