// Phase 1.5, app side: Values are project knobs linked to params through a Map-Range; every change
// is one undo step, and removing a Value removes its links.
import { describe, expect, it } from 'vitest';
import { addBlock, addSource, addValue, appendEffect, emptyDoc, getDoc, linkValue, projectStore, removeValue, setValue, setValueLink, undo, unlinkValue, valueLinks } from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';
import { defOf } from '../src/engine';

function setup() {
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  addSource(demoProject().resources.sources[0]);
  const blockId = addBlock(getDoc().resources.sources[0].id, 0, 24, 'picture');
  appendEffect(blockId, 'route.mix');
  const node = getDoc().timeline.blocks[0].graph.nodes.find((n) => n.kind === 'route.mix')!;
  return { blockId, nodeId: node.id };
}
const mixNode = () => getDoc().timeline.blocks[0].graph.nodes.find((n) => n.kind === 'route.mix')!;

describe('project Values, app side (Phase 1.5)', () => {
  it('a new Value links to a param across its whole range by default; each change is one undo step', () => {
    const { blockId, nodeId } = setup();
    const id = addValue();
    expect(getDoc().modulators.values).toEqual([{ id, label: 'VALUE 1', value: 0.5 }]);
    linkValue(id, blockId, nodeId as never, 'mix');
    const p = defOf('route.mix')!.params.find((x) => x.key === 'mix')!;
    expect(mixNode().bindings.mix?.value).toEqual({ valueId: id, from: p.min, to: p.max, curve: 'linear' });
    setValueLink(blockId, nodeId as never, 'mix', { from: 0.2, curve: 'smooth' });
    expect(mixNode().bindings.mix?.value).toMatchObject({ from: 0.2, curve: 'smooth' });
    const steps = projectStore.get().past.length;
    setValue(id, { value: 0.9 }, 'v');
    expect(projectStore.get().past.length).toBe(steps + 1);
    undo();
    expect(getDoc().modulators.values![0].value).toBe(0.5);
    expect(valueLinks(getDoc())).toHaveLength(1);
  });

  it('unlinking keeps other bindings; removing a Value removes its links', () => {
    const { blockId, nodeId } = setup();
    const id = addValue();
    linkValue(id, blockId, nodeId as never, 'mix');
    unlinkValue(blockId, nodeId as never, 'mix');
    expect(mixNode().bindings.mix).toBeUndefined();
    linkValue(id, blockId, nodeId as never, 'mix');
    removeValue(id);
    expect(getDoc().modulators.values).toEqual([]);
    expect(mixNode().bindings.mix).toBeUndefined();
    undo();
    expect(valueLinks(getDoc())).toHaveLength(1); // one step brings the Value and its link back
  });
});
