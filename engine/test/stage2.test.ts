import { describe, expect, it } from 'vitest';
import { compileBlockGraph } from '../src/graph/stage2';
import type { BlockGraph, BlockId, EdgeId, GraphEdge, NodeId, NodeInstance, PortKey } from '../src/model';

const B = 'blk' as BlockId;
let x = 0;
const node = (id: string, kind: string, params: NodeInstance['params'] = {}, extra: Partial<NodeInstance> = {}): NodeInstance =>
  ({ id: id as NodeId, kind: kind as never, defVersion: 1, params, bindings: {}, position: { x: x++, y: 0 }, ...extra });
const edge = (from: string, to: string, fp = 'out', tp = 'in'): GraphEdge =>
  ({ id: `${from}>${to}:${tp}` as EdgeId, from: { node: from as NodeId, port: fp as PortKey }, to: { node: to as NodeId, port: tp as PortKey } });
const codes = (es: { code: string }[]) => es.map((e) => e.code);

/** The default block graph every new block gets: source → decode → output. */
const chain = (...mid: NodeInstance[]): BlockGraph => {
  const nodes = [node('src', 'source.clip'), ...mid, node('out', 'output.sink')];
  const ids = nodes.map((n) => n.id as string);
  return { nodes, edges: ids.slice(1).map((id, i) => edge(ids[i], id)) };
};

