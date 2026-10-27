// The Audio Mirror pane must show exactly the sends the engine's export will apply.
import { describe, expect, it } from 'vitest';
import { lanesFor } from '../../engine/src/audio/mirror';
import { blockSends, mirrorAmount } from '../src/lib/mirror';
import { demoProject } from '../src/engine/mockProject';
import { blockFrames } from '../src/lib/timeline';

describe('audio mirror lanes: UI = engine', () => {
  it('every block switches on the same sends at the same amount', () => {
    const d = demoProject();
    d.timeline.blocks[2].audio.mute = true; // a muted block contributes nothing
    d.timeline.blocks[4].audio.mirror = 0.3; // a scaled block
    d.timeline.blocks[4].graph.nodes.push({ ...d.timeline.blocks[4].graph.nodes[1], id: 'x' as never, kind: 'fx.posterize' as never });
    let at = 0;
    const spans = d.timeline.blocks.map((b, i) => {
      const s = { blockId: b.id, kind: b.kind, start: at, end: at + blockFrames(b), repetition: 0 };
      at += blockFrames(b);
      return s;
    });
    const lanes = lanesFor(spans as never, d.timeline.blocks, d.settings.fps, 48000);
    for (const b of d.timeline.blocks) {
      const mine = blockSends(b);
      const theirs = lanes.filter((l) => spans.find((s) => s.blockId === b.id) && l.start === Math.round((spans.find((s) => s.blockId === b.id)!.start * 48000 * d.settings.fps.den) / d.settings.fps.num));
      expect(mine.sort()).toEqual([...new Set(theirs.map((l) => l.send))].sort());
      theirs.forEach((l) => expect(l.amount).toBeCloseTo(mirrorAmount(b)));
    }
  });
});
