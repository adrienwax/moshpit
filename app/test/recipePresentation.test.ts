import { describe, expect, it } from 'vitest';
import { PLACEABLE } from '@moshpit/engine';
import { entries, ofKind, RECIPE_TAB, browse } from '../src/lib/browse';
import { recipeGroupLabel, recipePresentation } from '../src/lib/recipePresentation';
import { RECIPES } from '../src/state/recipes';

describe('catalogue recipe scope', () => {
  it('describes I-frame Bloom as a timeline change, without promising a container or knobs', () => {
    const bloom = RECIPES.find(r => r.nm === 'I-frame Bloom')!;
    const presentation = recipePresentation(bloom);
    expect(presentation.type).toBe('block-recipe');
    expect(presentation.badge).toBe('RECIPE');
    expect(presentation.help).toContain('preceding Picture block');
    expect(presentation.help).toContain('no effect container');
    expect(presentation.action(2)).toBe('Make Block 2 Motion');
    expect(bloom.kinds).toEqual([]);
    expect(bloom.blockKind).toBe('motion');
  });

  it('distinguishes built-in and project Looks without assuming multiple effects or exposed knobs', () => {
    const built = RECIPES.find(r => r.nm === 'Melt')!;
    expect(recipePresentation(built).label).toBe('Built-in Look');
    const own = { ...built, kinds: ['fx.posterize'], macros: undefined, lookId: 'saved-1' };
    const presentation = recipePresentation(own);
    expect(presentation.label).toBe('Project Look');
    expect(presentation.help).toContain('independent container copy');
    expect(presentation.help).not.toMatch(/several|knobs/);
    expect(presentation.action(3)).toBe('Apply to Block 3');
  });

  it('counts and labels the actual combination rather than calling block recipes Looks', () => {
    const looks = RECIPES.filter(r => recipePresentation(r).type === 'look');
    const blocks = RECIPES.filter(r => recipePresentation(r).type === 'block-recipe');
    expect(looks).toHaveLength(9);
    expect(blocks).toHaveLength(1);
    expect(recipeGroupLabel(looks)).toBe('Looks');
    expect(recipeGroupLabel(blocks)).toBe('Block recipes');
    expect(recipeGroupLabel(RECIPES)).toBe('Looks & recipes');
  });

  it('retains all legacy catalogue IDs and the persisted looks and Recipes filters', () => {
    const all = entries([...PLACEABLE]);
    const ids = RECIPES.map(r => `recipe:${r.nm}`);
    expect(ofKind(all, 'looks').map(e => e.id)).toEqual(ids);
    expect(browse(all, { tab: RECIPE_TAB }).flatMap(group => group.items.map(e => e.id)).sort()).toEqual([...ids].sort());
    expect(all.find(e => e.id === 'route.mix')?.type).toBe('node');
  });
});
