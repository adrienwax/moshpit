import { beforeEach, describe, expect, it } from 'vitest';
import type { BlockId, NodeId } from '@moshpit/engine';
import { compositionId, compositionMove, compositionProjection } from '../src/lib/compositionGraph';
import { demoProject } from '../src/engine/mockProject';
import { addBlock, addSource, appendEffect, emptyDoc, getDoc, projectStore, redo, setBlock, setParam, undo } from '../src/state/project';
import { moveCompositionBlock, selectCompositionNode, setCompositionJoin } from '../src/ws/node/CompositionCanvas';
import { openContainer, uiStore } from '../src/state/ui';
import { discover } from '../../engine/src/control/discovery';

function setup() {
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  addSource(demoProject().resources.sources[0]);
  const source = getDoc().resources.sources[0].id;
  const a = addBlock(source, 0, 24, 'picture'), b = addBlock(source, 24, 48, 'motion'), c = addBlock(source, 48, 72, 'picture');
  return { a, b, c };
}
beforeEach(() => setup());

describe('composition projection', () => {
  it('shows each block and every node without editing graph or timeline data', () => {
    const blocks = getDoc().timeline.blocks, before = JSON.stringify(blocks);
    const rows = compositionProjection(blocks);
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.start)).toEqual([0, 24, 48]);
    expect(rows[1].previous).toBe(blocks[0].id);
    expect(rows[0].previous).toBeUndefined();
    expect(JSON.stringify(blocks)).toBe(before);
    expect(rows[1].position.y).toBeGreaterThan(rows[0].height);
  });
  it('qualifies repeated node IDs and separator-like IDs without collisions', () => {
    expect(new Set([compositionId('a', 'node', 'b/c'), compositionId('a/b', 'node', 'c'), compositionId('a', 'edge', 'sequence'), compositionId('a', 'join'), compositionId('a', 'group')]).size).toBe(5);
    expect(compositionId('a"\\', 'node', 'b/c')).not.toMatch(/["\\]/);
  });
  it('fits a translated chain without copying its empty canvas margins', () => {
    const blocks = structuredClone(getDoc().timeline.blocks), before = compositionProjection(blocks);
    for (const block of blocks) for (const node of block.graph.nodes) {
      node.position.x += 5000; node.position.y += 7000;
    }
    const shifted = compositionProjection(blocks);
    expect(shifted.map(r => [r.width, r.height])).toEqual(before.map(r => [r.width, r.height]));
    expect(shifted[0].offset.x).toBe(before[0].offset.x - 5000);
    expect(shifted[0].offset.y).toBe(before[0].offset.y - 7000);
  });
  it('uses encoded operation lengths and repeats, retaining source geometry', () => {
    const block = getDoc().timeline.blocks[0];
    appendEffect(block.id, 'mosh.speed', { rate: 50 });
    setBlock(block.id, { repeat: 3 }, 'repeat');
    const row = compositionProjection(getDoc().timeline.blocks)[0];
    expect(row.frames).toBe(144);
    expect(row.block.graph.nodes[0].position).toEqual(block.graph.nodes[0].position);
    expect(compositionProjection(getDoc().timeline.blocks)[1].start).toBe(144);
  });
  it('resolves current block order and refuses missing, out of bounds, or first-motion moves', () => {
    const { a, b, c } = setup(), blocks = getDoc().timeline.blocks;
    expect(compositionMove(blocks, b, -1)).toBeNull();
    expect(compositionMove(blocks, a, 1)).toBeNull();
    expect(compositionMove(blocks, c, 1)).toBeNull();
    expect(compositionMove(blocks, 'deleted' as BlockId, 1)).toBeNull();
    expect(compositionMove([blocks[0], blocks[2], blocks[1]], c, -1)).toEqual({ from: 1, to: 0 });
  });
});

describe('composition actions', () => {
  it('edits the incoming join only, preserving duration and providing undo and redo', () => {
    const { a, b } = setup(), before = structuredClone(getDoc().timeline);
    setCompositionJoin(b, 'picture');
    expect(getDoc().timeline.blocks[1].kind).toBe('picture');
    expect(getDoc().timeline.blocks[0]).toEqual(before.blocks[0]);
    expect(compositionProjection(getDoc().timeline.blocks).map(r => r.frames)).toEqual([24, 24, 24]);
    undo(); expect(getDoc().timeline).toEqual(before);
    redo(); expect(getDoc().timeline.blocks[1].kind).toBe('picture');
    const past = projectStore.get().past.length;
    setCompositionJoin(a, 'motion'); setCompositionJoin('deleted' as BlockId, 'motion');
    expect(projectStore.get().past).toHaveLength(past);
    expect(getDoc().timeline.blocks[0].kind).toBe('picture');
  });
  it('reorders by stable identity with a single reversible store command', () => {
    const { a, b, c } = setup();
    expect(moveCompositionBlock(b, -1)).toBe(false);
    expect(moveCompositionBlock(c, -1)).toBe(true);
    expect(getDoc().timeline.blocks.map(b => b.id)).toEqual([a, c, b]);
    expect(moveCompositionBlock(c, -1)).toBe(true);
    expect(getDoc().timeline.blocks.map(b => b.id)).toEqual([c, a, b]);
    undo(); expect(getDoc().timeline.blocks.map(b => b.id)).toEqual([a, c, b]);
    redo(); expect(getDoc().timeline.blocks.map(b => b.id)).toEqual([c, a, b]);
  });
  it('selects an actual node on another block, clears nested scope, and exposes its CT target', () => {
    const { a, b } = setup();
    appendEffect(a, 'fx.posterize'); appendEffect(b, 'fx.chroma-trail');
    const chroma = getDoc().timeline.blocks[1].graph.nodes.find(n => n.kind === 'fx.chroma-trail')!;
    const before = JSON.stringify(getDoc().timeline), history = projectStore.get().past.length;
    openContainer(b, 'remembered-container');
    selectCompositionNode(b, chroma.id);
    expect(getDoc().view.activeBlock).toBe(b);
    expect(getDoc().view.perBlock[b].selected).toEqual([chroma.id]);
    expect(uiStore.get().opened[b]).toBeUndefined();
    const snapshot = discover(getDoc(), 1);
    expect(snapshot.slots.find(s => s.index === snapshot.selected?.slot)?.nodeId).toBe(chroma.id);
    expect(JSON.stringify(getDoc().timeline)).toBe(before);
    expect(projectStore.get().past).toHaveLength(history);
    setParam(b, chroma.id, 'spread', 17);
    expect(getDoc().timeline.blocks[1].graph.nodes.find(n => n.id === chroma.id)?.params.spread).toBe(17);
    selectCompositionNode(b, null);
    expect(discover(getDoc(), 1).selected).toBeNull();
    const view = getDoc().view;
    selectCompositionNode(a, 'unknown' as NodeId);
    expect(getDoc().view).toBe(view);
  });
});
