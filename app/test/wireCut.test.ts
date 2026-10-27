import { describe, expect, it, vi } from 'vitest';
import { CutStroke, crosses, readCutWires } from '../src/ws/node/wireCut';
import { addBlock, addSource, appendEffect, collapseNodes, emptyDoc, getDoc, projectStore, redo, removeEdges, undo } from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';

describe('wire-cut stroke', () => {
  it('treats hand jitter as a click without reading paths or collecting hits', () => {
    const read = vi.fn(() => []);
    const stroke = new CutStroke({ x: 100, y: 100 }, read);
    stroke.move({ x: 104, y: 103 });
    stroke.move({ x: 99, y: 101 });
    expect(stroke.dragging).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect([...stroke.hits]).toEqual([]);
  });
  it('catches fast moves across several wires and returning to the start never becomes a click', () => {
    const read = vi.fn(() => [20, 40].map((x) => ({ id: String(x), points: [{ x, y: -20 }, { x, y: 20 }] })));
    const stroke = new CutStroke({ x: 0, y: 0 }, read);
    stroke.move({ x: 60, y: 0 });
    stroke.move({ x: 0, y: 0 });
    expect(stroke.dragging).toBe(true);
    expect([...stroke.hits]).toEqual(['20', '40']);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('does not treat a wire elsewhere on the same infinite line as intersected', () => {
    expect(crosses({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 })).toBe(false);
    expect(crosses({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 3 }, { x: 5, y: 20 })).toBe(true);
    expect(crosses({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 4 }, { x: 5, y: 20 })).toBe(false);
  });
  it('follows the drawn curved wire, not its endpoint chord', () => {
    const stroke = new CutStroke({ x: 40, y: 35 }, () => [{ id: 'curve', points: [{ x: 0, y: 0 }, { x: 50, y: 40 }, { x: 100, y: 0 }] }]);
    stroke.move({ x: 60, y: 35 });
    expect([...stroke.hits]).toEqual(['curve']);
  });
  it('samples screen-transformed SVG paths and excludes modulation/other-scope edges', () => {
    const path = (id: string) => ({
      closest: () => ({ getAttribute: () => id }),
      getScreenCTM: () => ({ a: 2, b: 0, c: 0, d: 2, e: 100, f: 50 }),
      getTotalLength: () => 10,
      getPointAtLength: (x: number) => ({ x, y: 5 }),
    });
    const root = { querySelectorAll: () => [path('wire'), path('mod:lfo'), path('other-graph')] } as unknown as HTMLElement;
    const wires = readCutWires(root, new Set(['wire']));
    expect(wires).toHaveLength(1);
    expect(wires[0].points[0]).toEqual({ x: 100, y: 60 });
    expect(wires[0].points.at(-1)).toEqual({ x: 120, y: 60 });
    expect(wires[0].points).toHaveLength(6);
  });
});

describe('cut commit uses existing graph history', () => {
  it.each([false, true])('one undo restores all cut wires, nodes stay intact (container=%s)', (inside) => {
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    addSource(demoProject().resources.sources[0]);
    const id = addBlock(getDoc().resources.sources[0].id, 0, 24, 'picture');
    appendEffect(id, 'fx.chroma-drift');
    appendEffect(id, 'fx.posterize');
    const selected = getDoc().timeline.blocks[0].graph.nodes.filter((n) => n.kind.startsWith('fx.')).map((n) => n.id);
    const container = inside ? collapseNodes(id, selected) : undefined;
    const at = container ? { blockId: id, container } : id;
    const graph = () => { const g = getDoc().timeline.blocks[0].graph; return container ? g.nodes.find((n) => n.id === container)!.body!.graph : g; };
    const before = graph();
    const outer = getDoc().timeline.blocks[0].graph.edges;
    const count = projectStore.get().past.length;
    const stroke = new CutStroke({ x: 0, y: 0 }, () => before.edges.slice(0, 2).map((e, i) => ({ id: e.id, points: [{ x: 20 + i * 20, y: -10 }, { x: 20 + i * 20, y: 10 }] })));
    stroke.move({ x: 60, y: 0 });
    expect(projectStore.get().past).toHaveLength(count); // preview/cancel never edits the project
    removeEdges(at, [...stroke.hits]);
    expect(projectStore.get().past).toHaveLength(count + 1);
    expect(graph().nodes).toBe(before.nodes);
    expect(graph().edges).toHaveLength(before.edges.length - 2);
    if (inside) expect(getDoc().timeline.blocks[0].graph.edges).toBe(outer);
    undo();
    expect(graph()).toEqual(before);
    redo();
    expect(graph().edges).toHaveLength(before.edges.length - 2);
  });
});
