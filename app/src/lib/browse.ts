// Phase 2.1: the effect browser's model. Every placeable kind and every recipe, filed by look
// (category → subcategory, from the engine's atlas), filtered by a search (name, explanation, look,
// family) AND a look category AND the family facets (OR within them). Pure: the drawer renders it.
import { ATLAS, LOOKS, type ComponentDef, type Explanation, type LookCategory, type NodeDef } from '@moshpit/engine';
import { RECIPES, type Recipe } from '../state/recipes';
import { expand, score, type Fields } from './intent';

export const RECIPE_TAB = 'Recipes' as const;
export const FAV_TAB = '★ Favourites' as const;
export type BrowseTab = LookCategory | typeof RECIPE_TAB | typeof FAV_TAB | 'All';
export const TABS: BrowseTab[] = ['All', FAV_TAB, ...(Object.keys(LOOKS) as LookCategory[]), RECIPE_TAB];

/** Phase 2.6: what the user has said about effects (settings.json, keyed by id). */
export interface UserMeta { favs?: string[]; tags?: Record<string, string[]> }

export type Entry =
  | { type: 'node'; id: string; label: string; family?: string; side: 'bitstream' | 'picture' | 'utility'; def: NodeDef; explain: Explanation; looks: { cat: LookCategory; sub: string }[] }
  | { type: 'recipe'; id: string; label: string; recipe: Recipe; looks: { cat: LookCategory; sub: string }[] };

/** Saved-look ingredients are search metadata only. Preview and placement use the actual graph. */
function ownLook(l: ComponentDef): Recipe {
  const inner = l.body.graph.nodes.filter((n) => n.kind !== 'group.in' && n.kind !== 'group.out');
  const look = (l.look && l.look in LOOKS ? l.look : ATLAS[inner[0]?.kind]?.looks[0]?.cat ?? Object.keys(LOOKS)[0]) as LookCategory;
  return { ic: '★', nm: l.name, kinds: inner.map((n) => n.kind), params: inner.map((n) => n.params), src: 'project', look, does: l.does ?? 'Your look.', lookId: l.id };
}

/** The browser's three kinds (3.6): everything, looks (built-in and your own), or single operators. */
export type BrowseKind = 'all' | 'looks' | 'operators';
export const ofKind = (all: Entry[], kind: BrowseKind) => (kind === 'all' ? all : all.filter((e) => (kind === 'looks') === (e.type === 'recipe')));

export function entries(defs: NodeDef[], own: ComponentDef[] = []): Entry[] {
  const nodes: Entry[] = defs.filter((d) => ATLAS[d.kind]).map((d) => ({
    type: 'node', id: d.kind, label: d.label, family: d.family, def: d, explain: ATLAS[d.kind].explain, looks: ATLAS[d.kind].looks,
    side: d.family ? (d.domain === 'ENCODED_STREAM' ? 'bitstream' : 'picture') : 'utility',
  }));
  const recipes: Entry[] = [...RECIPES, ...own.map(ownLook)].map((r) => ({ type: 'recipe', id: r.lookId ? `look:${r.lookId}` : `recipe:${r.nm}`, label: r.nm, recipe: r, looks: [{ cat: r.look, sub: RECIPE_TAB }] }));
  return [...nodes, ...recipes];
}

// The user's tags count as much as the look: they are the user's own words for it.
const fields = (e: Entry, tags: string[] = []): Fields => (e.type === 'node'
  ? { name: e.label, look: [...e.looks.flatMap((l) => [l.cat, l.sub]), e.family ?? '', e.side, ...tags].join(' '), does: `${e.explain.does} ${e.explain.useWhen}`, rest: `${e.explain.worksWith} ${e.explain.watchOut} ${e.explain.tryNext} ${e.def.blurb}` }
  : { name: e.label, look: [e.recipe.look, 'recipe', ...tags].join(' '), does: e.recipe.does, rest: e.recipe.kinds.join(' ') });

export const MATCHES = 'Best matches' as const;
export interface Group { cat: LookCategory | typeof RECIPE_TAB | typeof MATCHES; sub: string; items: Entry[] }

/**
 * The visible tree: by look, two levels, an entry filed under two looks under both. A search
 * (Phase 2.5, by intent) instead returns one ranked list, best first, each entry once; the look
 * tab and the family chips still narrow it.
 */
export function browse(all: Entry[], o: { q?: string; tab?: BrowseTab; families?: string[]; userTags?: string[]; meta?: UserMeta }): Group[] {
  const terms = expand(o.q ?? '');
  const searching = !!(o.q ?? '').trim();
  const fam = o.families ?? [];
  const ut = o.userTags ?? [];
  const favs = new Set(o.meta?.favs ?? []);
  const tagsOf = (e: Entry) => o.meta?.tags?.[e.id] ?? [];
  const tab = o.tab ?? 'All';
  // Facets: AND across axes (family, the user's tags), OR within each.
  const inView = all.filter((e) =>
    (!fam.length || (e.type === 'node' && !!e.family && fam.includes(e.family))) &&
    (!ut.length || tagsOf(e).some((t) => ut.includes(t))) &&
    (tab === 'All' || (tab === FAV_TAB ? favs.has(e.id) : tab === RECIPE_TAB ? e.type === 'recipe' : e.looks.some((l) => l.cat === tab))));
  if (searching) {
    const ranked = inView.map((e) => ({ e, s: score(fields(e, tagsOf(e)), terms) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.e.label.localeCompare(b.e.label));
    return ranked.length ? [{ cat: MATCHES, sub: MATCHES, items: ranked.map((x) => x.e) }] : [];
  }
  const hit = inView;
  const groups = new Map<string, Group>();
  const add = (cat: Group['cat'], sub: string, e: Entry) => {
    const k = `${cat}/${sub}`;
    if (!groups.has(k)) groups.set(k, { cat, sub, items: [] });
    groups.get(k)!.items.push(e);
  };
  for (const e of hit) {
    if (e.type === 'recipe') { add(tab === RECIPE_TAB ? RECIPE_TAB : e.recipe.look, RECIPE_TAB, e); continue; }
    // Favourites: one row each, under its first look (a favourite filed under two looks shows once).
    const looks = e.looks.filter((x) => tab === 'All' || tab === RECIPE_TAB || tab === FAV_TAB || x.cat === tab);
    for (const l of tab === FAV_TAB ? looks.slice(0, 1) : looks) add(l.cat, l.sub, e);
  }
  // Tree order: the atlas's category and subcategory order, recipes last in their category.
  const cats = Object.keys(LOOKS) as LookCategory[];
  const rank = (g: Group) => {
    const c = g.cat === RECIPE_TAB || g.cat === MATCHES ? cats.length : cats.indexOf(g.cat);
    const s = g.sub === RECIPE_TAB ? 99 : (LOOKS[g.cat as LookCategory] as readonly string[]).indexOf(g.sub);
    return c * 100 + s;
  };
  return [...groups.values()].sort((a, b) => rank(a) - rank(b));
}
