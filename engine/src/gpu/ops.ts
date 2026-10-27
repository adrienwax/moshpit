// GPU implementations for the ported op table (nodes/ops/*). One generic single-pass ShaderNode
// covers most of them; soft blur and resolution crush need two passes; the temporal family shares
// HistoryNode. All inherit the §6 contract (dispose / spillToDisk / restoreFromDisk) from Base.

import { MoshpitError } from '../errors';
import type { NodeDef } from '@moshpit/core';
import type { GL2Backend, Program, Target } from './backend';
import { Base } from './base';
import { paramDefines, type ShaderSpec } from '../nodes/ops/spec';
import type { HistoryShape } from '../nodes/ops/temporal';

const prog = (be: GL2Backend, def: NodeDef, s: ShaderSpec, inputs = s.inputs) => be.program(`${def.kind}@${def.shaderVersion ?? 1}`, `${paramDefines(def)}\n${s.glsl}`, inputs);

export class ShaderNode extends Base {
  private prog: Program;
  constructor(readonly def: NodeDef, spec: ShaderSpec, be: GL2Backend, w: number, h: number) {
    super(be, w, h);
    this.prog = prog(be, def, spec);
  }
  render(inputs: readonly (Target | null)[], out: Target, u: Float32Array): void { this.be.draw(this.prog, out, u, inputs[0]); }
}

/** Separable box blur: horizontal into a scratch target, then vertical with the wet mix against the input. */
export class SoftBlur extends Base {
  private prog: Program;
  private tmp: Target;
  constructor(readonly def: NodeDef, spec: ShaderSpec, be: GL2Backend, w: number, h: number) {
    super(be, w, h);
    this.prog = prog(be, def, spec, 3);
    this.tmp = this.own(be.target(w, h, 'rgba16f', `${def.kind} scratch`));
  }
  render(inputs: readonly (Target | null)[], out: Target, u: Float32Array): void {
    u[11] = 0; this.be.draw(this.prog, this.tmp, u, inputs[0], null, inputs[0]);
    u[11] = 1; this.be.draw(this.prog, out, u, this.tmp, null, inputs[0]);
  }
}

/** Block averages into a target `factor` times smaller (one texel fetch per source pixel overall), then reconstruct. */
export class ResolutionCrush extends Base {
  private avg: Program;
  private recon: Program;
  private small: Target | null = null;
  private factor = 0;
  constructor(readonly def: NodeDef, spec: ShaderSpec, be: GL2Backend, w: number, h: number) {
    super(be, w, h);
    this.recon = prog(be, def, spec, 2);
    this.avg = be.program('fx.resolution-crush.average@1', `
      void main(){ int f = int(u[11]); ivec2 base = ivec2(floor(gl_FragCoord.xy)) * f; ivec2 sz = textureSize(t0, 0);
        vec3 acc = vec3(0.0); float n = 0.0;
        for (int y = 0; y < 32; y++) { if (y >= f) break; for (int x = 0; x < 32; x++) { if (x >= f) break;
          ivec2 p = base + ivec2(x, y); if (p.x < sz.x && p.y < sz.y) { acc += texelFetch(t0, p, 0).rgb; n += 1.0; } } }
        o = vec4(acc / max(n, 1.0), 1.0); }`, 1);
  }
  render(inputs: readonly (Target | null)[], out: Target, u: Float32Array): void {
    const f = Math.max(2, Math.min(32, Math.round(u[0])));
    if (f !== this.factor) { // a resize only when the factor changes, never per frame
      if (this.small) { this.be.release(this.small); this.owned = this.owned.filter((t) => t !== this.small); }
      this.small = this.own(this.be.target(Math.ceil(this.w / f), Math.ceil(this.h / f), 'rgba16f', `${this.def.kind} blocks`));
      this.factor = f;
    }
    const keep = u[11]; u[11] = f;
    this.be.draw(this.avg, this.small!, u, inputs[0]);
    u[11] = keep;
    this.be.draw(this.recon, out, u, inputs[0], this.small);
  }
}

/**
 * The temporal family's ring of past inputs (L10). Slot for frame t is t mod depth, so the ring's
 * layout is a pure function of the timeline frame and a checkpoint needs only the slot textures.
 * At a block start (reset) every slot is filled with the first frame: the declared initial state.
 */
export class HistoryNode extends Base {
  private prog: Program;
  private ring: Target[] = [];
  private reads: number[][];
  private fresh = true;
  private scratch: Target | null = null;
  constructor(readonly def: NodeDef, spec: ShaderSpec, shape: HistoryShape, params: Record<string, number>, be: GL2Backend, w: number, h: number) {
    super(be, w, h);
    this.prog = prog(be, def, spec, 4);
    const depth = Math.max(1, Math.round(shape.depth(params)));
    this.reads = shape.reads(params);
    try {
      for (let i = 0; i < depth; i++) this.ring.push(this.own(be.target(w, h, 'rgba16f', `${def.kind} history ${i}`)));
      if (this.reads.length > 1) this.scratch = this.own(be.target(w, h, 'rgba16f', `${def.kind} pass`));
    } catch (e) {
      this.dispose(); // what the ring got so far, or it would leak with the half-built node
      if (!(e instanceof MoshpitError) || e.code !== 'GPU_VRAM_EXCEEDED') throw e;
      // R-2: say which effect and what to turn down, not the generic "this graph needs more GPU memory".
      const frames = depth + (this.reads.length > 1 ? 1 : 0), mb = Math.round((frames * w * h * 8) / 2 ** 20);
      const knob = def.kind === 'fx.echo-taps' ? 'its taps or spacing' : 'its frames back';
      throw new MoshpitError('GPU_VRAM_EXCEEDED', { ...e.context, kind: def.kind, historyFrames: frames }, e,
        `${def.label} keeps ${frames} frames of history (${mb} MB at ${w}×${h}), more GPU memory than is free. Lower ${knob}, or freeze a block.`);
    }
    this.state = this.ring;
  }
  override reset(): void { this.fresh = true; }
  override resumed(): void { this.fresh = false; }
  private past(t: number, k: number): Target { const d = this.ring.length; return this.ring[(((t - k) % d) + d) % d]; }
  render(inputs: readonly (Target | null)[], out: Target, u: Float32Array): void {
    const input = inputs[0]!, t = Math.round(u[13]), be = this.be;
    if (this.fresh) { for (const r of this.ring) be.blit(input, r); this.fresh = false; }
    if (this.reads.length === 1) {
      const r = this.reads[0];
      be.draw(this.prog, out, u, input, this.past(t, r[0]), r[1] !== undefined ? this.past(t, r[1]) : null, r[2] !== undefined ? this.past(t, r[2]) : null);
    } else {
      // Echo taps: one pass per tap over the running result, weight decaying geometrically (Moshpit 1).
      const amount = u[0], decay = u[3], wet = u[4];
      let w = (amount / 100) * Math.min(1, Math.max(0, wet)), src: Target = input;
      this.reads.forEach((r, i) => {
        const dst = (this.reads.length - i) % 2 === 1 ? out : this.scratch!;
        u[11] = w;
        be.draw(this.prog, dst, u, src, this.past(t, r[0]));
        src = dst; w *= decay / 100;
      });
    }
    be.blit(input, this.ring[((t % this.ring.length) + this.ring.length) % this.ring.length]);
  }
}
