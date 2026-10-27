// Phase 1.1: the Decode node is the visible boundary between the encoded stream and the GPU graph.
// It changes no pixels: there is one decode per block wherever it is drawn (stage1 assembles one
// stream, the runtime runs one decoder). So the compiler and the freeze key see the graph with
// every Decode removed and its wires bridged: a graph with an explicit Decode compiles and hashes
// exactly like the same graph without one, and old projects' freezes stay fresh.
import type { BlockGraph, GraphEdge, NodeId } from '@moshpit/core';
import { DECODE } from '../nodes/defs';

type PortRef = GraphEdge['from'];

export interface Elided {
  graph: BlockGraph;
  /** A Decode's id → the node feeding it (so a viewer on a Decode shows the decoded picture). */
  alias: Map<NodeId, NodeId>;
}

export function elideDecode(g: BlockGraph): Elided {
  const decs = new Set(g.nodes.filter((n) => n.kind === DECODE.kind).map((n) => n.id));
  if (!decs.size) return { graph: g, alias: new Map() };
  const feed = new Map<NodeId, GraphEdge>();
  for (const e of g.edges) if (decs.has(e.to.node)) feed.set(e.to.node, e);
  // What a Decode passes on: its input's source, through any Decode → Decode run.
  const upstream = (id: NodeId): PortRef | undefined => {
    const seen = new Set<NodeId>();
    let e = feed.get(id);
    while (e && decs.has(e.from.node) && !seen.has(e.from.node)) (seen.add(e.from.node), (e = feed.get(e.from.node)));
    return e && !decs.has(e.from.node) ? e.from : undefined;
  };
  const edges: GraphEdge[] = [];
  for (const e of g.edges) {
    if (decs.has(e.to.node)) continue;
    if (!decs.has(e.from.node)) { edges.push(e); continue; }
    const up = upstream(e.from.node);
    if (up) edges.push({ ...e, from: { ...up } }); // an unfed Decode leaves its downstream input unwired
  }
  const alias = new Map<NodeId, NodeId>();
  for (const id of decs) { const up = upstream(id); if (up) alias.set(id, up.node); }
  return { graph: { ...g, nodes: g.nodes.filter((n) => !decs.has(n.id)), edges }, alias };
}
