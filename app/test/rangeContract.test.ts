// The source-range contract (P0, external review §2): a block is an explicit [in, out) on its clip's
// conform — IN < OUT, inside the clip, never "the whole file" by default; IN/OUT are never stored
// inverted. OUT is exclusive: the last frame is reachable with out = frames.
import { describe, expect, it } from 'vitest';
import { addBlock, addSource, emptyDoc, getDoc, projectStore, setMarks, duplicateBlock, removeSource } from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';

function fresh() {
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  const demo = demoProject();
  const src = demo.resources.sources[0];
  const frames = 120;
  addSource(src, { id: 'conf-1', sourceId: src.id, frames } as never); // all addBlock reads is the length
  return { id: src.id, frames };
}

describe('source-range contract', () => {
  it('accepts a single frame and the last frame (OUT exclusive)', () => {
    const { id, frames } = fresh();
    expect(() => addBlock(id, 0, 1)).not.toThrow();
    expect(() => addBlock(id, frames - 1, frames)).not.toThrow();
    expect(getDoc().timeline.blocks.map((b) => b.out - b.in)).toEqual([1, 1]);
  });
  it('refuses IN ≥ OUT, negative IN, OUT past the clip, and non-frame values', () => {
    const { id, frames } = fresh();
    for (const [i, o] of [[5, 5], [6, 5], [-1, 4], [0, frames + 1], [0.5, 4]]) expect(() => addBlock(id, i, o), `${i}→${o}`).toThrow(/BLOCK_RANGE_INVALID|invalid/i);
    expect(getDoc().timeline.blocks).toHaveLength(0);
  });
  it('never stores an inverted IN/OUT', () => {
    const { id } = fresh();
    setMarks(id, 10, 20);
    setMarks(id, 30, 30);
    setMarks(id, 40, 35);
    expect(getDoc().resources.sources[0].marks[0]).toMatchObject({ in: 10, out: 20 });
  });
  it('duplicate copies the range and graph with fresh ids; a clip in use cannot be removed', () => {
    const { id } = fresh();
    const b = addBlock(id, 2, 12);
    const c = duplicateBlock(b)!;
    const [x, y] = getDoc().timeline.blocks;
    expect([y.id, y.in, y.out]).toEqual([c, 2, 12]);
    expect(y.graph.nodes.map((n) => n.id).some((n) => x.graph.nodes.some((m) => m.id === n))).toBe(false);
    expect(removeSource(id)).toBe(false);
  });
});
