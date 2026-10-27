// One catalogue behind the effects browser and node radial, with typed wire-drop filtering.
import type { ComponentDef, EdgeType, LookCategory, NodeDef } from '@moshpit/engine';
import { LOOKS, isPlaceable } from '@moshpit/engine';
import { nodeDefs } from '../../engine';
import { compatible } from '../../engine/catalog';
import type { Recipe } from '../../state/recipes';
import { getDoc } from '../../state/project';
import { settingsStore } from '../../state/ui';
import { browse, entries, type Entry, type UserMeta } from '../../lib/browse';
import { LOOK_COLOUR } from '../../lib/cats';
import type { RadialItem, SearchItem, SearchSpec } from '../../radial/Radial';

export interface NodeMenuCtx {
  add: (def: NodeDef) => void;
  recipe: (recipe: Recipe) => void;
  fromType?: EdgeType;
  /** Containers cannot hold another look; keep actions scoped to the open graph. */
  allowLooks?: boolean;
  looks?: ComponentDef[];
  meta?: UserMeta;
  organise: () => void;
  serial: () => void;
  parallel: () => void;
  align: () => void;
  group?: () => void;
  unpack?: () => void;
  fitAll: () => void;
  fitSelection: () => void;
  zoom100: () => void;
  toggleMinimap: () => void;
  toggleGrid: () => void;
}
const OUTCOMES = (Object.keys(LOOKS) as LookCategory[]).filter((c) => c !== 'Utility');
const userMeta = (ctx: NodeMenuCtx): UserMeta => ctx.meta ?? { favs: settingsStore.get().effectFavs, tags: settingsStore.get().effectTags };

export function menuEntries(ctx: NodeMenuCtx): Entry[] {
  const defs = nodeDefs().filter((d) => d.category !== 'Audio' && isPlaceable(d) && (!ctx.fromType || d.inputs.some((p) =>
    ctx.fromType === 'EncodedVideoStream' ? p.type === 'EncodedVideoStream' : compatible(ctx.fromType!, p.type))));
  const all = entries(defs, ctx.looks ?? getDoc().components?.looks ?? []);
  return ctx.fromType || ctx.allowLooks === false ? all.filter((e) => e.type === 'node') : all;
}

function item(ctx: NodeMenuCtx, e: Entry): SearchItem {
  return {
    id: e.id, label: e.label, favourite: userMeta(ctx).favs?.includes(e.id),
    color: LOOK_COLOUR[e.looks[0]?.cat ?? 'Utility'],
    hint: e.type === 'node' ? e.explain.does : e.recipe.does,
    group: e.type === 'node' ? `${e.def.impl.preview === 'PROXY' ? '≈ ' : ''}${e.family ?? 'Utility'}` : e.recipe.lookId ? 'Your look' : 'Look',
    run: () => e.type === 'node' ? ctx.add(e.def) : ctx.recipe(e.recipe),
  };
}

function search(ctx: NodeMenuCtx, all: Entry[], title: string): SearchSpec {
  const meta = userMeta(ctx);
  const items = all.map((e) => item(ctx, e));
  const byId = new Map(items.map((e) => [e.id, e]));
  return {
    title, items, placeholder: `Search ${items.length} by name, look or your tags…`,
    filter: (q) => {
      if (!q.trim()) return items;
      return browse(all, { q, meta }).flatMap((g) => g.items).map((e) => byId.get(e.id)!);
    },
  };
}

/** Categories always open a list, even with one entry: catalogue growth never changes the action. */
function listSlice(ctx: NodeMenuCtx, label: string, all: Entry[], why: string, color = LOOK_COLOUR.Utility): RadialItem {
  return { label, color, disabled: !all.length, hint: all.length ? `${all.length} choices · preview descriptions and search` : why, search: search(ctx, all, label) };
}

