// Mosh ops must land before the decode boundary (B1), image ops before Output, whatever order
// they are added in — so recipes and the Add-effect drawer can never build an uncompilable graph.
import { describe, expect, it } from 'vitest';
import { domainOrderOk } from '@moshpit/engine';
import { addNode, appendEffect, connectionError, emptyDoc, getDoc, projectStore, addBlock, addSource, repairStreamOrder } from '../src/state/project';
import { defOf } from '../src/engine';
import { demoProject } from '../src/engine/mockProject';

const chain = (blockIx: number) => {
  const b = getDoc().timeline.blocks[blockIx];
  const out: string[] = [];
  let cur = b.graph.nodes.find((n) => defOf(n.kind)?.category === 'Source');
  while (cur) {
    out.push(cur.kind);
    const e = b.graph.edges.find((x) => x.from.node === cur!.id);
    cur = e && b.graph.nodes.find((n) => n.id === e.to.node);
  }
  return out;
};

describe('appendEffect respects the decode boundary', () => {
  it('an image op then a Mosh op: the Mosh op goes before the image op', () => {
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    addSource(demoProject().resources.sources[0]);
    const id = addBlock(getDoc().resources.sources[0].id, 0, 24, 'motion');
    appendEffect(id, 'fx.posterize');
    appendEffect(id, 'mosh.hold');
    appendEffect(id, 'fx.chroma-drift');
    appendEffect(id, 'mosh.stride');
    // Phase 1.1: every block draws its Decode; Mosh ops land before it, image ops after it.
    expect(chain(0)).toEqual(['source.clip', 'mosh.hold', 'mosh.stride', 'decode.webcodecs', 'fx.posterize', 'fx.chroma-drift', 'output.sink']);
    const g = getDoc().timeline.blocks[0].graph;
    for (const e of g.edges) {
      const a = defOf(g.nodes.find((n) => n.id === e.from.node)!.kind)!;
      const z = defOf(g.nodes.find((n) => n.id === e.to.node)!.kind)!;
      expect(domainOrderOk(a, z)).toBe(true);
    }
  });

  // Waxy (2026-10-08): with an explicit decode node in the graph, ＋ Speed (F1) landed after it,
  // GRAPH_DOMAIN_ORDER, and nothing rendered. The walk now stops before decode.
  it('with an explicit decode node, a Mosh op goes before it, not after', () => {
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    addSource(demoProject().resources.sources[0]);
    const id = addBlock(getDoc().resources.sources[0].id, 0, 24, 'motion');
    appendEffect(id, 'fx.posterize');
    // The block's own Decode (Phase 1.1: addBlock draws it) sits between the Source and the image op.
    expect(chain(0)).toEqual(['source.clip', 'decode.webcodecs', 'fx.posterize', 'output.sink']);
    appendEffect(id, 'mosh.speed');
    expect(chain(0)).toEqual(['source.clip', 'mosh.speed', 'decode.webcodecs', 'fx.posterize', 'output.sink']);
    const g = getDoc().timeline.blocks[0].graph;
    for (const e of g.edges) expect(domainOrderOk(defOf(g.nodes.find((n) => n.id === e.from.node)!.kind)!, defOf(g.nodes.find((n) => n.id === e.to.node)!.kind)!)).toBe(true);
  });

  it('repairStreamOrder moves a Speed found after decode back in front of it (the graph an earlier build made)', () => {
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    addSource(demoProject().resources.sources[0]);
    const id = addBlock(getDoc().resources.sources[0].id, 0, 24, 'motion');
    appendEffect(id, 'fx.posterize');
    // Build the broken shape: Source → decode → posterize → speed → Output.
    projectStore.set((st) => {
      const doc = structuredClone(st.doc);
      const g = doc.timeline.blocks[0].graph;
      const src = g.nodes.find((n) => defOf(n.kind)?.category === 'Source')!;
      const out = g.nodes.find((n) => defOf(n.kind)?.category === 'Output')!;
      void src; // the block's own Decode (Phase 1.1) is already between the Source and posterize
      g.nodes.push({ id: 'spd-1', kind: 'mosh.speed', defVersion: 1, params: { rate: 48.59 }, bindings: {}, position: { x: 0, y: 0 } } as never);
      const toOut = g.edges.find((x) => x.to.node === out.id)!;
      g.edges.push({ id: 'e-spd', from: { node: 'spd-1', port: 'out' }, to: { ...toOut.to } } as never);
      toOut.to = { node: 'spd-1', port: 'in' } as never;
      return { ...st, doc };
    });
    expect(chain(0)).toEqual(['source.clip', 'decode.webcodecs', 'fx.posterize', 'mosh.speed', 'output.sink']);
    const edges = getDoc().timeline.blocks[0].graph.edges.length;
    const { doc, moved } = repairStreamOrder(getDoc());
    projectStore.set((st) => ({ ...st, doc }));
    expect(moved).toEqual(['Speed in Block 1']);
    expect(chain(0)).toEqual(['source.clip', 'mosh.speed', 'decode.webcodecs', 'fx.posterize', 'output.sink']);
    const g = getDoc().timeline.blocks[0].graph;
    expect(g.edges.length).toBe(edges);
    for (const e of g.edges) expect(domainOrderOk(defOf(g.nodes.find((n) => n.id === e.from.node)!.kind)!, defOf(g.nodes.find((n) => n.id === e.to.node)!.kind)!)).toBe(true);
    expect(repairStreamOrder(getDoc()).moved).toEqual([]); // idempotent
  });

  // Waxy's graph: Source fed the Mosh chain AND an effect directly — a second decode, refused at
  // render with a misleading message. The editor now refuses that wire, with the real reason.
  it('a wire making a second decode point is refused; the same effect fed from the decode point is fine', () => {
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    addSource(demoProject().resources.sources[0]);
    const id = addBlock(getDoc().resources.sources[0].id, 0, 24, 'motion');
    appendEffect(id, 'mosh.hold');
    const g = () => getDoc().timeline.blocks[0].graph;
    const src = g().nodes.find((n) => defOf(n.kind)?.category === 'Source')!;
    const hold = g().nodes.find((n) => n.kind === 'mosh.hold')!;
    const fx = addNode(id, 'fx.chroma-drift', { x: 0, y: 0 });
    const bad = connectionError(id, { node: src.id, port: 'out' as never }, { node: fx, port: 'in' as never });
    expect(bad?.code).toBe('GRAPH_SECOND_DECODE');
    expect(bad?.humanMessage).toMatch(/decode its stream twice/);
    expect(connectionError(id, { node: hold.id, port: 'out' as never }, { node: fx, port: 'in' as never })).toBeNull();
  });
});
