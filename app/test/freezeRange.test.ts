import { describe, expect, it } from 'vitest';
import { Engine } from '../../engine/src/runtime/engine';
import { frameRangeOf } from '../src/components/nodes';
import { demoProject } from '../src/engine/mockProject';

// Exercise the real range/key calculation without constructing a GPU or decoding media.
function rig() {
  const block = { ...demoProject().timeline.blocks[0], in: 0, out: 24, repeat: 2, graph: { nodes: [], edges: [] } };
  const other = 'other-block';
  const spans = [{ blockId: block.id, start: 0, end: 24 }, { blockId: block.id, start: 24, end: 48 }, { blockId: other, start: 48, end: 72 }];
  const spanOf = new Int32Array(72); spans.forEach((s, i) => spanOf.fill(i, s.start, s.end));
  const engine = Object.assign(Object.create(Engine.prototype), {
    plan: { frames: 72, width: 16, height: 16, variant: 'master', blocks: spans, frameKey: new Float64Array(72).map((_, i) => i) },
    spanOf, blocksById: new Map([[block.id, block]]), fingerprint: 'test', w: 16, h: 16,
    o: { blockPlans: new Map([[block.id, { pastDependent: false }]]), lfos: [], seed: 1, bpm: 120 },
  }) as Engine;
  return { engine, block, spans };
}

describe('whole repeated block freeze ranges', () => {
  it('accepts the actual whole-block range from the arrangement helper', () => {
    const { engine, block } = rig(), range = frameRangeOf([block], block);
    expect(range).toEqual([0, 47]);
    expect(engine.freezeKeyFor(block.id, ...range)).toMatch(/^[a-f0-9]{32}$/);
    expect(engine.freezeKeyFor(block.id, 0, 23)).not.toBe(engine.freezeKeyFor(block.id, ...range));
  });
  it('accepts a partial range across two adjacent repeats', () => {
    const { engine, block } = rig();
    expect(() => engine.freezeKeyFor(block.id, 12, 35)).not.toThrow();
  });
  it('refuses a range reaching a neighbouring block', () => {
    const { engine, block } = rig();
    expect(() => engine.freezeKeyFor(block.id, 0, 48)).toThrow();
  });
  it('refuses malformed and out-of-timeline ranges', () => {
    const { engine, block } = rig();
    for (const [a, b] of [[-1, 23], [0, 72], [20, 10], [0.5, 23]]) expect(() => engine.freezeKeyFor(block.id, a, b)).toThrow();
  });
  it('refuses discontiguous spans even with matching block ids', () => {
    const { engine, block, spans } = rig();
    spans[1].start = 25;
    expect(() => engine.freezeKeyFor(block.id, 0, 47)).toThrow();
  });
});
