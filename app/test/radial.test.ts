import { describe, expect, it } from 'vitest';
import { radialLabelLines, sliceAt, slotCompass, southSlot } from '../src/radial/geometry';
import { withBack } from '../src/radial/Radial';

describe('radial geometry', () => {
  it('keeps long outcome names readable across two balanced lines', () => {
    expect(radialLabelLines('Fracture & Displace')).toEqual(['Fracture', '& Displace']);
    expect(radialLabelLines('Melt & Smear')).toEqual(['Melt & Smear']);
    expect(radialLabelLines('Colour separation')).toEqual(['Colour', 'separation']);
  });
  it.each([1, 2, 3, 4, 5])('keeps Back due South with %i submenu actions', count => {
    const actions = Array.from({ length: count }, (_, i) => ({ label: `Action ${i}` }));
    const ring = withBack(actions, true);
    expect(ring.length).toBeLessThanOrEqual(6);
    expect(ring[southSlot(ring.length)].back).toBe(true);
    expect(ring.filter(i => !i.back && !i.disabled)).toEqual(actions);
  });
  it('names slots by compass: 4 → N E S W, 6 → hexagon with S at slot 3', () => {
    expect([0, 1, 2, 3].map((i) => slotCompass(i, 4))).toEqual(['N', 'E', 'S', 'W']);
    expect([0, 1, 2, 3, 4, 5].map((i) => slotCompass(i, 6))).toEqual(['N', 'NE', 'SE', 'S', 'SW', 'NW']);
    expect(southSlot(6)).toBe(3);
    expect(southSlot(5)).toBe(-1);
  });

  it('selects by direction, at any distance past the dead-zone', () => {
    expect(sliceAt(0, -50, 4, 30)).toBe(0); // up = N
    expect(sliceAt(50, 0, 4, 30)).toBe(1); // right = E
    expect(sliceAt(0, 900, 4, 30)).toBe(2); // far down = S (infinite wedge)
    expect(sliceAt(-50, 1, 4, 30)).toBe(3); // left = W
    expect(sliceAt(40, -40, 6, 30)).toBe(1); // up-right = NE on a hexagon
  });

  it('never fires inside the dead-zone', () => {
    expect(sliceAt(10, -10, 4, 30)).toBe(-1);
    expect(sliceAt(0, 0, 6, 30)).toBe(-1);
  });
});
