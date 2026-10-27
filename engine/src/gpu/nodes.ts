// GPU implementations of the node definitions (L19 is the contract; this is one backend's
// fulfilment of it). Every implementation holds its state as backend Targets and must implement
// the §6 resource contract:
//   dispose()       free every texture when evaluation leaves the node's range
//   spillToDisk()   evict state to the L13 cache under budget pressure; restoreFromDisk() back
// State is what a checkpoint snapshots: `state` lists exactly those targets, in a fixed order.
//
// Uniform convention, `u[16]`: u[0..11] the definition's params in declaration order (resolved
// per frame through the value-source chain), u[12] a seeded per-frame noise value (L11),
// u[13] the timeline frame, u[14..15] 1/width, 1/height.

import type { NodeDef } from '@moshpit/core';
import { DELAY, DEF_BY_KIND, FEEDBACK, MIX, PLANE_DESYNC, SEAM_MOSH, SWITCH } from '../nodes/defs';
import type { GL2Backend, Program, Target } from './backend';
import { Base, type GpuNode } from './base';
import { HistoryNode, ResolutionCrush, ShaderNode, SoftBlur } from './ops';
import { STATELESS_OPS, PLANE_DESYNC_GLSL } from '../nodes/ops/stateless';
import { TEMPORAL_OPS } from '../nodes/ops/temporal';
import { numericBase } from '../control/params';

export type { GpuNode };
const STATELESS = new Map(STATELESS_OPS.map((o) => [o.def.kind as string, o.shader!]));
const TEMPORAL = new Map(TEMPORAL_OPS.map((o) => [o.def.kind as string, o]));

/** Representative temporal node: recursive feedback with zoom and turn (the spike's fb shader). */
class Feedback extends Base {
  readonly def = FEEDBACK;
  private prog: Program;
  private prev: Target;
  private fresh = true;
  constructor(be: GL2Backend, w: number, h: number) {
    super(be, w, h);
    this.prev = this.own(be.target(w, h, 'rgba16f', 'fx.feedback state'));
    this.state = [this.prev];
    this.prog = be.program('fx.feedback@1', `
      void main(){
        float a = radians(u[2]), cs = cos(a), sn = sin(a), aspect = u[15] / u[14];
        vec2 p = (v - 0.5) * vec2(aspect, 1.0);
        p = mat2(cs, -sn, sn, cs) * p / vec2(aspect, 1.0);
        vec2 q = p * u[1] + 0.5;
        o = mix(texture(t0, v), texture(t1, q), u[0]);
      }`, 2);
  }
  override reset(): void { this.fresh = true; }
  render(inputs: readonly (Target | null)[], out: Target, u: Float32Array): void {
    // Declared initial state: the trail is empty, so the first frame passes through.
    if (this.fresh) { this.be.copy(inputs[0]!, out); this.fresh = false; }
    else this.be.draw(this.prog, out, u, inputs[0], this.prev);
    this.be.blit(out, this.prev);
  }
  /** A checkpoint restore brings back a real trail, so the next frame must not pass through. */
  override resumed(): void { this.fresh = false; }
}

/** L5: two inputs and an optional mask whose disconnected meaning is CONSTANT_ONE. */
/**
 * Mix's shader body. u[0] mix, u[1] mode (0 mix, 1 add, 2 screen, 3 difference, 4 multiply). Mode 0
 * is the old cross-fade exactly, mix(A, B, k) on colour and alpha alike: the golden test in
 * e2e/app.spec.ts renders this and the Mix@1 body side by side and compares the float bits.
 */
export const MIX_GLSL = `
      void main(){
        float m = u[11] > 0.5 ? dot(texture(t2, v).rgb, vec3(0.2126, 0.7152, 0.0722)) : 1.0;
        float k = clamp(u[0] * m, 0.0, 1.0);
        vec4 A = texture(t0, v), B = texture(t1, v);
        int md = int(u[1] + 0.5);
        vec3 c = md == 1 ? A.rgb + B.rgb : md == 2 ? A.rgb + B.rgb - A.rgb * B.rgb : md == 3 ? abs(A.rgb - B.rgb) : md == 4 ? A.rgb * B.rgb : B.rgb;
        o = vec4(mix(A.rgb, c, k), mix(A.a, B.a, k));
      }`;

class Mix extends Base {
  readonly def = MIX;
  private prog: Program;
  constructor(be: GL2Backend, w: number, h: number) {
    super(be, w, h);
    this.prog = be.program('route.mix@2', MIX_GLSL, 3);
  }
  render(inputs: readonly (Target | null)[], out: Target, u: Float32Array): void {
    u[11] = inputs[2] ? 1 : 0;
    this.be.draw(this.prog, out, u, inputs[0], inputs[1] ?? inputs[0], inputs[2] ?? inputs[0]);
  }
}

