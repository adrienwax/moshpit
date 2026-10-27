// How long one repetition of a block lasts on the timeline. Browser-safe: the UI lays out the
// arrangement with it, so its block lengths are the engine's, not just OUT − IN.
import type { Block } from '@moshpit/core';
import { compileBlockGraph } from '../graph/stage2';
import { applyBitstreamOp } from '../nodes/ops/bitstream';

const memo = new WeakMap<Block, number>();

/**
 * The block's range after the encoded ops that change its length (speed, speed ramp, hold,
 * ping-pong, stride…), applied as stage1 applies them. Speed used to be invisible to the
 * arrangement: a 200 % block still drew, played and previewed at its source length (F1).
 * Memoised per block object: edits replace the object, so a hit is always current.
 */
export function blockSpanFrames(b: Block): number {
  const hit = memo.get(b);
  if (hit !== undefined) return hit;
  let list = Array.from({ length: Math.max(0, b.out - b.in) }, (_, i) => b.in + i);
  for (const op of compileBlockGraph(b.id, b.graph).encodedOps) if (op.kind === 'map') list = applyBitstreamOp(op.op, list, op.params);
  const n = Math.max(1, list.length);
  memo.set(b, n);
  return n;
}
