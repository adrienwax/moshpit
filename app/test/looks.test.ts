// 3.6 / D1: your own looks. Save a container as a look in the project library; place it as a fresh
// owned copy spliced into a chain; Update master and Update from master are explicit; the library
// travels in the project file.
import { describe, expect, it } from 'vitest';
import { compileBlockGraph, type NodeId } from '@moshpit/engine';
import { parseProject, serializeProject } from '../../engine/src/project/io';
import {
  addBlock, addSource, appendEffect, collapseNodes, emptyDoc, exposeMacro, getDoc, nodesOf, placeLook, projectLooks, projectStore,
  addValue, removeLook, renameLook, restoreTo, saveLook, setParam, undo, updateFromMaster, updateMaster,
} from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';
import { RECIPES, applyRecipe } from '../src/state/recipes';
import { inlineContainers } from '@moshpit/engine';

function setup() {
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  addSource(demoProject().resources.sources[0]);
  const src = getDoc().resources.sources[0].id;
  const a = addBlock(src, 0, 24, 'picture'), b = addBlock(src, 24, 48, 'picture');
  appendEffect(a, 'fx.chroma-drift');
  appendEffect(a, 'fx.posterize');
  const g = getDoc().timeline.blocks[0].graph;
  const pick = g.nodes.filter((n) => n.kind === 'fx.chroma-drift' || n.kind === 'fx.posterize').map((n) => n.id);
  const c = collapseNodes(a, pick, 'Grit');
  const post = g.nodes.find((n) => n.kind === 'fx.posterize')!.id;
  return { a, b, c, post };
}
const blockN = (i: number) => getDoc().timeline.blocks[i];
const boxIn = (i: number) => blockN(i).graph.nodes.find((n) => n.kind === 'group.container')!;

