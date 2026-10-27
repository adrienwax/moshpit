// The 7 temporal ops, ported from Moshpit 1 (src/ops.ts cfd5d8c applyImagePixelOps' history
// readers). Moshpit 1 read past frames from a hand-kept `maxTemporalBack` ring and only ever
// rendered from frame 0; here each op owns a ring of its past *inputs* under the L10 contract:
// slot = frame mod depth, filled with the first frame at every block start (S1), snapshotted by
// checkpoints, restored on seek (gpu/ops.ts HistoryNode).
//
// Samplers: t0 the current input; t1..t3 past frames the node binds per op (see `reads`).

import { historyOp, P, type GpuOp } from './spec';

const BACK = (dflt = 3, max = 20) => P('back', 'Frames back', 'int', dflt, 'How many frames back to read. Deeper costs one working-size texture per frame of depth.', { min: 1, max, step: 1, ctOrder: 2, modulatable: false });

export interface HistoryShape {
  /** Ring depth from the instance's params. */
  depth: (p: Record<string, number>) => number;
  /** Frames back each sampler t1..t3 reads, per pass. */
  reads: (p: Record<string, number>) => number[][];
}

export const TEMPORAL_OPS: (GpuOp & { history: HistoryShape })[] = [
  {
    ...historyOp('fx.plane-desync-temporal', 'Plane desync (temporal)', 'Plane', 'One or more channels lag behind, pulled from a frame N back: chromatic ghosting with real memory behind it.',
      [P('pastR', 'Past red', 'bool', true, 'On pulls red from the past frame instead of now.', { onNode: true, ctOrder: 3 }), P('pastG', 'Past green', 'bool', false, 'On pulls green from the past frame instead of now.', { onNode: true, ctOrder: 4 }), P('pastB', 'Past blue', 'bool', false, 'On pulls blue from the past frame instead of now.', { onNode: true, ctOrder: 5 }), BACK()],
      `void main(){ vec4 s = texture(t0, v); vec3 p = texture(t1, v).rgb; vec3 k = vec3(P_pastR, P_pastG, P_pastB) * clamp(P_wet, 0.0, 1.0); o = vec4(mix(s.rgb, p, k), s.a); }`, 'frames back'),
    history: { depth: (p) => p.back, reads: (p) => [[p.back]] },
  },
  {
    ...historyOp('fx.field-desync', 'Field desync', 'Plane', 'Interlace against the past: alternating rows pulled from a frame N back, the rest held in the present.',
      [P('parity', 'Odd rows', 'bool', false, 'Off: even rows pull from the past. On: odd rows do.', { onNode: true, ctOrder: 1 }), BACK(2)],
      `void main(){ vec4 s = texture(t0, v); float row = mod(floor(v.y * RES.y), 2.0); bool hit = row == (P_parity > 0.5 ? 1.0 : 0.0);
         o = hit ? vec4(WETMIX(s.rgb, texture(t1, v).rgb), s.a) : s; }`, 'frames back'),
    history: { depth: (p) => p.back, reads: (p) => [[p.back]] },
  },
  {
    ...historyOp('fx.feedback-trail', 'Feedback trail', 'Feedback', 'Blend toward a frame from N back, at a tunable strength: a smoothing trail, not noise.',
      [P('amount', 'Amount', 'float', 50, 'How much of the past frame blends in. 0 is off.', { min: 0, max: 100, unit: '%', onNode: true, ctOrder: 1 }), BACK()],
      `void main(){ vec4 s = texture(t0, v); float a = P_amount / 100.0 * clamp(P_wet, 0.0, 1.0); o = vec4(mix(s.rgb, texture(t1, v).rgb, a), s.a); }`, 'frames back'),
    history: { depth: (p) => p.back, reads: (p) => [[p.back]] },
  },
  {
    ...historyOp('fx.chroma-trail', 'Chroma trail', 'Plane', 'Each colour channel lags by a different amount, so the trail separates into colour rather than grey.',
      [P('amount', 'Amount', 'float', 60, 'How much of the lagged frames blends in. 0 is off.', { min: 0, max: 100, unit: '%', onNode: true, ctOrder: 1 }),
       BACK(2, 6), P('spread', 'Spread', 'float', 50, 'How unevenly the channels are weighted. 0 blends all three equally; 100 leans hardest on the furthest-back channel.', { min: 0, max: 100, unit: '%', onNode: true, ctOrder: 3 })],
      // Red reads back×1, green ×2, blue ×3; weights normalised so spread never turns the whole effect up.
      `void main(){ vec4 s = texture(t0, v); float a = P_amount / 100.0 * clamp(P_wet, 0.0, 1.0); float sp = P_spread / 100.0;
         vec3 raw = vec3(1.0, 1.0 + sp * 0.5, 1.0 + sp); vec3 w = min(vec3(1.0), a * raw / ((raw.x + raw.y + raw.z) / 3.0));
         vec3 p = vec3(texture(t1, v).r, texture(t2, v).g, texture(t3, v).b);
         o = vec4(mix(s.rgb, p, w), s.a); }`, 'red ×1, green ×2, blue ×3 frames back'),
    history: { depth: (p) => p.back * 3, reads: (p) => [[p.back, p.back * 2, p.back * 3]] },
  },
  {
    ...historyOp('fx.drift-trail', 'Drift trail', 'Feedback', 'Blends toward a past frame that is nudged sideways, so the trail drifts rather than sitting still.',
      [P('amount', 'Amount', 'float', 50, 'How much of the drifting past frame blends in. 0 is off.', { min: 0, max: 100, unit: '%', onNode: true, ctOrder: 1 }), BACK(),
       P('driftX', 'Drift X', 'float', 12, 'Sideways nudge applied to the past frame before blending, in 1080p pixels.', { min: -60, max: 60, unit: 'px', onNode: true, ctOrder: 3 }),
       P('driftY', 'Drift Y', 'float', 0, 'Vertical nudge, in 1080p pixels.', { min: -60, max: 60, unit: 'px', ctOrder: 4 })],
      `void main(){ vec4 s = texture(t0, v); float w = clamp(P_wet, 0.0, 1.0); vec2 q = clamp(v - PX(vec2(P_driftX, P_driftY)) * w, vec2(0.0), vec2(1.0));
         o = vec4(mix(s.rgb, texture(t1, q).rgb, P_amount / 100.0 * w), s.a); }`, 'frames back'),
    history: { depth: (p) => p.back, reads: (p) => [[p.back]] },
  },
  {
    ...historyOp('fx.breath-trail', 'Breath trail', 'Feedback', 'A feedback trail whose depth rises and falls on a slow cycle, in step across every block that uses it.',
      [P('amount', 'Amount', 'float', 70, 'Trail depth at the top of the breath. 0 is off.', { min: 0, max: 100, unit: '%', onNode: true, ctOrder: 1 }), BACK(),
       P('period', 'Period', 'float', 150, 'Frames per full breath.', { min: 4, max: 600, unit: 'f', onNode: true, ctOrder: 3 }),
       P('floor', 'Floor', 'float', 0, 'Depth at the bottom of the breath, as a share of amount. 0 fades the trail away completely each cycle.', { min: 0, max: 100, unit: '%', ctOrder: 4 })],
      // The phase reads the timeline frame, so two blocks with this op breathe in step across the cut (L8).
      `void main(){ vec4 s = texture(t0, v); float ph = (1.0 - cos(6.2831853 * FRAME / max(4.0, P_period))) / 2.0;
         float a = P_amount / 100.0 * (P_floor / 100.0 + (1.0 - P_floor / 100.0) * ph) * clamp(P_wet, 0.0, 1.0);
         o = vec4(mix(s.rgb, texture(t1, v).rgb, a), s.a); }`, 'frames back'),
    history: { depth: (p) => p.back, reads: (p) => [[p.back]] },
  },
  {
    ...historyOp('fx.echo-taps', 'Echo taps', 'Feedback', 'Several past frames at falling weight: distinct ghosts rather than one smear.',
      [P('amount', 'Amount', 'float', 60, 'Weight of the first echo. Each later one is quieter. 0 is off.', { min: 0, max: 100, unit: '%', onNode: true, ctOrder: 1 }),
       P('taps', 'Taps', 'int', 3, 'How many echoes. Each costs another read of a past frame.', { min: 1, max: 4, step: 1, onNode: true, ctOrder: 2, modulatable: false }),
       P('spacing', 'Spacing', 'int', 4, 'Frames between echoes. The furthest read is taps × spacing frames back.', { min: 1, max: 12, step: 1, unit: 'f', ctOrder: 3, modulatable: false }),
       P('decay', 'Decay', 'float', 60, 'How much of the previous echo\'s weight each further one keeps. Lower separates them harder.', { min: 10, max: 95, unit: '%', ctOrder: 4 })],
      // One pass per tap, each blending over the last result (gpu/ops.ts sets u[11] to the tap's weight).
      `void main(){ vec4 s = texture(t0, v); o = vec4(mix(s.rgb, texture(t1, v).rgb, u[11]), s.a); }`, 'taps × spacing frames back'),
    history: { depth: (p) => p.taps * p.spacing, reads: (p) => Array.from({ length: p.taps }, (_, k) => [(k + 1) * p.spacing]) },
  },
];

const HISTORY = new Map<string, HistoryShape>(TEMPORAL_OPS.map((o) => [o.def.kind as string, o.history]));
/**
 * R-2: the working-size textures a history op really holds for these params: its ring, plus a
 * pass target when it reads in several passes (echo taps). Undefined for any other kind. The
 * def's `stateFrames: 20` is a ceiling for checkpoints, not this: echo taps reaches 4 × 12 = 48.
 */
export function historyFrames(kind: string, p: Record<string, number>): number | undefined {
  const h = HISTORY.get(kind);
  return h && Math.max(1, Math.round(h.depth(p))) + (h.reads(p).length > 1 ? 1 : 0);
}
