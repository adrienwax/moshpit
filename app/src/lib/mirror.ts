// The M5 audio mirror as the UI sees it: which of the three sends each block switches on, and how
// hard. Same rule as the engine's lanesFor() (engine/src/audio/mirror.ts; app/test/mirror.test.ts
// holds the two together): a motion block is itself a mosh (Bitstream); every non-bypassed node's
// family counts; mute or a 0 amount switches the block off.
import type { Block, EffectFamily } from '@moshpit/engine';
import { defOf } from '../engine';

export type Send = 'gate' | 'crush' | 'filter';
export const SENDS: { send: Send; family: EffectFamily; label: string; does: string }[] = [
  { send: 'gate', family: 'Bitstream', label: 'Gate / stutter', does: 'Buffer-repeat stutter on a 16th-note grid — every motion block and every Bitstream op' },
  { send: 'crush', family: 'Degrade', label: 'Bitcrusher', does: 'Bit-depth and sample-rate crush — Degrade ops' },
  { send: 'filter', family: 'Tone', label: 'Filter sweep', does: 'Swept resonant filter — Tone ops' },
];
const FAMILY_SEND: Partial<Record<EffectFamily, Send>> = { Bitstream: 'gate', Degrade: 'crush', Tone: 'filter' };

/** The block's mirror amount, 0..1 (default 1). */
export const mirrorAmount = (b: Block) => Math.max(0, Math.min(1, b.audio.mirror ?? 1));

export function blockSends(b: Block): Send[] {
  if (b.audio.mute || mirrorAmount(b) === 0) return [];
  const fams = new Set<EffectFamily>();
  if (b.kind === 'motion') fams.add('Bitstream');
  for (const n of b.graph.nodes) {
    const f = defOf(n.kind)?.family;
    if (f && !n.bypass) fams.add(f);
  }
  return SENDS.map((s) => s.send).filter((s) => [...fams].some((f) => FAMILY_SEND[f] === s));
}
