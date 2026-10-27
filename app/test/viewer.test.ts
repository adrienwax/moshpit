import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, viewerGeometry } from '../src/lib/viewer';
describe('aspect-locked display transforms', () => {
  it('fits a wide picture into a tall panel without stretching', () => {
    const g = viewerGeometry(400, 600, 1920, 1080, DEFAULT_VIEW);
    expect(g.width).toBe(400); expect(g.height).toBe(225);
  });
  it('fills by cropping the view, keeping the source aspect', () => {
    const g = viewerGeometry(1200, 300, 1920, 1080, { ...DEFAULT_VIEW, mode: 'fill' });
    expect(g.width).toBe(1200); expect(g.height).toBe(675);
    expect(g.width / g.height).toBeCloseTo(16 / 9);
  });
  it('uses native dimensions at 100%, including portrait and square', () => {
    for (const [w, h] of [[1080, 1920], [1024, 1024]]) {
      const g = viewerGeometry(600, 300, w, h, { ...DEFAULT_VIEW, mode: 'custom' });
      expect([g.width, g.height]).toEqual([w, h]);
    }
  });
  it('clamps pan to visible picture edges and recentres dimensions that fit', () => {
    const g = viewerGeometry(800, 700, 1920, 1080, { mode: 'custom', zoom: .5, x: 500, y: -500 });
    expect(g.x).toBe(80); expect(g.y).toBe(0);
    const fit = viewerGeometry(800, 700, 1920, 1080, { ...DEFAULT_VIEW, x: 500, y: 500 });
    expect(fit.x).toBe(0); expect(fit.y).toBe(0);
  });
});
