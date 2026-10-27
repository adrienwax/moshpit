// Phase 2.6: favourites and the user's own tags in the browser's model. A Favourites tab; tags as
// a facet (OR within, AND with families) and as words the search ranks on.
import { describe, expect, it } from 'vitest';
import { PLACEABLE } from '@moshpit/engine';
import { browse, entries, FAV_TAB, MATCHES } from '../src/lib/browse';

const all = entries([...PLACEABLE]);
const ids = (g: ReturnType<typeof browse>) => [...new Set(g.flatMap((x) => x.items.map((e) => e.id)))]; // the tree lists an entry under each of its looks
const meta = { favs: ['mosh.hold', 'recipe:VHS Decay', 'fx.chroma-drift'], tags: { 'fx.invert': ['strobe'], 'fx.brightness': ['strobe', 'fade'], 'mosh.hold': ['drop'] } };

describe('favourites and tags (2.6)', () => {
  it('the Favourites tab holds exactly the favourites, each once', () => {
    const raw = browse(all, { tab: FAV_TAB, meta }).flatMap((x) => x.items.map((e) => e.id));
    expect(raw.sort()).toEqual([...meta.favs].sort()); // Hold is filed under two looks, listed once
  });

  it('with no favourites, the tab is empty (the UI says how to add one)', () => {
    expect(browse(all, { tab: FAV_TAB, meta: { favs: [] } })).toEqual([]);
  });

  it('a tag facet keeps what carries any chosen tag, AND with families', () => {
    expect(ids(browse(all, { userTags: ['strobe'], meta })).sort()).toEqual(['fx.brightness', 'fx.invert']);
    expect(ids(browse(all, { userTags: ['strobe', 'drop'], meta })).sort()).toEqual(['fx.brightness', 'fx.invert', 'mosh.hold']);
    expect(ids(browse(all, { userTags: ['strobe', 'drop'], families: ['Bitstream'], meta }))).toEqual(['mosh.hold']);
  });

  it("the user's tags are words the search finds", () => {
    const g = browse(all, { q: 'strobe', meta });
    expect(g[0].cat).toBe(MATCHES);
    expect(ids(g).slice(0, 2).sort()).toEqual(['fx.brightness', 'fx.invert']);
    expect(browse(all, { q: 'strobe' })).toEqual([]); // nobody tagged it: nothing says strobe
  });
});
