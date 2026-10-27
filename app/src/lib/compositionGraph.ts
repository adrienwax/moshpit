import type { Block, BlockId } from '@moshpit/engine';
import { blockFrames } from './timeline';

// Qualified view IDs only: persisted graph IDs and geometry never change for this projection.
export const compositionId = (blockId: string, kind: 'group' | 'node' | 'edge' | 'join', local = '') => `composition:${encodeURIComponent(JSON.stringify([blockId, kind, local]))}`;

export function compositionProjection(blocks: readonly Block[]) {
  let y = 0, start = 0;
  return blocks.map((block, index) => {
    const xs = block.graph.nodes.map(n => n.position.x), ys = block.graph.nodes.map(n => n.position.y);
    const minX = xs.length ? Math.min(...xs) : 0, minY = ys.length ? Math.min(...ys) : 0;
    const width = Math.max(740, (xs.length ? Math.max(...xs) : 0) - minX + 310);
    // Enough for the largest container face and labels; source coordinates stay untouched.
    const height = Math.max(380, (ys.length ? Math.max(...ys) : 0) - minY + 380);
    const frames = blockFrames(block);
    const row = { block, index, id: compositionId(block.id, 'group'), position: { x: 110, y },
      width, height, offset: { x: 36 - minX, y: 95 - minY }, start, frames,
      previous: index ? blocks[index - 1].id : undefined };
    y += height + 70;
    start += frames;
    return row;
  });
}

/** Resolve a command against the current sequence, never a stale render-time array index. */
export function compositionMove(blocks: readonly Block[], id: BlockId, delta: -1 | 1): { from: number; to: number } | null {
  const from = blocks.findIndex(b => b.id === id), to = from + delta;
  if (from < 0 || to < 0 || to >= blocks.length) return null;
  const next = [...blocks];
  const [block] = next.splice(from, 1);
  next.splice(to, 0, block);
  if (next[0]?.kind !== 'picture') return null;
  return { from, to };
}
