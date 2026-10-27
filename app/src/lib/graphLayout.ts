// "Organise" (radial Layout · N): left-to-right layered layout. Each node's column is its
// longest path from a source; nodes in a column stack in their current vertical order.
// Edges out of a Delay (the feedback wire) are ignored for layering, so the one legal cycle cannot loop forever.
export interface LayoutNode { id: string; x: number; y: number; isDelay?: boolean }
export interface LayoutEdge { from: string; to: string }

export function organise(nodes: LayoutNode[], edges: LayoutEdge[], colW = 230, rowH = 150): { id: string; x: number; y: number }[] {
  const delay = new Set(nodes.filter((n) => n.isDelay).map((n) => n.id));
  const preds = new Map(nodes.map((n) => [n.id, edges.filter((e) => e.to === n.id && !delay.has(e.from)).map((e) => e.from)]));
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (visiting.has(id)) return 0; // cycle without a Delay: invalid graph, lay it out anyway
    visiting.add(id);
    const d = Math.max(-1, ...(preds.get(id) ?? []).map(depth)) + 1;
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  nodes.forEach((n) => depth(n.id));
  const cols = new Map<number, LayoutNode[]>();
  nodes.forEach((n) => cols.set(layer.get(n.id)!, [...(cols.get(layer.get(n.id)!) ?? []), n]));
  const tallest = Math.max(...[...cols.values()].map((c) => c.length));
  return [...cols.entries()].flatMap(([col, ns]) =>
    ns.sort((a, b) => a.y - b.y).map((n, i) => ({ id: n.id, x: col * colW, y: (i - (ns.length - 1) / 2) * rowH + ((tallest - 1) / 2) * rowH })),
  );
}