function lookSlice(ctx: NodeMenuCtx, cat: LookCategory): RadialItem {
  const all = menuEntries(ctx).filter((e) => e.looks.some((l) => l.cat === cat));
  const color = LOOK_COLOUR[cat];
  const children = (LOOKS[cat] as readonly string[]).map((sub) => listSlice(ctx, sub, all.filter((e) => e.type === 'node' && e.looks.some((l) => l.cat === cat && l.sub === sub)), 'Nothing here accepts this wire', color));
  const looks = all.filter((e) => e.type === 'recipe');
  if (!ctx.fromType && ctx.allowLooks !== false) children.push(listSlice(ctx, 'Looks', looks, 'No saved looks in this group yet', color));
  return { label: cat, color, disabled: !all.length, hint: `${all.length} choices · ${cat.toLowerCase()}`, children };
}
const lookRing = (ctx: NodeMenuCtx) => OUTCOMES.map((cat) => lookSlice(ctx, cat));
function utilitySlice(ctx: NodeMenuCtx): RadialItem {
  const all = menuEntries(ctx).filter((e) => e.type === 'node' && e.side === 'utility');
  return { label: 'Utility', icon: '⤭', color: LOOK_COLOUR.Utility, disabled: !all.length, hint: 'Routing, decode, blend and switch',
    children: (LOOKS.Utility as readonly string[]).map((sub) => listSlice(ctx, sub, all.filter((e) => e.looks.some((l) => l.cat === 'Utility' && l.sub === sub)), 'Nothing here accepts this wire')) };
}
export const searchAll = (ctx: NodeMenuCtx): SearchSpec => search(ctx, menuEntries(ctx), ctx.fromType ? 'Add (accepts this wire)' : 'Effects, looks & utilities');
export function addRing(ctx: NodeMenuCtx): RadialItem[] {
  return [
    { label: 'By look', icon: '＋', color: 'var(--lav)', children: lookRing(ctx) },
    utilitySlice(ctx),
    { label: 'Search', icon: '⌕', color: 'var(--sky)', search: searchAll(ctx) },
  ];
}
export function rootRing(ctx: NodeMenuCtx): RadialItem[] {
  return [
    { label: 'Add', icon: '＋', color: 'var(--lav)', hint: 'Choose by what the picture should do', children: lookRing(ctx) },
    utilitySlice(ctx),
    { label: 'Search', icon: '⌕', color: 'var(--sky)', hint: 'Search descriptions, favourites and your tags (or Tab)', search: searchAll(ctx) },
    { label: 'View', icon: '⤢', color: 'var(--teal)', children: [
      { label: 'Fit all', color: 'var(--teal)', run: ctx.fitAll },
      { label: 'Fit selection', color: 'var(--teal)', run: ctx.fitSelection },
      { label: 'Zoom 100%', color: 'var(--teal)', run: ctx.zoom100 },
      { label: 'Minimap', color: 'var(--teal)', run: ctx.toggleMinimap },
      { label: 'Grid', color: 'var(--teal)', run: ctx.toggleGrid },
    ] },
    { label: 'Layout', icon: '▣', color: 'var(--gold)', hint: 'Organise, chain, branch, align', children: [
      { label: 'Organise', color: 'var(--gold)', hint: 'Auto-layout by signal flow', run: ctx.organise },
      { label: 'Parallel', color: 'var(--gold)', hint: 'Branch the selection off one input, merged by a Mix', run: ctx.parallel },
      { label: 'Align', color: 'var(--gold)', hint: 'Align the selection on one row', run: ctx.align },
      { label: 'Group', color: 'var(--gold)', disabled: !ctx.group, hint: ctx.group ? 'Wrap the selection in a reusable container' : 'Return to the block graph to group nodes', run: ctx.group },
      { label: 'Serial', color: 'var(--gold)', hint: 'Chain the selection left to right', run: ctx.serial },
      { label: 'Unpack', color: 'var(--gold)', disabled: !ctx.unpack, hint: ctx.unpack ? 'Put the container’s nodes back into the block' : 'Return to the block graph to unpack a container', run: ctx.unpack },
    ] },
    { ...listSlice(ctx, 'Looks', menuEntries(ctx).filter((e) => e.type === 'recipe'), ctx.allowLooks === false ? 'Return to the block graph to add a look' : 'No looks here', 'var(--gold)'), icon: '✷' },
  ];
}
