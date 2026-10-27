// Display-referred RGB scopes from the pixels actually drawn. This is an 8-bit sample, not an
// HDR/legal-range measurement. Parade density preserves horizontal position instead of averaging.
import { clampView } from '../lib/timelineView';
export const PARADE_COLUMNS = 96;
export const PARADE_LEVELS = 128;
export const VECTOR_SIZE = 128;

export interface ScopeData {
  /** Compatibility summary only; the parade never plots these column averages. */
  wave: number[];
  hist: number[][];
  vec: [number, number][];
  clip: number;
  parade: Uint32Array[];
  vectorDensity: Uint32Array;
  samples: number;
  frames: number;
  highlights: number;
  columnLuma: Float64Array;
  columnSamples: Uint32Array;
}
export type ScopePixels = Pick<ImageData, 'data' | 'width' | 'height'>;
export const luma709 = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** Normalized display coordinates: Cb right, Cr up; neutral RGB is the centre. */
export function chromaPosition(r: number, g: number, b: number): [number, number] {
  const y = luma709(r, g, b);
  return [0.5 + ((b - y) / 1.8556 / 127.5) * 0.46, 0.5 - ((r - y) / 1.5748 / 127.5) * 0.46];
}
export function newScopeData(): ScopeData {
  return {
    wave: new Array(48).fill(0), hist: Array.from({ length: 4 }, () => new Array(256).fill(0)), vec: [], clip: 0,
    parade: Array.from({ length: 3 }, () => new Uint32Array(PARADE_COLUMNS * PARADE_LEVELS)),
    vectorDensity: new Uint32Array(VECTOR_SIZE * VECTOR_SIZE), samples: 0, frames: 0, highlights: 0,
    columnLuma: new Float64Array(48), columnSamples: new Uint32Array(48),
  };
}
export function accumulateScope(acc: ScopeData, img: ScopePixels): ScopeData {
  const { data, width, height } = img;
  if (width < 1 || height < 1) return acc;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (!data[i + 3]) continue; // Transparent pixels are not visible signal.
    const r = data[i], g = data[i + 1], b = data[i + 2], luma = luma709(r, g, b);
    const column = Math.min(PARADE_COLUMNS - 1, Math.floor(x * PARADE_COLUMNS / width));
    const legacyColumn = Math.min(47, Math.floor(x * 48 / width));
    acc.columnLuma[legacyColumn] += luma; acc.columnSamples[legacyColumn]++;
    for (let channel = 0; channel < 3; channel++) {
      const value = data[i + channel];
      acc.hist[channel][value]++;
      acc.parade[channel][Math.min(PARADE_LEVELS - 1, Math.floor(value * PARADE_LEVELS / 256)) * PARADE_COLUMNS + column]++;
    }
    acc.hist[3][Math.min(255, Math.round(luma))]++;
    const [vx, vy] = chromaPosition(r, g, b);
    const col = Math.max(0, Math.min(VECTOR_SIZE - 1, Math.floor(vx * VECTOR_SIZE)));
    const row = Math.max(0, Math.min(VECTOR_SIZE - 1, Math.floor(vy * VECTOR_SIZE)));
    acc.vectorDensity[row * VECTOR_SIZE + col]++;
    if (acc.samples % 32 === 0) acc.vec.push([(b - luma) / 1.8556, (r - luma) / 1.5748]);
    if (luma > 250) acc.highlights++;
    acc.samples++;
  }
  acc.frames++;
  acc.clip = acc.samples ? acc.highlights / acc.samples : 0;
  acc.wave = acc.wave.map((_, i) => acc.columnLuma[i] / Math.max(1, acc.columnSamples[i]) / 255);
  return acc;
}
export const analyse = (img: ScopePixels): ScopeData => accumulateScope(newScopeData(), img);

/** Shared display window guard, including old zoom state from a longer project. */
export function scopeRange(total: number, zoom?: { start: number; len: number; of: number }): [number, number] | null {
  if (!Number.isFinite(total) || total < 1) return null;
  const last = Math.floor(total) - 1;
  const valid = zoom && [zoom.start, zoom.len, zoom.of].every(Number.isFinite) && zoom.len > 0 && zoom.len < zoom.of;
  const view = clampView(valid ? zoom : { start: 0, len: total }, total);
  const a = Math.max(0, Math.floor(view.start));
  const b = Math.min(last, Math.max(a, Math.ceil(view.start + view.len)));
  return [a, b];
}
