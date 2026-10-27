// Phase 0.2: one undo stack, and every step is what the user did. Gestures (a press) are one step
// however slow; a multi-part edit is one step; a toast's Undo undoes only its own edit; redo back
// to the saved step reads as saved; the view never points at a block an undo removed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addBlock, addSource, beginGesture, commit, emptyDoc, endGesture, getDoc, projectStore, redo, transact, trimBlock, undo, undoAction,
} from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';

function fresh() {
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  const src = demoProject().resources.sources[0];
  addSource(src, { id: 'conf-1', sourceId: src.id, frames: 300 } as never);
  const id = addBlock(src.id, 20, 200);
  return { id, steps: () => projectStore.get().past.length };
}

afterEach(() => {
  endGesture();
  vi.useRealTimers();
});

describe('undo steps (Phase 0.2)', () => {
  it('a slow drag is one step: a 2 s pause inside the gesture does not split it', () => {
    vi.useFakeTimers();
    const { id, steps } = fresh();
    const n = steps();
    beginGesture();
    trimBlock(id, { out: 190 });
    vi.advanceTimersByTime(2000); // longer than the old 1.5 s coalescing window
    trimBlock(id, { out: 150 });
    endGesture();
    expect(steps()).toBe(n + 1);
    expect(projectStore.get().past.at(-1)!.label).toMatch(/150/); // the label ends on the final value
    undo();
    expect(getDoc().timeline.blocks[0].out).toBe(200);
  });

  it('two separate drags of the same edge are two steps, even back to back', () => {
    const { id, steps } = fresh();
    const n = steps();
    beginGesture();
    trimBlock(id, { out: 190 });
    endGesture();
    beginGesture();
    trimBlock(id, { out: 180 });
    endGesture();
    expect(steps()).toBe(n + 2);
  });

  it('keyed nudges outside a gesture still coalesce for a moment', () => {
    const { id, steps } = fresh();
    const n = steps();
    trimBlock(id, { out: 199 });
    trimBlock(id, { out: 198 });
    expect(steps()).toBe(n + 1);
  });

  it('transact makes a multi-part edit (delete nodes + wires, a recipe) one step', () => {
    const { steps } = fresh();
    const n = steps();
    transact(() => {
      commit('Delete nodes', (d) => void (d.name = 'a'));
      commit('Delete wires', (d) => void (d.name = 'b'));
    });
    expect(steps()).toBe(n + 1);
    expect(projectStore.get().past.at(-1)!.label).toBe('Delete nodes');
    undo();
    expect(getDoc().name).toBe('Untitled');
  });

  it("a toast's Undo undoes its own edit, and refuses once other edits came after", () => {
    const { steps } = fresh();
    commit('Rename', (d) => void (d.name = 'mine'));
    const act = undoAction();
    commit('Other', (d) => void (d.settings.bpm = 99));
    const n = steps();
    act.run();
    expect(steps()).toBe(n); // the later edit survives
    expect(getDoc().settings.bpm).toBe(99);
    undo();
    act.run(); // now "Rename" is on top again
    expect(getDoc().name).toBe('Untitled');
  });

  it('redo back to a step restores the same entry id (the saved marker matches again)', () => {
    fresh();
    commit('Rename', (d) => void (d.name = 'saved here'));
    const id = projectStore.get().past.at(-1)!.id;
    undo();
    redo();
    expect(projectStore.get().past.at(-1)!.id).toBe(id);
  });

  it('undoing an added block clears a selection that pointed at it', () => {
    const { id } = fresh();
    expect(getDoc().view.activeBlock).toBe(id);
    undo();
    expect(getDoc().timeline.blocks.some((b) => b.id === id)).toBe(false);
    expect(getDoc().view.activeBlock).toBeUndefined();
  });
});