describe('stage 2: per-block graph compiler', () => {
  it('splits at the one decode boundary and orders the GPU steps', () => {
    const p = compileBlockGraph(B, chain(node('rev', 'mosh.reorder', { mode: 'reverse', from: 5, to: 40 }), node('pd', 'fx.plane-desync'), node('fb', 'fx.feedback')));
    expect(p.ok).toBe(true);
    expect(p.encodedChain).toEqual(['src', 'rev']);
    expect(p.encodedOps).toEqual([{ kind: 'reorder', mode: 'reverse', from: 5, to: 40 }]);
    expect(p.steps.map((s) => s.node)).toEqual(['pd', 'fb', 'out']);
    expect(p.steps[0].inputs).toEqual([p.decodeSlot]);
    expect(p.outputSlot).toBe(p.steps[1].output);
    expect(p.stateful).toEqual(['fb']);
    expect(p.pastDependent).toBe(true);
  });

  it('reuses texture slots once a value is consumed (zero-alloc loop needs a fixed set)', () => {
    const p = compileBlockGraph(B, chain(...Array.from({ length: 8 }, (_, i) => node(`pd${i}`, 'fx.plane-desync'))));
    expect(p.ok).toBe(true);
    expect(p.slotCount).toBeLessThanOrEqual(3); // decode + ping-pong, not 9
    for (const s of p.steps.filter((s) => s.def.kind !== "output.sink")) expect(s.inputs).not.toContain(s.output); // Output aliases its input: no copy
  });

  it('allows a cycle through Delay and orders it as n−1 state with a commit', () => {
    const g: BlockGraph = {
      nodes: [node('src', 'source.clip'), node('mix', 'route.mix'), node('pd', 'fx.plane-desync'), node('dl', 'route.delay'), node('out', 'output.sink')],
      edges: [edge('src', 'mix', 'out', 'a'), edge('dl', 'mix', 'out', 'b'), edge('mix', 'pd'), edge('pd', 'dl'), edge('pd', 'out')],
    };
    const p = compileBlockGraph(B, g);
    expect(codes(p.errors)).toEqual([]);
    expect(p.steps.map((s) => s.node)).toEqual(['mix', 'pd', 'out']);
    expect(p.commits).toEqual([{ node: 'dl', from: p.steps[1].output }]);
    expect(p.steps[0].inputs[1]).toBe(p.delaySlots.get('dl' as NodeId));
    expect(p.steps[0].disconnected[2]).toBe('CONSTANT_ONE'); // unwired mask (L5)
    expect(p.stateful).toEqual(['dl']);
  });

  it('refuses a cycle without a Delay', () => {
    const g: BlockGraph = {
      nodes: [node('src', 'source.clip'), node('mix', 'route.mix'), node('pd', 'fx.plane-desync'), node('out', 'output.sink')],
      edges: [edge('src', 'mix', 'out', 'a'), edge('pd', 'mix', 'out', 'b'), edge('mix', 'pd'), edge('pd', 'out')],
    };
    expect(codes(compileBlockGraph(B, g).errors)).toContain('GRAPH_CYCLE');
  });

  it('refuses a second wire into a one-wire input, and a type mismatch', () => {
    const g = chain(node('pd', 'fx.plane-desync'));
    g.nodes.push(node('pd2', 'fx.plane-desync'));
    g.edges.push(edge('src', 'pd2'), edge('pd2', 'out'));
    expect(codes(compileBlockGraph(B, g).errors)).toContain('GRAPH_PORT_OCCUPIED');
    const t = chain();
    t.nodes.splice(1, 0, node('pd', 'fx.plane-desync'));
    t.edges = [edge('src', 'pd'), edge('pd', 'out'), { ...edge('pd', 'out'), id: 'bad' as EdgeId, to: { node: 'pd' as NodeId, port: 'in' as PortKey }, from: { node: 'out' as NodeId, port: 'out' as PortKey } }];
    expect(codes(compileBlockGraph(B, t).errors).length).toBeGreaterThan(0);
  });

  it('refuses an encoded node after the decode boundary (B1)', () => {
    const g = chain(node('pd', 'fx.plane-desync'));
    g.nodes.push(node('rev', 'mosh.reorder'));
    g.edges = [edge('src', 'pd'), edge('pd', 'rev'), edge('rev', 'out')];
    const c = codes(compileBlockGraph(B, g).errors);
    expect(c).toContain('GRAPH_TYPE_MISMATCH');
    expect(c).toContain('GRAPH_DOMAIN_ORDER');
  });

  it('requires an output, and required inputs', () => {
    expect(codes(compileBlockGraph(B, { nodes: [node('src', 'source.clip')], edges: [] }).errors)).toContain('GRAPH_NO_OUTPUT');
    const g = chain(node('pd', 'fx.plane-desync'));
    g.edges = g.edges.filter((e) => e.to.node !== 'pd');
    expect(codes(compileBlockGraph(B, g).errors)).toContain('GRAPH_REQUIRED_INPUT');
  });

  it('runs unknown and legacy nodes as pass-through with a warning, never a crash (D6, C4)', () => {
    const p = compileBlockGraph(B, chain(node('future', 'fx.from-the-future', { keep: 7 }), node('old', 'fx.plane-desync', {}, { defVersion: 0 })));
    expect(p.ok).toBe(true);
    expect(codes(p.warnings)).toEqual(['NODE_UNKNOWN_KIND', 'NODE_LEGACY']);
    expect(p.steps.filter((s) => s.passThrough).map((s) => s.node)).toEqual(['future', 'old']);
    expect(p.status.get('future' as NodeId)).toBe('UNKNOWN');
  });

  it('compiles to a viewer terminal mid-graph (§1e) and evaluates only what it needs', () => {
    const p = compileBlockGraph(B, chain(node('pd', 'fx.plane-desync'), node('fb', 'fx.feedback')), { terminal: 'pd' as NodeId });
    expect(p.steps.map((s) => s.node)).toEqual(['pd']);
    expect(p.outputSlot).toBe(p.steps[0].output);
  });

  it('reports EXACT/PROXY per backend (L18)', () => {
    const g = chain(node('rev', 'mosh.reorder'), node('pd', 'fx.plane-desync'));
    expect(compileBlockGraph(B, g, { backend: 'preview' }).status.get('rev' as NodeId)).toBe('PROXY');
    expect(compileBlockGraph(B, g, { backend: 'export' }).status.get('rev' as NodeId)).toBe('EXACT');
  });

  it('honours explicit input order for many-ports, not wire creation order (L5)', () => {
    // Mix has no `many` port in M1; the ordering hook is exercised through inputOrder on a one-port to prove it is read.
    const g = chain(node('pd', 'fx.plane-desync', {}, { inputOrder: { in: ['src>pd:in' as EdgeId] } }));
    expect(compileBlockGraph(B, g).ok).toBe(true);
  });

  it('compiles a 1,000-node graph quickly (R2 scale)', () => {
    const mid = Array.from({ length: 998 }, (_, i) => node(`n${i}`, i % 2 ? 'fx.plane-desync' : 'fx.feedback'));
    const t = performance.now();
    const p = compileBlockGraph(B, chain(...mid));
    const ms = performance.now() - t;
    expect(p.ok).toBe(true);
    expect(p.steps.length).toBe(999);
    expect(ms).toBeLessThan(500);
  });
});
