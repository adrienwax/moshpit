// 3.2 Phase 3, 3.0a: containers compile by inlining. The zero-determinism-risk property: collapsing
// nodes into a container, and unpacking it again, give the identical compiled plan and freeze key as
// the plain graph (pixels and export bytes: e2e/app.spec.ts, on the real GPU). One level only.
import { describe, expect, it } from 'vitest';
import { newId, type Block, type BlockGraph, type EdgeId, type NodeId, type NodeInstance, type PortKey, type ProjectDoc, type SourceId } from '@moshpit/core';
import { collapseSelection, inlineContainers, macroParams, macroValue, unpackContainer } from '../src/graph/container';
import { discover, discoveryShape } from '../src/control/discovery';
import { compileBlockGraph, type BlockPlan } from '../src/graph/stage2';
import { graphHash } from '../src/runtime/freeze';
import { newBlock, newEdge, newNode, newProject, withChain } from '../src/project/build';
import { parseProject, serializeProject } from '../src/project/io';
import { DEF_BY_KIND } from '../src/nodes/defs';

const src = 's1' as SourceId;
const portType = (n: NodeInstance, port: PortKey) => DEF_BY_KIND.get(n.kind)?.outputs.find((p) => p.key === port)?.type;
const ids = () => { let k = 0; return { container: 'C' as NodeId, groupIn: 'GI' as NodeId, groupOut: 'GO' as NodeId, edge: () => `x${++k}` as EdgeId }; };
const byKind = (g: BlockGraph, kind: string) => g.nodes.find((n) => n.kind === kind)!;
/** Everything in a plan that decides what renders (Maps as sorted entries). */
const planKey = (p: BlockPlan) => JSON.stringify({
  ok: p.ok, errors: p.errors.map((e) => e.code), encodedChain: p.encodedChain, encodedOps: p.encodedOps, decodeSlot: p.decodeSlot,
  steps: p.steps.map((s) => JSON.parse(JSON.stringify(s, (_k, v) => (v instanceof Map ? [...v].sort() : typeof v === 'function' ? undefined : v)))),
  commits: p.commits, delaySlots: [...p.delaySlots].sort(), terminal: p.terminal, outputSlot: p.outputSlot, slotCount: p.slotCount,
  stateful: p.stateful, pastDependent: p.pastDependent, status: [...p.status].sort(),
});
const asBlock = (b: Block, graph: BlockGraph): Block => ({ ...b, graph });
const sorted = (g: BlockGraph) => ({ nodes: [...g.nodes].sort((a, z) => (a.id < z.id ? -1 : 1)), edges: [...g.edges].sort((a, z) => (a.id < z.id ? -1 : 1)) });

/** Source → Hold → Decode → Chroma drift → Posterize → Output: a look that crosses the Decode. */
function vhs(): Block {
  return withChain(newBlock('motion', src, 0, 90), [{ kind: 'mosh.hold' }, { kind: 'fx.chroma-drift' }, { kind: 'fx.posterize' }]);
}

function expectSame(b: Block, collapsedGraph: BlockGraph) {
  const plain = compileBlockGraph(b.id, b.graph);
  expect(plain.ok, plain.errors.map((e) => e.code).join()).toBe(true);
  const collapsed = compileBlockGraph(b.id, collapsedGraph);
  expect(planKey(collapsed)).toBe(planKey(plain));
  expect(graphHash(asBlock(b, collapsedGraph), [])).toBe(graphHash(b, []));
  const back = unpackContainer(collapsedGraph, 'C' as NodeId);
  expect(planKey(compileBlockGraph(b.id, back))).toBe(planKey(plain));
  expect(graphHash(asBlock(b, back), [])).toBe(graphHash(b, []));
  // Unpacking gives the original graph back: the same nodes and the same wires, ids included.
  expect(sorted(back)).toEqual(sorted(b.graph));
}

