// Phase 2.1: the effect browser's model. Two levels by look, recipes beside their look, search
// across explanations (every word must match), family facets OR-within and AND with the rest.
import { describe, expect, it } from 'vitest';
import { LOOKS, PLACEABLE } from '@moshpit/engine';
import { browse, entries, RECIPE_TAB } from '../src/lib/browse';
import { RECIPES } from '../src/state/recipes';

const all = entries([...PLACEABLE]);
const ids = (g: ReturnType<typeof browse>) => [...new Set(g.flatMap((x) => x.items.map((e) => e.id)))];

describe('effect browser model (2.1)', () => {
  it('holds every placeable node and every recipe', () => {
    expect(all.filter((e) => e.type === 'node')).toHaveLength(PLACEABLE.length);
    expect(all.filter((e) => e.type === 'recipe')).toHaveLength(RECIPES.length);
  });

  it('browses two levels deep in the atlas order, every subcategory filled', () => {
    const g = browse(all, {});
    const cats = Object.keys(LOOKS);
    const order = g.map((x) => cats.indexOf(x.cat as string));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const [cat, subs] of Object.entries(LOOKS)) for (const sub of subs) expect(g.some((x) => x.cat === cat && x.sub === sub), `${cat}/${sub}`).toBe(true);
  });

  it('a look tab shows that look, its subcategories and its recipes', () => {
    const g = browse(all, { tab: 'Melt & Smear' });
    expect(new Set(g.map((x) => x.cat))).toEqual(new Set(['Melt & Smear']));
    expect(ids(g)).toContain('mosh.hold');
    expect(ids(g)).toContain('recipe:Dream Melt');
    expect(ids(g)).not.toContain('fx.invert');
  });

  it('the Recipes tab is only recipes', () => {
    const g = browse(all, { tab: RECIPE_TAB });
    expect(ids(g).sort()).toEqual(RECIPES.map((r) => `recipe:${r.nm}`).sort());
  });

  it('search reads the explanations, ranked, each hit listed once', () => {
    const g = browse(all, { q: 'tape colour' });
    expect(g[0].items[0].id).toBe('fx.chroma-drift'); // "colour bleeds off the brightness like tape"
    const flat = g.flatMap((x) => x.items.map((e) => e.id));
    expect(flat.length).toBe(new Set(flat).size);
    expect(browse(all, { q: 'zzzz' })).toEqual([]);
  });

  it('family facets are OR within, AND with the look', () => {
    const tone = ids(browse(all, { families: ['Tone'] }));
    const both = ids(browse(all, { families: ['Tone', 'Degrade'] }));
    expect(both.length).toBeGreaterThan(tone.length);
    const g = browse(all, { families: ['Bitstream'], tab: 'Echo & Trail' });
    expect(g).toEqual([]); // no bitstream op makes an echo
  });
});
