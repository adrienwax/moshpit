// Polish 7: the starter looks are chains of real nodes with real parameter values, each one undo
// step; the I-frame Bloom makes the block a motion block. 3.2 Phase 3: a look is placed as a
// container with its macros, and its inlined graph is the flat chain exactly (it renders the same).
import { describe, expect, it, vi } from 'vitest';
import { toast } from '../src/qol/qol';

vi.mock('../src/qol/qol', async (orig) => ({ ...(await orig<object>()), toast: vi.fn() }));
import { DEF_BY_KIND, compileBlockGraph, inlineContainers, type BlockGraph } from '@moshpit/engine';
import { RECIPES, applyRecipe, lookNodes } from '../src/state/recipes';
import { addBlock, addSource, appendEffect, emptyDoc, getDoc, projectStore, transact, undo } from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';
import { freeze } from 'immer';

const starters = RECIPES.filter((r) => r.src === 'starter');

describe('starter looks (polish 7)', () => {
  it('five looks: Melt, I-frame Bloom, Chroma Ghost, Feedback Trail, Pixel Drift', () => {
    expect(starters.map((r) => r.nm)).toEqual(['Melt', 'I-frame Bloom', 'Chroma Ghost', 'Feedback Trail', 'Pixel Drift']);
  });
  it('every step is a real node, every value a real param in range', () => {
    for (const r of RECIPES) r.kinds.forEach((k, i) => {
      const d = DEF_BY_KIND.get(k);
      expect(d, `${r.nm}: ${k}`).toBeTruthy();
      for (const [key, v] of Object.entries(r.params?.[i] ?? {})) {
        const p = d!.params.find((x) => x.key === key);
        expect(p, `${r.nm}: ${k}.${key}`).toBeTruthy();
        if (typeof v === 'number') { expect(v).toBeGreaterThanOrEqual(p!.min ?? -Infinity); expect(v).toBeLessThanOrEqual(p!.max ?? Infinity); }
        if (p!.options) expect(p!.options, `${r.nm}: ${k}.${key}`).toContain(v);
      }
    });
  });
  it('applying one is one undo step, with its values on the nodes', () => {
    projectStore.set({ doc: freeze(emptyDoc(), true), past: [], future: [] });
    const src = demoProject().resources.sources[0];
    addSource(src, { id: 'conf-1', sourceId: src.id, frames: 300 } as never);
    const id = addBlock(src.id, 0, 100);
    const steps = projectStore.get().past.length;
    const melt = starters.find((r) => r.nm === 'Melt')!;
    applyRecipe(id, melt);
    const nodes = lookNodes(id);
    expect(nodes.find((n) => n.kind === 'mosh.hold')!.params.times).toBe(12);
    expect(nodes.find((n) => n.kind === 'fx.drift-trail')!.params.driftY).toBe(8);
    expect(projectStore.get().past.length).toBe(steps + 1);
    undo();
    expect(getDoc().timeline.blocks[0].graph.nodes.some((n) => n.kind === 'mosh.hold')).toBe(false);
  });
  it('the I-frame Bloom on the first block changes nothing and says why (final audit P2)', () => {
    projectStore.set({ doc: freeze(emptyDoc(), true), past: [], future: [] });
    const src = demoProject().resources.sources[0];
    addSource(src, { id: 'conf-1', sourceId: src.id, frames: 300 } as never);
    const first = addBlock(src.id, 0, 50);
    const steps = projectStore.get().past.length;
    const bloom = starters.find((r) => r.nm === 'I-frame Bloom')!;
    let applied: boolean | undefined;
    expect(() => { applied = applyRecipe(first, bloom); }).not.toThrow();
    expect(applied).toBe(false);
    expect(getDoc().timeline.blocks[0].kind).toBe('picture');
    expect(projectStore.get().past.length).toBe(steps); // no undo step for a no-op
    expect(vi.mocked(toast).mock.calls.some(([m, o]) => /first block must be a picture block/.test(String(m)) && o?.kind === 'warn')).toBe(true);
  });
  it('a chain recipe on the first block still applies (only the kind change is guarded)', () => {
    projectStore.set({ doc: freeze(emptyDoc(), true), past: [], future: [] });
    const src = demoProject().resources.sources[0];
    addSource(src, { id: 'conf-1', sourceId: src.id, frames: 300 } as never);
    const first = addBlock(src.id, 0, 50);
    expect(applyRecipe(first, starters.find((r) => r.nm === 'Melt')!)).toBe(true);
    expect(lookNodes(first).some((n) => n.kind === 'mosh.hold')).toBe(true);
  });
  it('the I-frame Bloom makes the block a motion block and says how to get the cut', () => {
    projectStore.set({ doc: freeze(emptyDoc(), true), past: [], future: [] });
    const src = demoProject().resources.sources[0];
    addSource(src, { id: 'conf-1', sourceId: src.id, frames: 300 } as never);
    addBlock(src.id, 0, 50);
    const id = addBlock(src.id, 50, 100, 'picture');
    const bloom = starters.find((r) => r.nm === 'I-frame Bloom')!;
    applyRecipe(id, bloom);
    expect(getDoc().timeline.blocks[1].kind).toBe('motion');
    expect(bloom.how).toMatch(/IN at the cut/);
  });

  it('every look is placed as one container with 3-6 macros, and inlines to exactly its flat chain', () => {
    const src = demoProject().resources.sources[0];
    /** A graph with ids replaced by kinds (each look's kinds are distinct): comparable across two docs. */
    const canon = (g: BlockGraph) => {
      const kind = new Map(g.nodes.map((n) => [n.id, n.kind]));
      return JSON.stringify({
        nodes: g.nodes.map((n) => `${n.kind} ${JSON.stringify(Object.entries(n.params).sort())}`).sort(),
        edges: g.edges.map((e) => `${kind.get(e.from.node)}.${e.from.port}>${kind.get(e.to.node)}.${e.to.port}`).sort(),
      });
    };
    const fresh = () => {
      projectStore.set({ doc: freeze(emptyDoc(), true), past: [], future: [] });
      addSource(src, { id: 'conf-1', sourceId: src.id, frames: 300 } as never);
      addBlock(src.id, 0, 50);
      return addBlock(src.id, 50, 100, 'motion');
    };
    for (const r of RECIPES.filter((x) => x.kinds.length)) {
      const flatId = fresh();
      transact(() => r.kinds.forEach((k, i) => appendEffect(flatId as never, k, r.params?.[i])));
      const flat = getDoc().timeline.blocks[1].graph;
      const id = fresh();
      const steps = projectStore.get().past.length;
      expect(applyRecipe(id, r), r.nm).toBe(true);
      expect(projectStore.get().past.length, r.nm).toBe(steps + 1);
      const g = getDoc().timeline.blocks[1].graph;
      const boxes = g.nodes.filter((n) => n.kind === 'group.container');
      expect(boxes.map((b) => b.label), r.nm).toEqual([r.nm]);
      expect([boxes[0].body!.ports.in.length, boxes[0].body!.ports.out.length], `${r.nm}: one way in, one way out (a look across the Decode holds it)`).toEqual([1, 1]);
      const macros = boxes[0].body!.macros;
      expect(macros.length >= 3 && macros.length <= 6, `${r.nm}: ${macros.length} macros`).toBe(true);
      expect(macros.every((m) => boxes[0].body!.graph.nodes.some((n) => n.id === m.target.node && m.target.param in DEF_BY_KIND.get(n.kind)!.params.reduce((o, p) => ({ ...o, [p.key]: 1 }), {}))), r.nm).toBe(true);
      expect(compileBlockGraph(id, g).ok, r.nm).toBe(true);
      expect(canon(inlineContainers(g).graph), r.nm).toBe(canon(flat));
    }
  });
});
