// Phase 2.5: search by intent. Words people use for a look find the effects whose explanations make
// it, ranked; names are not needed. Expectations are on the top few, not exact orders.
import { describe, expect, it } from 'vitest';
import { PLACEABLE } from '@moshpit/engine';
import { browse, entries, MATCHES } from '../src/lib/browse';
import { expand, stem } from '../src/lib/intent';

const all = entries([...PLACEABLE]);
const top = (q: string, n = 3) => (browse(all, { q })[0]?.items ?? []).slice(0, n).map((e) => e.label);

describe('intent search (2.5)', () => {
  it('stems the way people type', () => {
    expect(['melting', 'trails', 'glitchy', 'colours', 'reversed'].map(stem)).toEqual(['melt', 'trail', 'glitch', 'colour', 'revers']);
    expect(expand('make it melt').map((t) => t.term)).toContain('liquef'); // the lexicon: melt → liquefy
  });

  it.each([
    ['pixelated', 'Resolution crush', 1],
    ['kaleidoscope', 'Mirror', 1],
    ['backwards', 'Reverse', 1],
    ['make it stutter', 'Stride', 2],
    ['ghost trails', 'Feedback trail', 3],
    ['old tape', 'VHS Decay', 1],
    ['freeze frame', 'Hold', 1],
    ['psychedelic tunnel', 'Feedback loop', 1],
    ['static noise', 'Salt & pepper', 1],
    ['dreamy', 'Dream Melt', 2],
    ['tear the image apart', 'Row displacement', 1],
  ])('"%s" finds %s in the top %i', (q, want, n) => {
    expect(top(q as string, n as number)).toContain(want);
  });

  it('a multi-word intent ranks entries that answer more of it first', () => {
    const r = top('glitchy melting rainbow smear', 5);
    expect(r.length).toBe(5);
    expect(r.some((l) => /Chroma|Channel/.test(l))).toBe(true); // rainbow
    expect(r.some((l) => /Hold|Reorder|VHS/.test(l))).toBe(true); // melting smear
  });

  it('search is one ranked list; tabs and family chips still narrow it', () => {
    const g = browse(all, { q: 'smear' });
    expect(g).toHaveLength(1);
    expect(g[0].cat).toBe(MATCHES);
    const pic = browse(all, { q: 'smear', families: ['Feedback'] })[0].items;
    expect(pic.every((e) => e.type === 'node' && e.family === 'Feedback')).toBe(true);
    expect(browse(all, { q: 'zzzz' })).toEqual([]);
    expect(browse(all, { q: 'make it' })).toEqual([]); // only stop words: nothing to rank on
  });
});
