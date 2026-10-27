// Timeline ticks (usability plan §2b, Waxy's Phase D item 5): three tiers — major (labelled),
// minor, fine — picked from the zoom so each tier keeps a readable spacing. Pure, for the test.

export interface TickSet {
  /** Step between ticks, in frames, per tier; 0 = tier hidden at this zoom. */
  major: number;
  minor: number;
  fine: number;
}

const MIN_PX = { major: 90, minor: 14, fine: 6 };

/** Keep the existing timecode's frame convention, but omit irrelevant leading fields on rulers. */
export function compactRulerLabel(timecode: string, showFrames: boolean): string {
  const match = /^(\d+):(\d{2}):(\d{2}):(\d{2,})$/.exec(timecode);
  if (!match) return timecode;
  const [, hh, mm, ss, ff] = match;
  const h = Number(hh), m = Number(mm), s = Number(ss), f = Number(ff);
  const base = h ? `${h}:${mm}:${ss}` : m ? `${m}:${ss}` : `${s}s`;
  return showFrames && f ? `${base}+${f}f` : base;
}

/** Candidate steps in frames, ascending; every step divides the next one up where possible. */
export function timeSteps(fps: number): number[] {
  const s = (sec: number) => Math.round(sec * fps);
  return [...new Set([1, 2, 5, 10, s(0.5), s(1), s(2), s(5), s(10), s(15), s(30), s(60), s(120), s(300), s(600)])].filter((x) => x > 0).sort((a, b) => a - b);
}

/** Musical steps: a beat, then bars in powers of two. Fractional frames are fine (positions round). */
export function musicSteps(beatFrames: number): number[] {
  const bar = beatFrames * 4;
  return [beatFrames, bar, bar * 2, bar * 4, bar * 8, bar * 16, bar * 32, bar * 64];
}

/**
 * Pick the tiers for `lenFrames` shown across `widthPx`. Major: the smallest step at least 90px
 * apart. Minor: the largest smaller step at least 14px apart that divides the major. Fine: the same
 * again under the minor at 6px (single frames when zoomed in, beats under bars).
 */
export function pickTicks(lenFrames: number, widthPx: number, steps: number[]): TickSet {
  const px = widthPx / Math.max(1, lenFrames);
  const major = steps.find((s) => s * px >= MIN_PX.major) ?? steps[steps.length - 1];
  const divides = (a: number, b: number) => Math.abs(b / a - Math.round(b / a)) < 1e-6;
  const below = (top: number, min: number) => (top ? [...steps].reverse().find((s) => s < top && s * px >= min && divides(s, top)) ?? 0 : 0);
  const minor = below(major, MIN_PX.minor);
  const fine = below(minor, MIN_PX.fine);
  return { major, minor, fine };
}

/** Tick positions (frames) of one tier inside [start, start + len]. */
export function tickFrames(step: number, start: number, len: number, cap = 600): number[] {
  if (!step) return [];
  const out: number[] = [];
  for (let f = Math.ceil(start / step) * step; f <= start + len && out.length < cap; f += step) out.push(f);
  return out;
}
