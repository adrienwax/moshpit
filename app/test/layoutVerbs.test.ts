import { describe, expect, it } from 'vitest';
import { branchParallel, chainNodes, getDoc, projectStore } from '../src/state/project';
import { defOf } from '../src/engine';

const label = (id: string) => defOf(getDoc().timeline.blocks[4].graph.nodes.find((n) => n.id === id)!.kind)?.label;
const wires = () => getDoc().timeline.blocks[4].graph.edges.map((e) => `${label(e.from.node)}→${label(e.to.node)}`).sort();

describe('Layout verbs on a block graph', () => {
  // Demo block 5: Clip → Hold → Feedback trail → Posterize → Output
  const start = projectStore.get();
  const node = (l: string) => getDoc().timeline.blocks[4].graph.nodes.find((n) => label(n.id) === l)!.id;

  it('Create parallel branches two serial nodes off one input and merges them with Mix', () => {
    projectStore.set(start);
    const b = getDoc().timeline.blocks[4].id;
    expect(branchParallel(b, [node('Feedback trail'), node('Posterize')])).toBe(true);
    expect(wires()).toEqual(['Clip→Hold', 'Posterize→Mix', 'Hold→Posterize', 'Hold→Feedback trail', 'Mix→Output', 'Feedback trail→Mix'].sort());
  });

  it('Create serial chains nodes left to right in one undo step', () => {
    projectStore.set(start);
    const b = getDoc().timeline.blocks[4].id;
    const before = projectStore.get().past.length;
    expect(chainNodes(b, [node('Posterize'), node('Hold'), node('Feedback trail')])).toBe(2);
    expect(projectStore.get().past.length).toBe(before + 1);
    expect(wires()).toContain('Hold→Feedback trail');
    expect(wires()).toContain('Feedback trail→Posterize');
  });
});
