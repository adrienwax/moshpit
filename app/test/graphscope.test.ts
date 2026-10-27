// 3.0b: every node and wire command takes a GraphAt, so the same commands edit a container's insides.
// A block id is the block's own graph (all existing callers, unchanged); { blockId, container } is the
// graph inside that container. Ports come from the instance (a container's from its body).
import { describe, expect, it } from 'vitest';
import { collapseSelection, compileBlockGraph, inlineContainers, macroParams, macroTarget, type EdgeId, type NodeId } from '@moshpit/engine';
import { graphHash } from '../../engine/src/runtime/freeze';
import {
  addBlock, addLfo, addNode, addSource, appendEffect, collapseNodes, exposeMacro, removeMacro, renameContainer, MAX_MACROS, connect, connectionError, emptyDoc, getDoc, linkParam, lfoLinks, ports, projectStore,
  removeEdges, removeNodes, setBypass, setParam, undo, unpackNodes, type GraphAt,
} from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';

function setup() {
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  addSource(demoProject().resources.sources[0]);
  const blockId = addBlock(getDoc().resources.sources[0].id, 0, 24, 'picture');
  appendEffect(blockId, 'fx.chroma-drift');
  appendEffect(blockId, 'fx.posterize');
  const g = getDoc().timeline.blocks[0].graph;
  const pick = ['fx.chroma-drift', 'fx.posterize'].map((k) => g.nodes.find((n) => n.kind === k)!.id);
  let k = 0;
  const graph = collapseSelection(g, pick, { container: 'C' as NodeId, groupIn: 'GI' as NodeId, groupOut: 'GO' as NodeId, edge: () => `x${++k}` as EdgeId }, (n, port) => ports(n, 'out').find((p) => p.key === port)?.type);
  projectStore.set((s) => ({ ...s, doc: { ...s.doc, timeline: { ...s.doc.timeline, blocks: [{ ...s.doc.timeline.blocks[0], graph }] } }, past: [] }));
  const at: GraphAt = { blockId, container: 'C' as NodeId };
  const block = () => getDoc().timeline.blocks[0];
  const body = () => block().graph.nodes.find((n) => n.id === 'C')!.body!;
  return { blockId, at, block, body, post: pick[1] };
}

describe('graph scope (3.0b)', () => {
  it('ports are per instance: a container shows its body ports, Group nodes show them from the inside', () => {
    const { block, body } = setup();
    const c = block().graph.nodes.find((n) => n.id === 'C')!;
    expect(ports(c, 'in').map((p) => [p.key, p.type])).toEqual([['in1', 'VideoFrame']]);
    expect(ports(c, 'out').map((p) => [p.key, p.type])).toEqual([['out1', 'VideoFrame']]);
    const gi = body().graph.nodes.find((n) => n.id === 'GI')!, go = body().graph.nodes.find((n) => n.id === 'GO')!;
    expect([ports(gi, 'out', body()).map((p) => p.key), ports(gi, 'in', body())]).toEqual([['in1'], []]);
    expect([ports(go, 'in', body()).map((p) => p.key), ports(go, 'out', body())]).toEqual([['out1'], []]);
    expect(compileBlockGraph(block().id, block().graph).ok).toBe(true);
  });

  it('param, bypass and LFO edits land inside the container, each one undo step; the block graph is untouched', () => {
    const { at, block, body, post } = setup();
    const outer = block().graph.edges;
    setParam(at, post, 'levels', 5);
    expect(body().graph.nodes.find((n) => n.id === post)!.params.levels).toBe(5);
    expect(block().graph.edges).toBe(outer); // structural sharing: only the body changed
    setBypass(at, post, true);
    expect(body().graph.nodes.find((n) => n.id === post)!.bypass).toBe(true);
    undo();
    undo();
    expect(body().graph.nodes.find((n) => n.id === post)!.params.levels).not.toBe(5);
    addLfo();
    linkParam(getDoc().modulators.lfos.at(-1)!.id, at, post, 'levels');
    expect(lfoLinks(getDoc()).some((l) => l.node.id === post)).toBe(true); // lists see inner nodes
  });

  it('wires and nodes inside: add from Group input, refuse an occupied Group output, rewire, delete', () => {
    const { at, block, body } = setup();
    const inv = addNode(at, 'fx.invert', { x: 0, y: 0 }, { node: 'GI' as NodeId, port: 'in1' as never });
    expect(body().graph.edges.some((e) => e.from.node === 'GI' && e.to.node === inv)).toBe(true); // typed through the body's ports
    const toOut = { node: 'GO' as NodeId, port: 'out1' as never };
    expect(connectionError(at, { node: inv, port: 'out' as never }, toOut)?.code).toBe('GRAPH_PORT_OCCUPIED');
    const fed = body().graph.edges.find((e) => e.to.node === 'GO')!;
    removeEdges(at, [fed.id]);
    connect(at, { node: inv, port: 'out' as never }, toOut);
    expect(body().graph.edges.find((e) => e.to.node === 'GO')!.from.node).toBe(inv);
    expect(compileBlockGraph(block().id, block().graph).ok).toBe(true); // the inlined block still compiles
    removeNodes(at, [inv]);
    expect(body().graph.nodes.some((n) => n.id === inv)).toBe(false);
  });

  it('a plain block id reaches an inner node (inspector, LFO panes, CT writes need no scope)', () => {
    const { blockId, body, post } = setup();
    setParam(blockId, post, 'levels', 7);
    setBypass(blockId, post, true);
    const n = body().graph.nodes.find((x) => x.id === post)!;
    expect([n.params.levels, n.bypass]).toEqual([7, true]);
  });

  it('a block id still means the block graph (every existing caller)', () => {
    const { blockId, block } = setup();
    const n = addNode(blockId, 'fx.invert', { x: 0, y: 0 });
    expect(block().graph.nodes.some((x) => x.id === n)).toBe(true);
  });
});

