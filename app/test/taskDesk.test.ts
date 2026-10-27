import { expect, it } from 'vitest';
import { newBlock, newNode, newEdge } from '../../engine/src/project/build';
import { isLinearGraph } from '../src/lib/taskDesk';
import { inspectSelectedResult, openDeskDetail } from '../src/state/desk';
import { projectStore, selectBlock } from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';
import { setUi, uiStore } from '../src/state/ui';
import { readSticky, writeSticky } from '../src/state/store';
import { setSlotPlayback, slotPlayback } from '../src/state/slotPlayback';
import { DEFAULT_LAYOUTS, layoutStore } from '../src/layout/model';
import { blockStarts } from '../src/lib/timeline';
it('distinguishes a real connected chain from branches, disconnected nodes and containers', () => {
  const b = newBlock('picture', 'S' as never, 0, 90);
  expect(isLinearGraph(b)).toBe(true);
  const disconnected = structuredClone(b); disconnected.graph.nodes.push(newNode('fx.invert'));
  expect(isLinearGraph(disconnected)).toBe(false);
  const branch = structuredClone(b), dec = branch.graph.nodes.find(n => n.kind === 'decode.webcodecs')!, inv = newNode('fx.invert');
  branch.graph.nodes.push(inv); branch.graph.edges.push(newEdge(dec.id, inv.id));
  expect(isLinearGraph(branch)).toBe(false);
  const box = structuredClone(b); box.graph.nodes[0].kind = 'group.container'; expect(isLinearGraph(box)).toBe(false);
});
it('only explicit inspect pauses and retargets Edit; selection preserves clocks and source ownership', () => {
  projectStore.set({ doc: demoProject(), past: [], future: [] });
  writeSticky('program.left', 'B'); writeSticky('program.activeSide', 'right');
  setUi({ playhead: 12, playing: true, loupes: { A: { frame: 17 }, B: { frame: 49 } } });
  setSlotPlayback('B', 2);
  const doc = projectStore.get().doc; selectBlock(doc.timeline.blocks[1].id);
  expect(uiStore.get().playhead).toBe(12); expect(slotPlayback.get().rate).toBe(2);
  expect(readSticky('program.left')).toBe('B');
  inspectSelectedResult();
  expect(uiStore.get().playhead).toBe(blockStarts(doc.timeline.blocks)[1]); expect(uiStore.get().playing).toBe(false);
  expect(readSticky('program.left')).toBe('program'); expect(readSticky('program.activeSide')).toBe('left');
  expect(slotPlayback.get().rate).toBe(0); expect(uiStore.get().loupes.B.frame).toBe(49); expect(uiStore.get().loupes.A.frame).toBe(17);
  projectStore.set(s => ({ ...s, doc: { ...s.doc, timeline: { ...s.doc.timeline, blocks: [] } } }));
  const before = uiStore.get(); inspectSelectedResult(); expect(uiStore.get()).toBe(before);
});

it('reveals missing detail through existing sanitizer without resetting custom panes', () => {
  layoutStore.set({ current: { mosh: [{ id: 'custom', w: 280, stacks: [{ id: 'mine', panes: ['clips', 'library'], active: 1, f: 2 }] }, { id: 'main', stacks: [{ id: 'p', panes: ['program'], active: 0, f: 4 }] }] }, saved: [] });
  const before = uiStore.get().playhead;
  openDeskDetail('source');
  const cols = layoutStore.get().current.mosh!;
  expect(cols[0].w).toBe(280);expect(cols[0].stacks[0]).toEqual({ id: 'mine', panes: ['clips', 'library'], active: 1, f: 2 });
  const detail = cols.flatMap(c => c.stacks).find(s => s.panes.includes('detail'))!;
  expect(detail.panes[detail.active]).toBe('detail');expect(detail.collapsed).toBe(false);expect(uiStore.get().playhead).toBe(before);
});

it('requested graph detail expands centrally while the applied inspector remains resident', () => {
  layoutStore.set({ current: { mosh: structuredClone(DEFAULT_LAYOUTS.mosh) }, saved: [] });
  const clocks = uiStore.get();
  expect(layoutStore.get().current.mosh![1].stacks[2].collapsed).toBe(true);
  openDeskDetail('graph');
  const cols = layoutStore.get().current.mosh!;
  expect(cols[1].stacks[2].panes[cols[1].stacks[2].active]).toBe('detail');
  expect(cols[1].stacks[2].collapsed).toBe(false);
  expect(cols[2].stacks.map(s => s.panes)).toEqual([['effects']]);
  expect(uiStore.get()).toBe(clocks);
});
