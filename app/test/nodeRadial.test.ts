// Phase 2.1a: the radial by look. Every placeable node is reachable through the looks and Utility
// (and only those); each ring keeps the study's six-slice limit; off an encoded wire only stream
// nodes are offered.
import { describe, expect, it } from 'vitest';
import { PLACEABLE } from '@moshpit/engine';
import { addRing, menuEntries, rootRing, searchAll, type NodeMenuCtx } from '../src/ws/node/nodeRadial';
import { browse } from '../src/lib/browse';
import type { RadialItem } from '../src/radial/Radial';
import { nodeDefs } from '../src/engine';

const noop = () => {};
const ctx = (fromType?: NodeMenuCtx['fromType']): NodeMenuCtx & { added: string[] } => {
  const added: string[] = [];
  return { added, fromType, add: (d) => added.push(d.kind), recipe: noop, organise: noop, serial: noop, parallel: noop, align: noop, frame: noop, fitAll: noop, fitSelection: noop, zoom100: noop, toggleMinimap: noop, toggleGrid: noop };
};
/** Every leaf under a ring: run once each, collecting what it adds. */
function leaves(items: RadialItem[], c: ReturnType<typeof ctx>, depth = 0): void {
  expect(items.length).toBeLessThanOrEqual(6);
  for (const it of items) {
    if (it.disabled) continue;
    if (it.children) { expect(depth).toBeLessThan(2); leaves(it.children, c, depth + 1); }
    else if (it.search) it.search.items.forEach((s) => s.run());
    else it.run?.();
  }
}

describe('radial by look (2.1a)', () => {
  it('Add and Utility reach every placeable node, and nothing else', () => {
    const c = ctx();
    const root = rootRing(c);
    leaves(root.filter((i) => i.label === 'Add' || i.label === 'Utility'), c);
    const placeable = new Set(nodeDefs().filter((d) => PLACEABLE.some((p) => p.kind === d.kind)).map((d) => d.kind as string));
    expect(new Set(c.added)).toEqual(placeable);
  });

  it('root has six slices, the look ring six', () => {
    const root = rootRing(ctx());
    expect(root.map((i) => i.label)).toEqual(['Add', 'Utility', 'Search', 'View', 'Layout', 'Looks']);
    expect(root[0].children!.map((i) => i.label)).toEqual(['Melt & Smear', 'Fracture & Displace', 'Stutter & Repeat', 'Decay & Corrupt', 'Echo & Trail', 'Colour & Split']);
  });

  it('off an encoded wire, only stream nodes are offered', () => {
    const c = ctx('EncodedVideoStream');
    leaves(addRing(c), c);
    const kinds = new Set(c.added);
    expect(kinds.size).toBeGreaterThan(0);
    for (const k of kinds) expect(nodeDefs().find((d) => d.kind === k)!.inputs.some((p) => p.type === 'EncodedVideoStream'), k).toBe(true);
    expect(searchAll(c).items.every((i) => !i.id.startsWith('recipe:'))).toBe(true); // recipes are not wired
  });

  it('uses the browser intent ranking and user tags, with favourites marked', () => {
    const c = { ...ctx(), looks: [], meta: { favs: ['fx.chroma-drift'], tags: { 'fx.chroma-drift': ['my tape'] } } };
    const all = menuEntries(c), search = searchAll(c);
    for (const q of ['melting rainbow', 'my tape', 'soft ghost']) {
      expect(search.filter!(q).map((e) => e.id)).toEqual(browse(all, { q, meta: c.meta }).flatMap((g) => g.items.map((e) => e.id)));
    }
    expect(search.items.find((e) => e.id === 'fx.chroma-drift')?.favourite).toBe(true);
  });

  it('keeps layout directions fixed inside and outside containers; no wrong-scope look application', () => {
    const outside = rootRing({ ...ctx(), group: noop, unpack: noop });
    const inside = rootRing({ ...ctx(), allowLooks: false });
    expect(outside[4].children!.map((e) => e.label)).toEqual(inside[4].children!.map((e) => e.label));
    expect(inside[4].children!.filter((e) => e.disabled).map((e) => e.label)).toEqual(['Group', 'Unpack']);
    expect(inside[5].disabled).toBe(true);
    expect(searchAll({ ...ctx(), allowLooks: false }).items.every((e) => !e.id.startsWith('recipe:') && !e.id.startsWith('look:'))).toBe(true);
  });
});