describe('containers: compile by inlining (3.0a)', () => {
  it('picture effects collapsed: same plan, same freeze key; unpack restores the graph exactly', () => {
    const b = vhs();
    const sel = [byKind(b.graph, 'fx.chroma-drift').id, byKind(b.graph, 'fx.posterize').id];
    const c = collapseSelection(b.graph, sel, ids(), portType);
    expect(c.nodes.some((n) => n.kind === 'fx.posterize')).toBe(false);
    const box = c.nodes.find((n) => n.kind === 'group.container')!;
    expect(box.body!.ports.in.map((p) => p.type)).toEqual(['VideoFrame']);
    expect(box.body!.ports.out.map((p) => p.type)).toEqual(['VideoFrame']);
    expectSame(b, c);
  });

  it('a look that crosses the Decode (D2: Hold, Decode, Chroma drift) collapses and inlines the same', () => {
    const b = vhs();
    const sel = [byKind(b.graph, 'mosh.hold').id, byKind(b.graph, 'decode.webcodecs').id, byKind(b.graph, 'fx.chroma-drift').id];
    const c = collapseSelection(b.graph, sel, ids(), portType);
    const box = c.nodes.find((n) => n.kind === 'group.container')!;
    expect(box.body!.ports.in.map((p) => p.type)).toEqual(['EncodedVideoStream']);
    expect(box.body!.ports.out.map((p) => p.type)).toEqual(['VideoFrame']);
    expectSame(b, c);
  });

  it('a branch (one source feeding two inner inputs) and a Mix collapse to one input port', () => {
    const b = newBlock('picture', src, 0, 90);
    const g = b.graph;
    const dec = byKind(g, 'decode.webcodecs'), out = byKind(g, 'output.sink');
    g.edges = g.edges.filter((e) => e.to.node !== out.id);
    const inv = newNode('fx.invert'), mix = newNode('route.mix', { x: 0, y: 0 }, { mix: 0.5 });
    g.nodes.push(inv, mix);
    g.edges.push(newEdge(dec.id, inv.id), newEdge(dec.id, mix.id, 'out', 'a'), newEdge(inv.id, mix.id, 'out', 'b'), newEdge(mix.id, out.id));
    const c = collapseSelection(g, [inv.id, mix.id], ids(), portType);
    expect(c.nodes.find((n) => n.kind === 'group.container')!.body!.ports.in).toHaveLength(1);
    expectSame(b, c);
  });

  it('one level only: collapsing a container, or inlining a nested one, is refused', () => {
    const b = vhs();
    const c = collapseSelection(b.graph, [byKind(b.graph, 'fx.posterize').id], ids(), portType);
    expect(() => collapseSelection(c, ['C' as NodeId], { ...ids(), container: 'C2' as NodeId, groupIn: 'GI2' as NodeId, groupOut: 'GO2' as NodeId }, portType)).toThrowError(/CONTAINER_NESTED/);
    const box = c.nodes.find((n) => n.id === 'C')!;
    box.body!.graph.nodes.push({ ...box, id: 'inner-box' as NodeId });
    const plan = compileBlockGraph(b.id, c);
    expect(plan.ok).toBe(false);
    expect(plan.errors.map((e) => e.code)).toContain('CONTAINER_NESTED');
  });

  it('a broken container (no Group output) is reported, not compiled around', () => {
    const b = vhs();
    const c = collapseSelection(b.graph, [byKind(b.graph, 'fx.posterize').id], ids(), portType);
    const box = c.nodes.find((n) => n.id === 'C')!;
    box.body!.graph.nodes = box.body!.graph.nodes.filter((n) => n.kind !== 'group.out');
    const plan = compileBlockGraph(b.id, c);
    expect(plan.ok).toBe(false);
    expect(plan.errors.map((e) => e.code)).toContain('CONTAINER_INVALID');
  });

  it('the one-decode rule holds on the inlined graph: a container cannot smuggle in a second decode', () => {
    // As decode.test: with a Mosh op before the Decode, Source → effect beside it decodes a second time.
    const b = withChain(newBlock('picture', src, 0, 30), [{ kind: 'mosh.hold' }, { kind: 'fx.posterize' }]);
    const g = b.graph, source = byKind(g, 'source.clip'), post = byKind(g, 'fx.posterize'), out = byKind(g, 'output.sink');
    const inv = newNode('fx.invert'), mix = newNode('route.mix');
    const second: BlockGraph = { nodes: [...g.nodes, inv, mix], edges: [...g.edges.filter((e) => e.to.node !== out.id), newEdge(source.id, inv.id), newEdge(post.id, mix.id, 'out', 'a'), newEdge(inv.id, mix.id, 'out', 'b'), newEdge(mix.id, out.id)] };
    const plain = compileBlockGraph(b.id, second).errors.map((e) => e.code);
    expect(plain).toContain('GRAPH_SECOND_DECODE');
    const c = collapseSelection(second, [inv.id], ids(), portType); // the offending effect, hidden in a container
    expect(compileBlockGraph(b.id, c).errors.map((e) => e.code)).toEqual(plain);
  });

  it('macros drive inner params through their Map-Range, and enter the freeze key', () => {
    const b = vhs();
    const post = byKind(b.graph, 'fx.posterize');
    const c = collapseSelection(b.graph, [post.id], ids(), portType);
    const box = c.nodes.find((n) => n.id === 'C')!;
    box.body!.macros = [{ key: 'crunch' as never, label: 'Crunch', help: 'Fewer levels, harder bands', min: 0, max: 1, default: 0, target: { node: post.id, param: 'levels' as never }, map: { from: 16, to: 2, curve: 'linear' } as never }];
    box.params = { crunch: 0.5 };
    const flat = inlineContainers(c).graph;
    expect(flat.nodes.find((n) => n.id === post.id)!.params.levels).toBe(9);
    const h1 = graphHash(asBlock(b, c), []);
    box.params = { crunch: 1 };
    expect(inlineContainers(c).graph.nodes.find((n) => n.id === post.id)!.params.levels).toBe(2);
    expect(graphHash(asBlock(b, c), [])).not.toBe(h1);
    expect(box.body!.graph.nodes.find((n) => n.id === post.id)!.params.levels).not.toBe(2); // the body is never mutated
  });

  it('an unturned macro leaves its param as authored (a stamped look renders as its chain); ints are whole', () => {
    const b = vhs();
    const post = byKind(b.graph, 'fx.posterize');
    const c = collapseSelection(b.graph, [post.id], ids(), portType);
    const box = c.nodes.find((n) => n.id === 'C')!;
    box.body!.macros = [{ key: 'crunch' as never, label: 'Crunch', help: '', min: 0, max: 1, default: 0, target: { node: post.id, param: 'levels' as never }, map: { from: 16, to: 2, curve: 'linear' } as never }];
    expect(graphHash(asBlock(b, c), [])).toBe(graphHash(b, [])); // no value on the container: identical
    box.params = { crunch: 0.3 }; // 16 - 14 * 0.3 = 11.8
    expect(inlineContainers(c).graph.nodes.find((n) => n.id === post.id)!.params.levels).toBe(12);
  });

  it('macros are params (3.3): the dial starts where the look is, and the CT sees one slot with the macros as dials', () => {
    const b = vhs();
    const post = byKind(b.graph, 'fx.posterize'), chroma = byKind(b.graph, 'fx.chroma-drift');
    post.params.levels = 5;
    const c = collapseSelection(b.graph, [chroma.id, post.id], ids(), portType);
    const box = c.nodes.find((n) => n.id === 'C')!;
    box.label = 'Grit';
    box.body!.macros = [{ key: 'crunch' as never, label: 'Crunch', help: 'Fewer levels', min: 0, max: 1, default: 0, target: { node: post.id, param: 'levels' as never }, map: { from: 16, to: 2, curve: 'linear' } }];
    expect(macroParams(box).map((p) => [p.key, p.min, p.max, p.ctOrder])).toEqual([['crunch', 0, 1, 1]]);
    expect(macroValue(box, 'crunch')).toBeCloseTo(11 / 14, 6); // (5 - 16) / (2 - 16): where levels 5 sits
    box.params = { crunch: 0.25 };
    expect(macroValue(box, 'crunch')).toBe(0.25);
    const doc = newProject('t');
    doc.timeline.blocks = [asBlock(b, c)];
    const d = discover(doc, 1, b.id);
    expect(d.slots.map((s) => s.name)).toEqual(['Hold', 'Grit']); // Chroma drift and Posterize are inside
    expect(d.slots[1].params).toEqual([`/block/${b.id}/node/C/param/crunch`, `/block/${b.id}/node/C/param/bypass`]); // its macros, then bypass
    expect(d.targets.find((t) => t.path.endsWith('/crunch'))!.value).toBe(0.25);
  });

  it('a bypassed container skips its look: every inner node bypassed but a Decode; it enters the freeze key', () => {
    const b = vhs();
    const pick = ['mosh.hold', 'decode.webcodecs', 'fx.chroma-drift'].map((k) => byKind(b.graph, k).id);
    const c = collapseSelection(b.graph, pick, ids(), portType);
    const h = graphHash(asBlock(b, c), []);
    c.nodes.find((n) => n.id === 'C')!.bypass = true;
    const flat = inlineContainers(c).graph;
    expect(flat.nodes.filter((n) => pick.includes(n.id)).map((n) => [n.kind, !!n.bypass])).toEqual([['mosh.hold', true], ['decode.webcodecs', false], ['fx.chroma-drift', true]]);
    expect(compileBlockGraph(b.id, c).ok).toBe(true);
    expect(graphHash(asBlock(b, c), [])).not.toBe(h);
    c.nodes.find((n) => n.id === 'C')!.bypass = false;
    expect(graphHash(asBlock(b, c), [])).toBe(h);
  });

  it('the discovery shape changes when a macro is added or removed, not when one is turned (audit P2)', () => {
    const b = vhs();
    const post = byKind(b.graph, 'fx.posterize');
    const c = collapseSelection(b.graph, [post.id], ids(), portType);
    const doc = newProject('t');
    doc.timeline.blocks = [asBlock(b, c)];
    const box = c.nodes.find((n) => n.id === 'C')!;
    const s0 = discoveryShape(doc);
    box.body!.macros = [{ key: 'crunch' as never, label: 'Crunch', help: '', min: 0, max: 1, default: 0, target: { node: post.id, param: 'levels' as never } }];
    const s1 = discoveryShape(doc);
    expect(s1).not.toBe(s0); // a dial appeared: re-discover
    box.params = { crunch: 0.7 };
    expect(discoveryShape(doc)).toBe(s1); // a value: a push, not a re-discover
    box.body!.macros = [];
    expect(discoveryShape(doc)).toBe(s0);
  });

  it('a viewer on a container shows its output (the node feeding Group output)', () => {
    const b = vhs();
    const post = byKind(b.graph, 'fx.posterize');
    const c = collapseSelection(b.graph, [byKind(b.graph, 'fx.chroma-drift').id, post.id], ids(), portType);
    expect(compileBlockGraph(b.id, c, { terminal: 'C' as NodeId }).terminal).toBe(post.id);
  });
});