describe('the look library (3.6)', () => {
  it('save → place: an owned copy with fresh ids, spliced into the chain, compiling; one undo step each', () => {
    const { a, b, c, post } = setup();
    exposeMacro(a, c, post, 'levels');
    const id = saveLook(a, c);
    expect(projectLooks(getDoc()).map((l) => [l.name, l.rev, l.body.macros.length])).toEqual([['Grit', 1, 1]]);
    expect(boxIn(0).body!.origin).toEqual({ component: id, rev: 1 });
    const placed = placeLook(b, id)!;
    const copy = boxIn(1);
    expect(copy.id).toBe(placed);
    expect(copy.body!.graph.nodes.some((n) => boxIn(0).body!.graph.nodes.some((x) => x.id === n.id))).toBe(false);
    expect(compileBlockGraph(blockN(1).id, blockN(1).graph).ok).toBe(true);
    const out = blockN(1).graph.nodes.find((n) => n.kind === 'output.sink')!;
    expect(blockN(1).graph.edges.find((e) => e.to.node === out.id)!.from.node).toBe(placed); // before Output
    undo();
    expect(blockN(1).graph.nodes.some((n) => n.kind === 'group.container')).toBe(false);
  });

  it('Update master and Update from master are explicit; turned macros keep their values', () => {
    const { a, b, c, post } = setup();
    const mkey = exposeMacro(a, c, post, 'levels');
    const id = saveLook(a, c);
    placeLook(b, id);
    const copy = boxIn(1).id as NodeId;
    setParam(b, copy, mkey, 0.25); // a turned macro on the copy
    setParam(a, boxIn(0).body!.graph.nodes.find((n) => n.kind === 'fx.chroma-drift')!.id, 'cb', 99); // an inner edit on the original
    expect(nodesOf(blockN(1)).find((n) => n.kind === 'fx.chroma-drift')!.params.cb).not.toBe(99); // copies, not links
    updateMaster(a, c);
    expect(projectLooks(getDoc())[0].rev).toBe(2);
    expect(boxIn(0).body!.origin!.rev).toBe(2);
    updateFromMaster(b, copy);
    expect(nodesOf(blockN(1)).find((n) => n.kind === 'fx.chroma-drift')!.params.cb).toBe(99);
    expect(boxIn(1).params[mkey]).toBe(0.25);
    expect(boxIn(1).body!.origin).toEqual({ component: id, rev: 2 });
  });

  it('the library is saved with the project (graph 2) and opens again', () => {
    const { a, c } = setup();
    saveLook(a, c, 'Kept');
    const text = serializeProject(getDoc());
    expect(JSON.parse(text).versions.graph).toBe(2);
    expect(parseProject(text).doc.components!.looks.map((l) => l.name)).toEqual(['Kept']);
  });

  it('a stream-only look is placed on the stream run, before the Decode', () => {
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    addSource(demoProject().resources.sources[0]);
    const src = getDoc().resources.sources[0].id;
    const a = addBlock(src, 0, 24, 'picture'), b = addBlock(src, 24, 48, 'picture');
    appendEffect(a, 'mosh.hold');
    const hold = blockN(0).graph.nodes.find((n) => n.kind === 'mosh.hold')!.id;
    const id = saveLook(a, collapseNodes(a, [hold], 'Smear'));
    const placed = placeLook(b, id)!;
    const dec = blockN(1).graph.nodes.find((n) => n.kind === 'decode.webcodecs')!;
    expect(blockN(1).graph.edges.find((e) => e.to.node === dec.id)!.from.node).toBe(placed);
    expect(compileBlockGraph(blockN(1).id, blockN(1).graph).ok).toBe(true);
  });

  it('a look that crosses the Decode (most starter looks) takes the place of the block Decode and renders (bug hunt P1)', () => {
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    addSource(demoProject().resources.sources[0]);
    const src = getDoc().resources.sources[0].id;
    const a = addBlock(src, 0, 24, 'picture'), b = addBlock(src, 24, 48, 'picture');
    applyRecipe(a, RECIPES.find((r) => r.nm === 'VHS Decay')!);
    const vhs = boxIn(0);
    expect(vhs.body!.graph.nodes.some((n) => n.kind === 'decode.webcodecs')).toBe(true); // it holds the Decode
    const id = saveLook(a, vhs.id as NodeId);
    const placed = placeLook(b, id)!;
    const g = blockN(1).graph;
    expect(compileBlockGraph(blockN(1).id, g).ok).toBe(true);
    expect(g.nodes.some((n) => n.kind === 'decode.webcodecs')).toBe(false); // the block's Decode was taken over
    expect(inlineContainers(g).graph.nodes.filter((n) => n.kind === 'decode.webcodecs')).toHaveLength(1); // one decode in all
    const src0 = g.nodes.find((n) => n.kind === 'source.clip')!, out = g.nodes.find((n) => n.kind === 'output.sink')!;
    expect(g.edges.find((e) => e.from.node === src0.id)!.to.node).toBe(placed);
    expect(g.edges.find((e) => e.to.node === out.id)!.from.node).toBe(placed);
  });

  it('History restore to a point before your looks and Values existed takes them out; undo brings them back', () => {
    const { a, c } = setup();
    const at = projectStore.get().past.length; // the next entry is the first that adds them
    addValue();
    saveLook(a, c);
    expect([projectLooks(getDoc()).length, getDoc().modulators.values?.length]).toEqual([1, 1]);
    restoreTo(at);
    expect(getDoc().components).toBeUndefined(); // gone, not merged over
    expect(getDoc().modulators.values ?? []).toHaveLength(0);
    undo();
    expect(projectLooks(getDoc()).length).toBe(1);
  });

  it('the library: re-saving overwrites, a taken name gets the next free one, rename, remove (copies stay)', () => {
    const { a, b, c } = setup();
    const id = saveLook(a, c);
    expect(saveLook(a, c)).toBe(id); // the same container again: overwrite, not a duplicate
    expect(projectLooks(getDoc()).map((l) => [l.name, l.rev])).toEqual([['Grit', 2]]);
    const g = blockN(1).graph;
    appendEffect(b, 'fx.invert');
    const inv = getDoc().timeline.blocks[1].graph.nodes.find((n) => n.kind === 'fx.invert')!.id;
    const c2 = collapseNodes(b, [inv], 'Grit');
    const id2 = saveLook(b, c2);
    expect(projectLooks(getDoc()).map((l) => l.name)).toEqual(['Grit', 'Grit 2']);
    renameLook(id2, 'Grit'); // taken: stays unique
    expect(projectLooks(getDoc()).find((l) => l.id === id2)!.name).toBe('Grit 2');
    renameLook(id2, 'Invert look');
    expect(projectLooks(getDoc()).find((l) => l.id === id2)!.name).toBe('Invert look');
    removeLook(id);
    expect(projectLooks(getDoc()).map((l) => l.id)).toEqual([id2]);
    expect(boxIn(0).body!.origin).toBeUndefined(); // the copy stays, unlinked
    undo();
    expect(boxIn(0).body!.origin?.component).toBe(id);
    void g;
  });
});
