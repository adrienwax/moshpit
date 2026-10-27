// E-1 (readiness audit): Source and Output are not placeable, and a block keeps its Source and
// its last Output when nodes are deleted (it used to reach GRAPH_NO_OUTPUT and a broken preview).
import { describe, expect, it } from 'vitest';
import { OUTPUT, SOURCE_CLIP, isPlaceable, NODE_DEFS } from '@moshpit/engine';
import { addNode, getDoc, projectStore, removeNodes } from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';

let at = 0;
const fresh = () => { projectStore.set({ doc: demoProject(), past: [], future: [] }); at = getDoc().timeline.blocks.findIndex((b) => b.graph.nodes.length > 2); return getDoc().timeline.blocks[at]; };
const kinds = () => getDoc().timeline.blocks[at].graph.nodes.map((n) => n.kind);

describe('graph lock (E-1)', () => {
  it('Source and Output are not placeable; effects are', () => {
    expect(isPlaceable(SOURCE_CLIP)).toBe(false);
    expect(isPlaceable(OUTPUT)).toBe(false);
    expect(NODE_DEFS.some((d) => d.category === 'Effect' && isPlaceable(d))).toBe(true);
  });

  it('addNode refuses a Source or an Output', () => {
    const b = fresh();
    expect(() => addNode(b.id, OUTPUT.kind, { x: 0, y: 0 })).toThrow();
    expect(() => addNode(b.id, SOURCE_CLIP.kind, { x: 0, y: 0 })).toThrow();
  });

  it('deleting everything keeps the Source and the Output, removes the rest, as one undo step', () => {
    const b = fresh();
    const all = b.graph.nodes.map((n) => n.id);
    expect(all.length).toBeGreaterThan(2);
    const steps = projectStore.get().past.length;
    removeNodes(b.id, all);
    expect(kinds().sort()).toEqual([OUTPUT.kind, SOURCE_CLIP.kind].sort());
    expect(projectStore.get().past.length).toBe(steps + 1);
  });

  it('deleting only the Output is a no-op (no history step)', () => {
    const b = fresh();
    const out = b.graph.nodes.find((n) => n.kind === OUTPUT.kind)!;
    const steps = projectStore.get().past.length;
    removeNodes(b.id, [out.id]);
    expect(kinds()).toContain(OUTPUT.kind);
    expect(projectStore.get().past.length).toBe(steps);
  });
});
