// F1 (UX round 2): trimBlock keeps a block inside its clip with IN < OUT, makes a drag one undo
// step, and does nothing when nothing changes.
import { describe, expect, it } from 'vitest';
import { addBlock, addSource, emptyDoc, getDoc, projectStore, trimBlock, undo } from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';

function fresh() {
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  const src = demoProject().resources.sources[0];
  addSource(src, { id: 'conf-1', sourceId: src.id, frames: 120 } as never);
  const id = addBlock(src.id, 20, 80);
  return { id, blk: () => getDoc().timeline.blocks.find((b) => b.id === id)! };
}

describe('trimBlock (F1)', () => {
  it('moves IN / OUT inside the clip, never past each other', () => {
    const { id, blk } = fresh();
    trimBlock(id, { out: 500 });
    expect(blk().out).toBe(120);
    trimBlock(id, { in: -9 });
    expect(blk().in).toBe(0);
    trimBlock(id, { in: 200 });
    expect([blk().in, blk().out]).toEqual([119, 120]);
    trimBlock(id, { out: 0 });
    expect([blk().in, blk().out]).toEqual([119, 120]);
  });

  it('a drag (a burst of trims) is one undo step; an unchanged trim adds none', () => {
    const { id, blk } = fresh();
    const steps = projectStore.get().past.length;
    for (const out of [75, 70, 65, 60]) trimBlock(id, { out });
    expect(projectStore.get().past.length).toBe(steps + 1);
    trimBlock(id, { out: 60 });
    expect(projectStore.get().past.length).toBe(steps + 1);
    undo();
    expect([blk().in, blk().out]).toEqual([20, 80]);
  });
});
