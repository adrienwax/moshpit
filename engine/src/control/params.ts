// L7: every continuous modulator terminates at one ControlTarget, and a parameter resolves through
// an explicit value-source chain with defined composition ops — never an implicit sum. Trimmed by
// audit S6 to base → LFO (→ expression, reserved): the CT and the mouse write the *base*, as an
// undoable edit, so an unsaved knob position can never change a render (L11).
//
// The write path is Moshpit 2.0's `applyParameterAdjustment` (src/core/contracts.ts:96-133):
// one command path for pointer, keyboard and CT, with stale-context rejection. Re-pointed at L6
// addresses: a target is a path, and its generation moves whenever the thing it names changes.

import { MoshpitError } from '../errors';
import type { Lfo, NodeInstance, ParamBinding, ParamValue, ProjectValue } from '@moshpit/core';
import { mapValue } from '@moshpit/core';
import type { ParamDef } from '@moshpit/core';
import type { ControlContext } from '@moshpit/core';
import { lfoValue, type RationalClock } from '../time/clock';
import { compileExpr, evalExpr, type Expr, type ExprEnv } from './expr';
import { hash30, seeded } from '../util/determinism';

/** A param's base value as a number the shader can take: enums by index, bools as 0/1. */
export function numericBase(def: ParamDef, v: ParamValue | undefined): number {
  const x = v === undefined || typeof v === 'object' ? def.default : v;
  if (def.type === 'bool') return x === true || x === 1 ? 1 : 0;
  if (def.type === 'enum') { const i = (def.options ?? []).indexOf(String(x)); return i < 0 ? Math.max(0, (def.options ?? []).indexOf(String(def.default))) : i; }
  const n = Number(x);
  return Number.isFinite(n) ? n : Number(def.default);
}

/**
 * A parameter compiled for the hot loop: everything per-frame resolution needs, flattened to
 * numbers so the loop reads fields and writes a typed-array slot (L21: no boxing, no allocation).
 */
export interface ParamProgram {
  base: number;
  min: number;
  max: number;
  /** Index into the project's LFO table, or -1. */
  lfo: number;
  depth: number;
  op: 0 | 1 | 2; // replace | add | multiply
  shape: number; // 0 sine, 1 triangle, 2 ramp, 3 square
  periodFrames: number;
  phase: number;
  /** L20: the formula layer, after the LFO, or null. */
  expr: Expr | null;
  exprOp: 0 | 1 | 2;
  env: ExprEnv | null;
  /** Seconds per frame and frames per beat, for the formula's time and beat. */
  spf: number;
  fpb: number;
}

/** What a formula may know beyond the frame: the project's LFOs, its seed and its own identity. */
export interface ExprContext { seed: number; nodeHash: number }

const SHAPES = ['sine', 'triangle', 'ramp', 'square'];
const OPS = { replace: 0, add: 1, multiply: 2 } as const;

/** E-2: an unmodulated base is clamped too (once, here, not per frame), to the bounds the def declares. */
const inRange = (d: ParamDef, v: number) => (d.min !== undefined && v < d.min ? d.min : d.max !== undefined && v > d.max ? d.max : v);

export function compileParams(defs: ParamDef[], inst: NodeInstance, lfos: Lfo[], clock: RationalClock, bpm: number, ctx: ExprContext = { seed: 0, nodeHash: 0 }, values: ProjectValue[] = []): ParamProgram[] {
  const periodOf = (l: Lfo) => (l.unit === 'beats' ? l.period * clock.framesPerBeat(bpm) : (l.period * clock.fps.num) / clock.fps.den);
  return defs.map((d) => {
    const b: ParamBinding | undefined = inst.bindings?.[d.key];
    const li = b?.lfo && d.modulatable ? lfos.findIndex((l) => l.id === b.lfo!.lfoId) : -1;
    const l = li >= 0 ? lfos[li] : null;
    const expr = b?.expression && d.modulatable ? compileExpr(b.expression.source) : null;
    const vars = new Float64Array(7);
    let env: ExprEnv | null = null;
    if (expr) {
      const paramHash = hash30(d.key);
      env = {
        vars,
        // lfo(n): project LFO n (1-based) on the timeline frame, phase-continuous like any binding (L8).
        lfo: (n) => { const L = lfos[Math.round(n) - 1]; return L ? lfoValue(L.shape, periodOf(L), L.phase, vars[2]) : 0; },
        noise: (a, bb) => seeded(ctx.seed, ctx.nodeHash, paramHash, Math.floor(a) | 0, Math.floor(bb) | 0),
        // value(n): project Value n (1-based), 0..1. Phase 1.5's Math for anything Map-Range can't say.
        value: (n) => values[Math.round(n) - 1]?.value ?? 0,
      };
    }
    // Phase 1.5: a Value link sets the base (constant for this compile; a Value edit recompiles).
    const vl = b?.value && d.modulatable ? b.value : null;
    const pv = vl ? values.find((x) => x.id === vl.valueId) : undefined;
    const base = pv ? mapValue(pv.value, vl!) : numericBase(d, inst.params[d.key]);
    return {
      expr, env, exprOp: OPS[b?.expression?.op ?? 'replace'], spf: clock.fps.den / clock.fps.num, fpb: clock.framesPerBeat(bpm),
      base: inRange(d, base), min: d.min ?? 0, max: d.max ?? 1, lfo: li, depth: b?.lfo?.depth ?? 0, op: OPS[b?.lfo?.op ?? 'add'],
      shape: l ? Math.max(0, SHAPES.indexOf(l.shape)) : 0,
      periodFrames: l ? periodOf(l) : 1,
      phase: l?.phase ?? 0,
    };
  });
}

