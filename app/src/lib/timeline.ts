import type { Block } from '@moshpit/engine';
import { blockSpanFrames } from '@moshpit/engine';

/** A block on the arrangement: its range after length-changing ops (speed, hold…), × repeat, as the engine lays it out. */
export const blockFrames = (b: Block) => blockSpanFrames(b) * Math.max(1, Math.round(b.repeat));

export const timelineFrames = (blocks: Block[]) => blocks.reduce((a, b) => a + blockFrames(b), 0);

/** Timeline frame where each block starts. */
export function blockStarts(blocks: Block[]): number[] {
  let acc = 0;
  return blocks.map((b) => {
    const s = acc;
    acc += blockFrames(b);
    return s;
  });
}

export function blockAt(blocks: Block[], frame: number): { block: Block; index: number; local: number } | null {
  let acc = 0;
  for (let i = 0; i < blocks.length; i++) {
    const len = blockFrames(blocks[i]);
    if (frame < acc + len) return { block: blocks[i], index: i, local: frame - acc };
    acc += len;
  }
  return null;
}