/** Phase 1.4: passes input round(u[0]) (0 A … 3 D); an unwired input shows A. */
class Switch extends Base {
  readonly def = SWITCH;
  private prog: Program;
  constructor(be: GL2Backend, w: number, h: number) {
    super(be, w, h);
    this.prog = be.program('route.switch@1', `
      void main(){
        int i = int(clamp(floor(u[0] + 0.5), 0.0, 3.0));
        o = i == 0 ? texture(t0, v) : i == 1 ? texture(t1, v) : i == 2 ? texture(t2, v) : texture(t3, v);
      }`, 4);
  }
  render(inputs: readonly (Target | null)[], out: Target, u: Float32Array): void {
    const a = inputs[0];
    this.be.draw(this.prog, out, u, a, inputs[1] ?? a, inputs[2] ?? a, inputs[3] ?? a);
  }
}

/**
 * The bitstream representative's PROXY (L18): over a *clean* decode, hold the last output at every
 * hold point (F1: every seam and every removed keyframe, not only the range start), otherwise add
 * the clean stream's frame-to-frame residual to it. Not the real smear — it never claims to be.
 * Timeline-scope state: one per engine, not per block, because a mosh range crosses blocks.
 */
export class SeamProxy extends Base {
  readonly def = SEAM_MOSH;
  private prog: Program;
  readonly prevOut: Target;
  readonly prevClean: Target;
  constructor(be: GL2Backend, w: number, h: number) {
    super(be, w, h);
    this.prevOut = this.own(be.target(w, h, 'rgba16f', 'seam proxy: last output'));
    this.prevClean = this.own(be.target(w, h, 'rgba16f', 'seam proxy: last clean frame'));
    this.state = [this.prevOut, this.prevClean];
    // u[0] hold, u[1] active
    this.prog = be.program('seam.mosh.proxy@2', `
      void main(){
        vec4 c = texture(t0, v), q = texture(t1, v), p = texture(t2, v);
        o = u[1] < 0.5 ? c : (u[0] > 0.5 ? p : clamp(p + (c - q), 0.0, 1.0));
      }`, 3);
  }
  /** Seed both states with the clean frame before the evaluation start. */
  prime(clean: Target): void { this.be.blit(clean, this.prevOut); this.be.blit(clean, this.prevClean); }
  render(inputs: readonly (Target | null)[], out: Target, u: Float32Array): void {
    this.be.draw(this.prog, out, u, inputs[0], this.prevClean, this.prevOut);
    this.be.blit(out, this.prevOut);
    this.be.blit(inputs[0]!, this.prevClean);
  }
}

/** Unknown, legacy and bypassed nodes: pass the first input through (D6). */
class PassThrough extends Base {
  constructor(readonly def: NodeDef, be: GL2Backend, w: number, h: number) { super(be, w, h); }
  render(inputs: readonly (Target | null)[], out: Target): void {
    const src = inputs.find((x) => x !== null);
    if (src) this.be.copy(src, out); else this.be.clear(out);
  }
}

export function createGpuNode(def: NodeDef, passThrough: boolean, be: GL2Backend, w: number, h: number, params: Record<string, unknown> = {}): GpuNode {
  if (passThrough) return new PassThrough(def, be, w, h);
  const k = def.kind as string;
  if (k === PLANE_DESYNC.kind) return new ShaderNode(def, { glsl: PLANE_DESYNC_GLSL, inputs: 1 }, be, w, h);
  if (k === FEEDBACK.kind) return new Feedback(be, w, h);
  if (k === MIX.kind) return new Mix(be, w, h);
  if (k === SWITCH.kind) return new Switch(be, w, h);
  if (k === 'fx.soft-blur') return new SoftBlur(def, STATELESS.get(k)!, be, w, h);
  if (k === 'fx.resolution-crush') return new ResolutionCrush(def, STATELESS.get(k)!, be, w, h);
  const s = STATELESS.get(k);
  if (s) return new ShaderNode(def, s, be, w, h);
  const t = TEMPORAL.get(k);
  if (t) {
    const d = DEF_BY_KIND.get(k)!, num: Record<string, number> = {};
    for (const p of d.params) num[p.key] = numericBase(p, params[p.key] as never);
    return new HistoryNode(def, t.shader!, t.history, num, be, w, h);
  }
  return new PassThrough(def, be, w, h);
}

export const isDelay = (def: NodeDef) => def.kind === DELAY.kind;