describe('collapse and unpack commands (3.4 / 3.5)', () => {
  const fresh = () => {
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    addSource(demoProject().resources.sources[0]);
    const blockId = addBlock(getDoc().resources.sources[0].id, 0, 24, 'motion');
    appendEffect(blockId, 'mosh.hold');
    appendEffect(blockId, 'fx.chroma-drift');
    appendEffect(blockId, 'fx.posterize');
    return blockId;
  };
  const sorted = (g: { nodes: { id: string }[]; edges: { id: string }[] }) => JSON.stringify({ n: [...g.nodes].sort((a, z) => (a.id < z.id ? -1 : 1)), e: [...g.edges].sort((a, z) => (a.id < z.id ? -1 : 1)) });

  it('collapse is one undo step; unpack gives the identical graph back (ids included)', () => {
    const blockId = fresh();
    const before = getDoc().timeline.blocks[0].graph;
    const pick = before.nodes.filter((n) => ['mosh.hold', 'decode.webcodecs', 'fx.chroma-drift'].includes(n.kind)).map((n) => n.id);
    const c = collapseNodes(blockId, pick, 'VHS');
    const g = getDoc().timeline.blocks[0].graph;
    const box = g.nodes.find((n) => n.id === c)!;
    expect([box.kind, box.label, box.body!.graph.nodes.length]).toEqual(['group.container', 'VHS', 5]); // 3 + Group in / out
    expect(ports(box, 'in').map((p) => p.type)).toEqual(['EncodedVideoStream']); // a look that crosses the Decode (D2)
    expect(compileBlockGraph(blockId, g).ok).toBe(true);
    undo();
    expect(getDoc().timeline.blocks[0].graph).toBe(before);
    const c2 = collapseNodes(blockId, pick);
    unpackNodes(blockId, c2);
    expect(sorted(getDoc().timeline.blocks[0].graph)).toBe(sorted(before));
  });

  it('one level only, and the Group nodes stay', () => {
    const blockId = fresh();
    const g = getDoc().timeline.blocks[0].graph;
    const c = collapseNodes(blockId, [g.nodes.find((n) => n.kind === 'fx.posterize')!.id]);
    const at: GraphAt = { blockId, container: c };
    const inner = getDoc().timeline.blocks[0].graph.nodes.find((n) => n.id === c)!.body!.graph;
    expect(() => collapseNodes(at, [inner.nodes.find((n) => n.kind === 'fx.posterize')!.id])).toThrowError(/CONTAINER_NESTED/);
    expect(() => collapseNodes(blockId, [c])).toThrowError(/CONTAINER_NESTED/);
    removeNodes(at, inner.nodes.map((n) => n.id));
    const left = getDoc().timeline.blocks[0].graph.nodes.find((n) => n.id === c)!.body!.graph.nodes.map((n) => n.kind).sort();
    expect(left).toEqual(['group.in', 'group.out']);
  });
});

