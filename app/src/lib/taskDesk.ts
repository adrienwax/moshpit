import type { Block } from '@moshpit/engine';
/** A list is an order claim only for a single connected, unbranched path. */
export function isLinearGraph(block: Block) {
  const g = block.graph;
  if (g.nodes.some(n => n.kind === 'group.container')) return false;
  if (g.edges.length !== g.nodes.length - 1) return false;
  if (g.nodes.some(n => g.edges.filter(e => e.from.node === n.id).length > 1 || g.edges.filter(e => e.to.node === n.id).length > 1)) return false;
  const visited = new Set<string>();
  let n = g.nodes.find(n => !g.edges.some(e => e.to.node === n.id));
  while (n && !visited.has(n.id)) {
    visited.add(n.id);
    const edge = g.edges.find(e => e.from.node === n!.id);
    n = edge && g.nodes.find(n => n.id === edge.to.node);
  }
  return visited.size === g.nodes.length;
}