describe('the file format (D3): graph 2 only when a project holds a container', () => {
  const docWith = (graph?: BlockGraph): ProjectDoc => {
    const d = newProject('t');
    const b = vhs();
    d.timeline.blocks = [graph ? asBlock(b, graph) : b];
    return d;
  };
  it('a project without a container is written at graph 1, and opens in 3.1 as before', () => {
    expect(JSON.parse(serializeProject(docWith())).versions.graph).toBe(1);
  });
  it('a project with a container is written at graph 2; 3.1 (graph 1) opens it with PROJECT_TOO_NEW', () => {
    const b = vhs();
    const text = serializeProject(docWith(collapseSelection(b.graph, [byKind(b.graph, 'fx.posterize').id], ids(), portType)));
    expect(JSON.parse(text).versions.graph).toBe(2);
    const in31 = parseProject(text, { project: 1, graph: 1, nodeDefs: 1, components: 1, resources: 1 });
    expect(in31.warnings.map((w) => w.code)).toContain('PROJECT_TOO_NEW');
    expect(JSON.stringify(in31.doc)).toContain('group.container'); // kept verbatim (C4)
  });
  it('a 3.1 file (graph 1) migrates to 2 in memory and saves back at 1; a newer build\'s version is kept', () => {
    const d = docWith();
    d.versions = { ...d.versions, graph: 1 };
    const r = parseProject(JSON.stringify(d));
    expect(r.migrated.graph).toEqual([1, 2]);
    expect(JSON.parse(serializeProject(r.doc)).versions.graph).toBe(1);
    const future = { ...docWith(), versions: { ...docWith().versions, graph: 3 } };
    expect(JSON.parse(serializeProject(future)).versions.graph).toBe(3);
  });
});

void newId;
