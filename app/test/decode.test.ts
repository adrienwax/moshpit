// Phase 1.1, app side: projects from before Phase 1.1 open with their Decode drawn (once, at the
// implicit boundary), and a refused second decode has a one-click fix: feed from the Decode.
import { describe, expect, it } from 'vitest';
import { addBlock, addNode, addSource, appendEffect, connect, connectionError, emptyDoc, ensureDecode, feedFromDecode, getDoc, insertReroute, projectStore, removeNodes, undo } from '../src/state/project';
import { compileBlockGraph } from '@moshpit/engine';
import { demoProject } from '../src/engine/mockProject';

const DEC = 'decode.webcodecs';

/** One motion block: Source → Hold → Decode → Posterize → Output. */
function setup() {
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  addSource(demoProject().resources.sources[0]);
  const id = addBlock(getDoc().resources.sources[0].id, 0, 24, 'motion');
  appendEffect(id, 'mosh.hold');
  appendEffect(id, 'fx.posterize');
  return id;
}
const graph = () => getDoc().timeline.blocks[0].graph;
const kindOf = (id: string) => graph().nodes.find((n) => n.id === id)?.kind;

describe('the drawn Decode, app side (Phase 1.1)', () => {
  it('an old project (no Decode node) opens with one drawn at its boundary; opening again adds nothing', () => {
    setup();
    // The shape projects had before Phase 1.1: Hold wired straight into Posterize.
    projectStore.set((st) => {
      const doc = structuredClone(st.doc), g = doc.timeline.blocks[0].graph;
      const dec = g.nodes.find((n) => n.kind === DEC)!;
      const into = g.edges.find((e) => e.to.node === dec.id)!, out = g.edges.find((e) => e.from.node === dec.id)!;
      out.from = { ...into.from };
      g.edges = g.edges.filter((e) => e !== into);
      g.nodes = g.nodes.filter((n) => n !== dec);
      return { ...st, doc };
    });
    expect(graph().nodes.some((n) => n.kind === DEC)).toBe(false);
    const once = ensureDecode(getDoc());
    const g = once.timeline.blocks[0].graph, dec = g.nodes.find((n) => n.kind === DEC)!;
    expect(g.nodes.filter((n) => n.kind === DEC)).toHaveLength(1);
    expect(g.nodes.find((n) => n.id === g.edges.find((e) => e.to.node === dec.id)!.from.node)!.kind).toBe('mosh.hold');
    expect(g.nodes.find((n) => n.id === g.edges.find((e) => e.from.node === dec.id)!.to.node)!.kind).toBe('fx.posterize');
    expect(ensureDecode(once)).toBe(once); // nothing more to draw
  });

  it('a refused second decode is fixed in one click: the input is fed from the Decode, one undo step', () => {
    const id = setup();
    const src = graph().nodes.find((n) => n.kind === 'source.clip')!;
    const post = graph().nodes.find((n) => n.kind === 'fx.posterize')!;
    // Waxy's wiring: the Source straight into a free effect input, beside the Mosh chain.
    addNode(id, 'fx.invert', { x: 400, y: 300 });
    const inv = graph().nodes.find((n) => n.kind === 'fx.invert')!;
    const to = { node: inv.id, port: 'in' as never };
    expect(connectionError(id, { node: src.id, port: 'out' as never }, to)?.code).toBe('GRAPH_SECOND_DECODE');
    expect(() => connect(id, { node: src.id, port: 'out' as never }, to)).toThrow();
    const steps = projectStore.get().past.length;
    feedFromDecode(id, to);
    const feeder = graph().edges.find((e) => e.to.node === inv.id)!;
    expect(kindOf(feeder.from.node)).toBe(DEC);
    expect(graph().edges.filter((e) => e.to.node === inv.id)).toHaveLength(1);
    expect(projectStore.get().past.length).toBe(steps + 1);
    undo();
    expect(graph().edges.some((e) => e.to.node === inv.id)).toBe(false); // back to unwired
    void post;
  });

  // Hardening: deleting a pass-through keeps its wire (dissolve); deleting anything else does not.
  it('deleting a Decode, or a Reroute + Null run, keeps the wire; deleting an effect does not', () => {
    const id = setup();
    const dec = graph().nodes.find((n) => n.kind === DEC)!;
    removeNodes(id, [dec.id]);
    const post = graph().nodes.find((n) => n.kind === 'fx.posterize')!;
    expect(kindOf(graph().edges.find((e) => e.to.node === post.id)!.from.node)).toBe('mosh.hold');
    expect(compileBlockGraph(id, graph()).errors.map((e) => e.code)).toEqual([]);
    undo();
    expect(graph().nodes.some((n) => n.kind === DEC)).toBe(true);
    // Posterize → Reroute → Null → Output, then delete both in one go.
    const out = graph().nodes.find((n) => n.kind === 'output.sink')!;
    const toOut = graph().edges.find((e) => e.to.node === out.id)!;
    insertReroute(id, toOut.id, { x: 0, y: 0 });
    const rr = graph().nodes.find((n) => n.kind === 'route.reroute')!;
    insertReroute(id, graph().edges.find((e) => e.to.node === out.id)!.id, { x: 0, y: 0 });
    const both = graph().nodes.filter((n) => n.kind === 'route.reroute').map((n) => n.id);
    expect(both).toHaveLength(2);
    const steps = projectStore.get().past.length;
    removeNodes(id, both);
    expect(kindOf(graph().edges.find((e) => e.to.node === out.id)!.from.node)).toBe('fx.posterize');
    expect(projectStore.get().past.length).toBe(steps + 1);
    void rr;
    removeNodes(id, [post.id]); // an effect: its wires go, nothing is bridged
    expect(graph().edges.some((e) => e.to.node === out.id)).toBe(false);
  });

  // Hardening (Phase 1 audit): a block with no Decode whose implicit boundary is ambiguous (it
  // already decodes from two points) has nothing to feed from. The fix must not throw: it changes
  // nothing and says why.
  it('Feed from Decode on an ambiguous Decode-less block changes nothing, says why, never throws', () => {
    const id = setup();
    addNode(id, 'fx.invert', { x: 400, y: 300 });
    projectStore.set((st) => {
      const doc = structuredClone(st.doc), g = doc.timeline.blocks[0].graph;
      const dec = g.nodes.find((n) => n.kind === DEC)!, src = g.nodes.find((n) => n.kind === 'source.clip')!, inv = g.nodes.find((n) => n.kind === 'fx.invert')!;
      // Remove the Decode (bridging it), then decode a second time: Source straight into Invert.
      const into = g.edges.find((e) => e.to.node === dec.id)!;
      for (const e of g.edges) if (e.from.node === dec.id) e.from = { ...into.from };
      g.edges = g.edges.filter((e) => e !== into);
      g.nodes = g.nodes.filter((n) => n !== dec);
      g.edges.push({ id: 'e-second', from: { node: src.id, port: 'out' }, to: { node: inv.id, port: 'in' } } as never);
      return { ...st, doc };
    });
    const before = JSON.stringify(graph()), steps = projectStore.get().past.length;
    const inv = graph().nodes.find((n) => n.kind === 'fx.invert')!;
    let r: ReturnType<typeof feedFromDecode> | undefined;
    expect(() => (r = feedFromDecode(id, { node: inv.id, port: 'in' as never }))).not.toThrow();
    expect(r).toMatchObject({ ok: false });
    expect((r as { why: string }).why).toMatch(/more than one place/);
    expect(JSON.stringify(graph())).toBe(before);
    expect(projectStore.get().past.length).toBe(steps);
  });
});