describe('macros (3.3)', () => {
  it('expose → turn → the inner param follows; remove keeps the turned value; six at most; each one undo step', () => {
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    addSource(demoProject().resources.sources[0]);
    const blockId = addBlock(getDoc().resources.sources[0].id, 0, 24, 'picture');
    appendEffect(blockId, 'fx.posterize');
    appendEffect(blockId, 'fx.chroma-drift');
    const g = getDoc().timeline.blocks[0].graph;
    const post = g.nodes.find((n) => n.kind === 'fx.posterize')!.id, chroma = g.nodes.find((n) => n.kind === 'fx.chroma-drift')!.id;
    const c = collapseNodes(blockId, [post, chroma], 'Grit');
    renameContainer(blockId, c, 'Grit 2');
    const box = () => getDoc().timeline.blocks[0].graph.nodes.find((n) => n.id === c)!;
    const flat = () => inlineContainers(getDoc().timeline.blocks[0].graph).graph;
    const levels0 = box().body!.graph.nodes.find((n) => n.id === post)!.params.levels;
    const k = exposeMacro(blockId, c, post, 'levels');
    expect(box().body!.macros.map((m) => [m.label, m.map])).toEqual([['Levels', { from: 2, to: 32, curve: 'linear' }]]);
    expect(flat().nodes.find((n) => n.id === post)!.params.levels).toBe(levels0); // unturned: as authored
    setParam(blockId, c, k, 0.5); // the inspector, the face and a CT write all land here
    expect(flat().nodes.find((n) => n.id === post)!.params.levels).toBe(17); // 2 + 30 * 0.5
    undo();
    expect(box().params[k]).toBeUndefined();
    setParam(blockId, c, k, 1);
    removeMacro(blockId, c, k);
    expect([box().body!.macros.length, box().body!.graph.nodes.find((n) => n.id === post)!.params.levels]).toEqual([0, 32]); // baked in, no jump
    expect(() => exposeMacro(blockId, c, post, 'nope')).toThrowError(/PARAM_UNKNOWN/);
    for (const key of ['levels', 'wet']) exposeMacro(blockId, c, post, key);
    for (const key of ['cb', 'cr', 'wet']) exposeMacro(blockId, c, chroma, key);
    expect(box().body!.macros.length).toBe(5);
    expect(() => exposeMacro(blockId, c, post, 'levels')).toThrowError(/PARAM_UNKNOWN/); // already one
    expect(box().label).toBe('Grit 2');
    expect(MAX_MACROS).toBe(6);
  });
});

describe('macro reset (audit P2)', () => {
  it('a reset restores the authored value exactly: no float round trip, the freeze key unchanged', () => {
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    addSource(demoProject().resources.sources[0]);
    const blockId = addBlock(getDoc().resources.sources[0].id, 0, 24, 'picture');
    appendEffect(blockId, 'fx.chroma-drift');
    const chroma = getDoc().timeline.blocks[0].graph.nodes.find((n) => n.kind === 'fx.chroma-drift')!.id;
    const c = collapseNodes(blockId, [chroma], 'Bleed');
    const box = () => getDoc().timeline.blocks[0].graph.nodes.find((n) => n.id === c)!;
    const key = exposeMacro(blockId, c, chroma, 'cb');
    // An authored value whose trip through the Map-Range and back is not exact (so the test can fail).
    let authored = 0;
    for (const v of [33.3, 17.1, 44.7, 61.9, 5.3, 90.1]) {
      setParam(blockId, chroma, 'cb', v);
      const at = macroParams(box()).find((p) => p.key === key)!.default as number;
      if (macroTarget(box(), key, at)!.value !== v) { authored = v; break; }
    }
    expect(authored, 'found an authored value the round trip changes').not.toBe(0);
    const h0 = graphHash(getDoc().timeline.blocks[0], []);
    setParam(blockId, c, key, 0.9); // turned
    expect(graphHash(getDoc().timeline.blocks[0], [])).not.toBe(h0);
    setParam(blockId, c, key, macroParams(box()).find((p) => p.key === key)!.default as number); // right-click reset
    expect(box().params[key]).toBeUndefined();
    expect(inlineContainers(getDoc().timeline.blocks[0].graph).graph.nodes.find((n) => n.id === chroma)!.params.cb).toBe(authored);
    expect(graphHash(getDoc().timeline.blocks[0], [])).toBe(h0);
  });
});
