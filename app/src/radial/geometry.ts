// Pie geometry. Slots run clockwise from North and are evenly spaced, so a given menu's slots
// never move (spatial constancy: "add is north" forever). Direction selects, not distance:
// every slice is an infinite wedge, except the centre dead-zone, where nothing fires.

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
/** Wedges are narrow; two balanced lines retain readable names instead of truncating meaning. */
export function radialLabelLines(text: string): string[] {
  if (text.length <= 13) return [text];
  const amp = text.indexOf(' & ');
  if (amp > 0) return [text.slice(0, amp), text.slice(amp + 1)];
  const spaces = [...text.matchAll(/\s/g)].map(m => m.index!);
  if (!spaces.length) return [text];
  const cut = spaces.sort((a, b) => Math.abs(a - text.length / 2) - Math.abs(b - text.length / 2))[0];
  return [text.slice(0, cut), text.slice(cut + 1)];
}
export type Compass = (typeof COMPASS)[number];

/** Clockwise angle of slot i of n, degrees from North. */
export const slotAngle = (i: number, n: number) => (i * 360) / n;

/** Compass name of slot i of n (4 → N E S W; 6 → N NE SE S SW NW). */
export function slotCompass(i: number, n: number): Compass {
  const a = slotAngle(i, n);
  return COMPASS[Math.round(a / 45) % 8];
}

/** The slot a pointer offset points at, or -1 inside the dead-zone. Screen y grows downward. */
export function sliceAt(dx: number, dy: number, n: number, deadZone: number): number {
  if (n <= 0 || Math.hypot(dx, dy) < deadZone) return -1;
  const a = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  return Math.round(a / (360 / n)) % n;
}

/** Index of the slot sitting due South, if any: the ring's Back slot by convention. */
export const southSlot = (n: number) => (n % 2 === 0 ? n / 2 : -1);

/** SVG path for an annular sector between radii r1..r2, centred on `mid` degrees (from North). */
export function sectorPath(cx: number, cy: number, r1: number, r2: number, mid: number, span: number): string {
  const pt = (r: number, deg: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  };
  const a0 = mid - span / 2;
  const a1 = mid + span / 2;
  const large = span > 180 ? 1 : 0;
  return `M${pt(r2, a0)} A${r2} ${r2} 0 ${large} 1 ${pt(r2, a1)} L${pt(r1, a1)} A${r1} ${r1} 0 ${large} 0 ${pt(r1, a0)} Z`;
}

/** Label anchor for slot `mid` at radius r. */
export function labelAt(cx: number, cy: number, r: number, mid: number) {
  const a = ((mid - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}
