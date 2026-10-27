// Checkpoint 1, A-4: undo history is copy-on-write. An edit copies only the objects on its path; the
// rest is shared with the previous doc and every snapshot, and every store doc is frozen, so sharing
// can never let one snapshot change another. Undo and redo behave exactly as before (history.test.ts).
import { describe, expect, it, vi } from 'vitest';
import {
  addBlock, addNode, addSource, commit, duplicateBlock, emptyDoc, getDoc, moveBlock, projectStore, redo, removeNodes, restoreTo, transact, undo,
} from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';
import { freeze } from 'immer';

function fresh() {
  projectStore.set({ doc: freeze(emptyDoc(), true), past: [], future: [] });
  const src = demoProject().resources.sources[0];
  addSource(src, { id: 'conf-1', sourceId: src.id, frames: 300 } as never);
  return [addBlock(src.id, 0, 50), addBlock(src.id, 50, 100), addBlock(src.id, 100, 150)];
}
const json = () => JSON.stringify(getDoc(), (k, v) => (k === 'view' ? undefined : v));

describe('copy-on-write history (A-4)', () => {
  it('an edit to one block shares every other block with the doc before it, and with history', () => {
    const [a, b, c] = fresh();
    const before = getDoc();
    addNode(a, 'fx.invert', { x: 0, y: 0 });
    const after = getDoc();
    const blk = (d: typeof after, id: string) => d.timeline.blocks.find((x) => x.id === id)!;
    expect(blk(after, a)).not.toBe(blk(before, a));
    expect(blk(after, b)).toBe(blk(before, b));
    expect(blk(after, c)).toBe(blk(before, c));
    expect(after.resources).toBe(before.resources);
    expect(projectStore.get().past.at(-1)!.before).toBe(before);
  });

  it('a commit no longer clones the whole document', () => {
    fresh();
    const spy = vi.spyOn(globalThis, 'structuredClone');
    commit('Rename', (d) => void (d.name = 'x'));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('structural edits undo and redo to exactly the documents they made', () => {
    const [a, b] = fresh();
    const seen = [json()];
    const step = (fn: () => void) => (fn(), seen.push(json()));
    step(() => duplicateBlock(b));
    step(() => moveBlock(2, 1)); // a reorder that keeps the picture block first (moving it away is refused: bug hunt P1)
    let n = '';
    step(() => void (n = addNode(a, 'fx.invert', { x: 10, y: 0 })));
    step(() => addNode(a, 'fx.posterize', { x: 20, y: 0 }));
    step(() => transact(() => { removeNodes(a, [n]); commit('Rename', (d) => void (d.name = 'renamed')); }));
    for (let i = seen.length - 2; i >= 0; i--) { undo(); expect(json()).toBe(seen[i]); }
    for (let i = 1; i < seen.length; i++) { redo(); expect(json()).toBe(seen[i]); }
  });

  it('every doc in the store, current and history, is frozen: a stray mutation throws', () => {
    const [a] = fresh();
    addNode(a, 'fx.invert', { x: 0, y: 0 });
    expect(() => { (getDoc().timeline.blocks as unknown[]).push({}); }).toThrow(TypeError);
    const snap = projectStore.get().past.at(-1)!.before;
    expect(() => { (snap.timeline.blocks[0].graph.nodes as unknown[]).length = 0; }).toThrow(TypeError);
    expect(Object.isFrozen(getDoc().timeline.blocks[0].graph.nodes[0].params)).toBe(true);
  });

  it('restore to a history entry shares its snapshot, and is itself undoable', () => {
    const [a] = fresh();
    const target = json();
    const i = projectStore.get().past.length;
    addNode(a, 'fx.invert', { x: 0, y: 0 });
    commit('Rename', (d) => void (d.name = 'later'));
    restoreTo(i);
    expect(json()).toBe(target);
    undo();
    expect(getDoc().name).toBe('later');
  });

  it('a mutate that returns a value still commits (the draft edit wins, nothing throws)', () => {
    fresh();
    commit('Rename', (d) => (d.name = 'returned') as never);
    expect(getDoc().name).toBe('returned');
  });
});
