// L25 + audit B2: the freeze key is a content hash of everything that can change the frozen
// pixels. Identical key ⇒ identical bytes (L11), so a hit is always correct.
//
// What B2 found missing, now in the key:
//   - upstream blocks: a motion block's pixels depend on every encoded input back to the last
//     surviving keyframe, possibly in an earlier block. Stage 1's per-frame chain keys carry
//     exactly that, so the key folds in frameKey over the frames it covers;
//   - position: LFOs read the timeline frame (L8), so the absolute range and block start enter;
//   - renderer identity: shaders are float maths on a specific GPU and driver (L30 fingerprint).

import { elideDecode } from '../graph/decode';
import { inlineContainers } from '../graph/container';
import * as crypto from 'node:crypto';
import type { Block, Lfo, ProjectValue } from '@moshpit/core';
import type { BlockPlan } from '../graph/stage2';
import type { Stage1Plan, BlockSpan } from '../timeline/stage1';
import { DEF_BY_KIND } from '../nodes/defs';
import { canonicalJSON } from '../util/determinism';

export interface ExecutionEnv {
  chrome: string;
  gpu: string;
  decode: 'prefer-software' | 'prefer-hardware' | 'no-preference';
  colour: string;
}

/** L30: which execution profile produced a render. A freeze made under one is never served under another. */
export function executionFingerprint(env: ExecutionEnv): string {
  return crypto.createHash('sha256').update(canonicalJSON(env)).digest('hex').slice(0, 16);
}

/** Everything in a block's graph that changes its output: kinds, versions, params, bindings, wiring. */
export function graphHash(block: Block, lfos: Lfo[], values: ProjectValue[] = []): string {
  // Phase 1.1: hashed without Decode nodes (they change no pixels), so drawing one keeps freezes fresh.
  // 3.2: and with containers inlined, so collapsing nodes into one (or unpacking it) keeps them fresh too.
  const graph = elideDecode(inlineContainers(block.graph).graph).graph;
  const nodes = [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : 1)).map((n) => {
    const d = DEF_BY_KIND.get(n.kind);
    return { id: n.id, kind: n.kind, v: n.defVersion, defV: d?.defVersion, shaderV: d?.shaderVersion, params: n.params, bindings: n.bindings, carry: !!n.carryState, bypass: !!n.bypass, order: n.inputOrder };
  });
  const edges = [...graph.edges].map((e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`).sort();
  const used = new Set(graph.nodes.flatMap((n) => Object.values(n.bindings ?? {}).map((b) => b.lfo?.lfoId).filter(Boolean)));
  const lfoDefs = lfos.filter((l) => used.has(l.id)).map(({ id, shape, period, unit, phase }) => ({ id, shape, period, unit, phase }));
  // LATENT GAP (Phase 1 audit), fix BEFORE any expression-editing UI ships: `used` and `usedV` only
  // collect the LFOs and Values that lfo / value BINDINGS name. An expression binding can also read
  // them by index, lfo(n) and value(n) (control/expr.ts), and those are not scanned, so editing such
  // an LFO or Value would leave a freeze looking fresh. Unreachable today: no UI or CT path writes
  // an expression binding. The fix: parse each binding's expression.source (compileExpr exposes the
  // lfo indices it reads; add the same for value) and add those ids to the sets below.
  // Phase 1.5: the Values this graph's bindings read (a Value edit re-renders, and stales freezes).
  const usedV = new Set(graph.nodes.flatMap((n) => Object.values(n.bindings ?? {}).map((b) => b.value?.valueId).filter(Boolean)));
  const valueDefs = values.filter((v) => usedV.has(v.id)).map(({ id, value }) => ({ id, value }));
  return crypto.createHash('sha256').update(canonicalJSON(valueDefs.length ? { nodes, edges, lfoDefs, valueDefs } : { nodes, edges, lfoDefs })).digest('hex');
}

export interface FreezeKeyInput {
  stage1: Stage1Plan;
  span: BlockSpan;
  plan: BlockPlan;
  graph: string;
  range: [number, number];
  seed: number;
  bpm: number;
  fingerprint: string;
  format: string;
}

export function freezeKey(k: FreezeKeyInput): string {
  const [a, b] = k.range;
  // A past-dependent graph depends on every frame since its state reset at the block start (S1).
  const from = k.plan.pastDependent ? k.span.start : a;
  const h = crypto.createHash('sha256');
  h.update(canonicalJSON({ v: 1, graph: k.graph, range: k.range, spanStart: k.span.start, seed: k.seed, bpm: k.bpm, fp: k.fingerprint, format: k.format, variant: k.stage1.variant, size: [k.stage1.width, k.stage1.height] }));
  h.update(new Uint8Array(k.stage1.frameKey.buffer, k.stage1.frameKey.byteOffset + from * 8, (b - from + 1) * 8));
  return h.digest('hex').slice(0, 32);
}
