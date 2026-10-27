// Helpers for authoring the 31 ported ops (Moshpit 1 src/ops.ts, cfd5d8c) as node definitions
// plus GPU shader specs. One shape for every op (L19): a NodeDef, and for GPU ops a shader body
// whose params are reachable by name (P_<key>) through generated #defines, so a reordered param
// list can never silently feed the wrong uniform.

import { kind, pkey, port, type EffectFamily, type NodeDef, type ParamDef } from '@moshpit/core';

export const P = (key: string, label: string, type: ParamDef['type'], dflt: ParamDef['default'], help: string, extra: Partial<ParamDef> = {}): ParamDef =>
  ({ key: pkey(key), label, type, default: dflt, help, modulatable: type === 'float', ...extra });

/** Moshpit 1's per-block wet/dry `t`, now a per-node param every image op shares. */
export const WET = P('wet', 'Wet', 'float', 1, 'How much of the effect is mixed in. 0 is the input untouched; drive it with an LFO to make the effect breathe.', { min: 0, max: 1, ctOrder: 6 });

export interface ShaderSpec {
  /** GLSL body. Params are P_<key>; also FRAME, TEXEL, RES, NOISE, and the FS_HEAD helpers. */
  glsl: string;
  /** Samplers the body reads: t0 = input, t1..t3 per node kind. */
  inputs: number;
}

export interface GpuOp {
  def: NodeDef;
  shader?: ShaderSpec;
}

const IN = { key: port('in'), label: 'Frame', type: 'VideoFrame' as const, cardinality: 'required-one' as const };
const OUT = { key: port('out'), label: 'Frame', type: 'VideoFrame' as const };
const STATELESS = { mode: 'stateless', lookBehind: 0, lookAhead: 0, seekPolicy: 'none', initialState: 'none', boundary: 'reset' } as const;

/** A stateless frame effect. */
export function imageOp(k: string, label: string, family: EffectFamily, blurb: string, params: ParamDef[], glsl: string, extra: Partial<NodeDef> = {}): GpuOp {
  const def: NodeDef = {
    kind: kind(k), defVersion: 1, shaderVersion: 1, label, blurb, category: 'Effect', family, domain: 'GPU_FRAME',
    inputs: [IN], outputs: [OUT], params: [...params, WET], temporal: STATELESS, impl: { preview: 'EXACT', export: 'EXACT' },
    determinism: { deterministic: true }, resources: { workingTextures: 1, stateFrames: 0 }, failure: { codes: [], onUnavailable: 'pass-through' }, freezable: true, ...extra,
  };
  return { def, shader: { glsl, inputs: 1 } };
}

/** A temporal effect that reads past inputs from a ring (L10: checkpoint + replay). */
export function historyOp(k: string, label: string, family: EffectFamily, blurb: string, params: ParamDef[], glsl: string, depthNote: string): GpuOp {
  const op = imageOp(k, label, family, blurb, params, glsl, {
    temporal: { mode: 'past-dependent', lookBehind: 20, lookAhead: 0, seekPolicy: 'checkpoint+replay', initialState: `frames before the block's first frame read as that first frame (${depthNote})`, boundary: 'carry-optional' },
    resources: { workingTextures: 1, stateFrames: 20 },
  });
  return op;
}

/** `#define P_<key> u[i]` for each param, in definition order: the uniform layout of L19's contract. */
export function paramDefines(def: NodeDef): string {
  return def.params.slice(0, 12).map((p, i) => `#define P_${p.key} u[${i}]`).join('\n') +
    '\n#define NOISE u[12]\n#define FRAME u[13]\n#define TEXEL vec2(u[14], u[15])\n#define RES vec2(1.0 / u[14], 1.0 / u[15])\n' +
    // 1080p-pixel units → uv: a shift of N px moves the same fraction of the frame at any size (L1).
    '#define PX(n) ((n) / vec2(1920.0, 1080.0))\n#define WETMIX(src, fx) mix((src), (fx), clamp(P_wet, 0.0, 1.0))\n';
}
