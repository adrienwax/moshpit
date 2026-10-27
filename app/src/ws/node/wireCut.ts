/** Screen-space geometry: drag thresholds and wire tolerance stay usable at every graph zoom. */
export interface Point { x: number; y: number }
export interface CutWire { id: string; points: Point[] }
export const CUT_THRESHOLD = 8;
const TOLERANCE = 3;

function pointDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

export function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
  return Math.min(pointDistance(a, c, d), pointDistance(b, c, d), pointDistance(c, a, b), pointDistance(d, a, b)) <= TOLERANCE;
}

/** A stroke only collects candidates. The caller commits once on release, or discards on cancel. */
export class CutStroke {
  readonly points: Point[];
  readonly hits = new Set<string>();
  dragging = false;
  private wires: CutWire[] = [];
  constructor(readonly origin: Point, private readWires: () => CutWire[]) { this.points = [origin]; }
  move(p: Point) {
    if (!this.dragging) {
      if (Math.hypot(p.x - this.origin.x, p.y - this.origin.y) < CUT_THRESHOLD) return;
      this.dragging = true;
      this.wires = this.readWires();
    }
    const previous = this.points[this.points.length - 1];
    for (const wire of this.wires) {
      if (this.hits.has(wire.id)) continue;
      for (let i = 1; i < wire.points.length; i++) {
        if (crosses(previous, p, wire.points[i - 1], wire.points[i])) { this.hits.add(wire.id); break; }
      }
    }
    this.points.push(p);
  }
}

/** Sample the paths actually drawn by React Flow, including their screen pan/zoom transform.
 * The allow-list is the active graph's real edges; project LFO/Value ghost links are excluded.
 */
export function readCutWires(root: HTMLElement, allowed: ReadonlySet<string>): CutWire[] {
  const wires: CutWire[] = [];
  root.querySelectorAll<SVGPathElement>('.react-flow__edge-path').forEach((path) => {
    const id = path.closest('.react-flow__edge')?.getAttribute('data-id');
    if (!id || !allowed.has(id)) return;
    const matrix = path.getScreenCTM();
    if (!matrix) return;
    const length = path.getTotalLength();
    const scale = Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d));
    const steps = Math.max(1, Math.ceil(length * scale / 4));
    const points = Array.from({ length: steps + 1 }, (_, i) => {
      const p = path.getPointAtLength(length * i / steps);
      return { x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f };
    });
    wires.push({ id, points });
  });
  return wires;
}
