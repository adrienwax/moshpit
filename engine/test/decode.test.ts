// Phase 1.1: the drawn Decode changes nothing the engine does. A graph with it compiles and hashes
// exactly like the same graph without it (old projects' freezes stay fresh), a viewer on it shows
// the decoded picture, it may fan out, and a second decode is still refused.
import { describe, expect, it } from 'vitest';
import type { Block, SourceId } from '@moshpit/core';
import { compileBlockGraph } from '../src/graph/stage2';
import { elideDecode } from '../src/graph/decode';
import { graphHash } from '../src/runtime/freeze';
import { newBlock, newEdge, newNode, withChain } from '../src/project/build';
import { DECODE, isPlaceable } from '../src/nodes/defs';

const S = 'S' as SourceId;
const chain = [{ kind: 'mosh.hold' }, { kind: 'fx.posterize' }, { kind: 'fx.invert' }];

/** The same block as projects stored it before Phase 1.1: no Decode node, the source → frame wire decodes. */
function withoutDecode(b: Block): Block {
  return { ...b, graph: elideDecode(b.graph).graph };
}

describe('the drawn Decode (Phase 1.1)', () => {
  it('new blocks draw Source → Decode → Output, and Decode is placeable', () => {
    const b = newBlock('picture', S, 0, 30);
    expect(b.graph.nodes.map((n) => n.kind)).toEqual(['source.clip', DECODE.kind, 'output.sink']);
    expect(isPlaceable(DECODE)).toBe(true);
    expect(compileBlockGraph(b.id, b.graph).ok).toBe(true);
  });

  it('withChain puts Mosh ops before the Decode and picture ops after it', () => {
    const b = withChain(newBlock('motion', S, 0, 60), [{ kind: 'fx.invert' }, { kind: 'mosh.hold' }]);
    expect(b.graph.nodes.map((n) => n.kind)).toEqual(['source.clip', 'mosh.hold', DECODE.kind, 'fx.invert', 'output.sink']);
  });

  it('compiles to the same plan as the graph without it', () => {
    const b = withChain(newBlock('motion', S, 0, 60), chain);
    const a = compileBlockGraph(b.id, b.graph), z = compileBlockGraph(b.id, withoutDecode(b).graph);
    expect(a.ok && z.ok).toBe(true);
    expect(a.steps.map((s) => s.def.kind)).toEqual(z.steps.map((s) => s.def.kind));
    expect(a.encodedOps).toEqual(z.encodedOps);
    expect(a.errors).toEqual(z.errors);
  });

  it('hashes the same, so a freeze made before the Decode was drawn stays fresh', () => {
    const b = withChain(newBlock('motion', S, 0, 60), chain);
    expect(graphHash(b, [])).toBe(graphHash(withoutDecode(b), []));
  });

  it('a viewer on the Decode shows the decoded picture (the node feeding it)', () => {
    const b = withChain(newBlock('motion', S, 0, 60), chain);
    const dec = b.graph.nodes.find((n) => n.kind === DECODE.kind)!;
    const p = compileBlockGraph(b.id, b.graph, { terminal: dec.id });
    expect(p.errors).toEqual([]);
    expect(p.steps.map((s) => s.def.kind)).not.toContain('fx.posterize');
  });

  it('may fan out to two effects (one decode), while a Source → effect wire beside it is still a second decode', () => {
    // With a Mosh op before the Decode, Source → effect would decode the stream a second time (Waxy's graph).
    const b = withChain(newBlock('picture', S, 0, 30), [{ kind: 'mosh.hold' }, { kind: 'fx.posterize' }]);
    const g = b.graph, dec = g.nodes.find((n) => n.kind === DECODE.kind)!, src = g.nodes.find((n) => n.kind === 'source.clip')!;
    const inv = newNode('fx.invert'), mix = newNode('route.mix');
    const post = g.nodes.find((n) => n.kind === 'fx.posterize')!, out = g.nodes.find((n) => n.kind === 'output.sink')!;
    const fan = { nodes: [...g.nodes, inv, mix], edges: [...g.edges.filter((e) => e.to.node !== out.id), newEdge(dec.id, inv.id), newEdge(post.id, mix.id, 'out', 'a'), newEdge(inv.id, mix.id, 'out', 'b'), newEdge(mix.id, out.id)] };
    expect(compileBlockGraph(b.id, fan).errors.map((e) => e.code)).toEqual([]);
    const second = { nodes: fan.nodes, edges: [...fan.edges.filter((e) => e.to.node !== inv.id), newEdge(src.id, inv.id)] };
    expect(compileBlockGraph(b.id, second).errors.map((e) => e.code)).toContain('GRAPH_SECOND_DECODE');
  });
});