/**
 * Resolve one parameter at a timeline frame into out[idx]. The LFO reads the *timeline* frame, so
 * its phase is continuous across block boundaries (L8). Composition:
 *   add      base + (lfo − ½)·depth·range        (Moshpit 1: swing around the dialled value)
 *   multiply base · (1 − depth + depth·lfo)
 *   replace  lerp(base, min + lfo·range, depth)
 */
export function resolveInto(p: ParamProgram, frame: number, out: Float32Array, idx: number): number {
  let v = p.base;
  if (p.lfo >= 0) {
    // lfoValue inlined: passing or returning a double across a call boxes it, once per frame (L21).
    const per = p.periodFrames > 1 ? p.periodFrames : 1;
    const u = ((((frame / per) % 1) + p.phase) % 1 + 1) % 1;
    const l = p.shape === 1 ? (u < 0.5 ? u * 2 : 2 - u * 2) : p.shape === 2 ? u : p.shape === 3 ? (u < 0.5 ? 0 : 1) : (1 - Math.cos(6.283185307179586 * u)) / 2;
    const r = p.max - p.min;
    if (p.op === 1) v = p.base + (l - 0.5) * p.depth * r;
    else if (p.op === 2) v = p.base * (1 - p.depth + p.depth * l);
    else v = p.base + (p.min + l * r - p.base) * p.depth;
    v = v < p.min ? p.min : v > p.max ? p.max : v;
  }
  if (p.expr !== null) {
    // L20: x is the value so far; the formula's result composes by its op, then clamps to the range.
    const e = p.env!.vars;
    e[0] = v; e[1] = p.base; e[2] = frame; e[3] = frame * p.spf; e[4] = frame / p.fpb; e[5] = 1 / p.spf; e[6] = 60 / (p.fpb * p.spf);
    const r = evalExpr(p.expr, p.env!);
    v = p.exprOp === 1 ? v + r : p.exprOp === 2 ? v * r : r;
    v = v < p.min ? p.min : v > p.max ? p.max : v;
  }
  out[idx] = v;
  return 0;
}

export type AdjustMode = 'normal' | 'fine' | 'coarse';

/** One control write: pointer drag, keyboard nudge or a CT dial, all the same shape. */
export interface ControlWrite {
  target: string;
  generation: number;
  /** Relative (encoder detents) or absolute. */
  delta?: number;
  value?: number | boolean | string;
  mode?: AdjustMode;
  source: 'pointer' | 'keyboard' | 'ct' | 'midi' | 'test';
}

/**
 * Apply a write against the current context. Pure: returns the new value or throws a structured
 * error (CONTROL_STALE_TARGET / PARAM_UNKNOWN / PARAM_OUT_OF_RANGE). The caller commits it as an
 * undoable edit.
 */
export function applyControlWrite(ctx: ControlContext, def: ParamDef | undefined, current: ParamValue | undefined, w: ControlWrite): ParamValue {
  if (w.target !== ctx.target || w.generation !== ctx.generation) throw new MoshpitError('CONTROL_STALE_TARGET', { target: w.target, generation: w.generation, current: ctx.generation });
  if (!def) throw new MoshpitError('PARAM_UNKNOWN', { target: w.target });
  if (def.type === 'bool') return w.value !== undefined ? !!w.value : !(current ?? def.default);
  if (def.type === 'enum') {
    const opts = def.options ?? [];
    if (w.value !== undefined) { if (!opts.includes(String(w.value))) throw new MoshpitError('PARAM_OUT_OF_RANGE', { target: w.target, value: w.value }); return String(w.value); }
    const i = opts.indexOf(String(current ?? def.default));
    if (!opts.length || !Number.isFinite(w.delta ?? NaN)) throw new MoshpitError('PARAM_OUT_OF_RANGE', { target: w.target, delta: w.delta });
    // An option has no fractional state. Fine remains one option per detent;
    // fast advances up to five, avoiding a whole-list cycle on a single detent.
    const step = w.mode === 'coarse' ? Math.min(5, Math.max(1, opts.length - 1)) : 1;
    return opts[(((i + Math.round(w.delta as number) * step) % opts.length) + opts.length) % opts.length];
  }
  const min = def.min ?? 0, max = def.max ?? 1;
  const step = def.step ?? (max - min) / 200;
  const k = w.mode === 'fine' ? 0.1 : w.mode === 'coarse' ? 10 : 1;
  const cur = numericBase(def, current);
  let v: number;
  if (w.value !== undefined) {
    v = Number(w.value);
    if (!Number.isFinite(v)) throw new MoshpitError('PARAM_OUT_OF_RANGE', { target: w.target, value: w.value });
  } else {
    if (!Number.isFinite(w.delta ?? NaN)) throw new MoshpitError('PARAM_OUT_OF_RANGE', { target: w.target, delta: w.delta });
    // Round the per-detent integer increment, not a sub-unit final delta: otherwise
    // fine step=1 repeatedly rounds back to the current value and the knob feels dead.
    // This also makes an ACK-coalesced burst equal the same detents applied separately.
    const increment = def.type === 'int' ? Math.max(1, Math.round(step * k)) : step * k;
    v = cur + (w.delta as number) * increment;
  }
  v = Math.min(max, Math.max(min, v));
  if (def.type === 'int') v = Math.round(v);
  // Avoid visible floating-point tails after repeated encoder turns (Moshpit 2.0).
  return Number(v.toFixed(6));
}
