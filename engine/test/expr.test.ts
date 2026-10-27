import { describe, expect, it } from 'vitest';
import { compileExpr, evalExpr, type ExprEnv } from '../src/control/expr';
import { compileParams, resolveInto } from '../src/control/params';
import { PLANE_DESYNC } from '../src/nodes/defs';
import { RationalClock } from '../src/time/clock';
import type { Lfo, LfoId, NodeId, NodeInstance } from '@moshpit/core';

const env = (vars: number[] = [0.5, 1, 30, 1, 2, 30, 120]): ExprEnv => ({ vars: Float64Array.from(vars), lfo: (n) => n / 10, noise: (a, b) => ((a * 31 + b * 7) % 100) / 100 });
const ev = (s: string, e = env()) => evalExpr(compileExpr(s), e);

describe('locked-AST expressions (L20)', () => {
  it('does arithmetic with the usual precedence', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('-2 ^ 2')).toBe(-4);
    expect(ev('2 ^ 3 ^ 2')).toBe(512); // right-associative
    expect(ev('7 % 3')).toBe(1);
    expect(ev('-7 % 3')).toBe(2); // floored, so phases wrap positive
    expect(ev('1 < 2 ? 10 : 20')).toBe(10);
    expect(ev('2 >= 3 ? 10 : 1 == 1 ? 30 : 40')).toBe(30);
  });
  it('reads its names and calls its functions', () => {
    expect(ev('x * base')).toBe(0.5);
    expect(ev('frame + time + beat + fps + bpm')).toBe(30 + 1 + 2 + 30 + 120);
    expect(ev('clamp(sin(pi / 2) * 2, 0, 1)')).toBe(1);
    expect(ev('map(5, 0, 10, 100, 200)')).toBe(150);
    expect(ev('smoothstep(0, 1, 0.5)')).toBe(0.5);
    expect(ev('lfo(3)')).toBeCloseTo(0.3);
    expect(ev('noise(frame, 2)')).toBeCloseTo(((30 * 31 + 14) % 100) / 100);
    expect(ev('mix(10, 20, 0.25) + step(1, 2) + fract(2.75)')).toBe(12.5 + 1 + 0.75);
  });
  it('refuses anything outside the whitelist, with the position (no eval, no escape)', () => {
    for (const [src, at] of [['process.exit()', 7], ['window', 0], ['constructor', 0], ['constructor(1)', 0], ['toString(1)', 0], ['__proto__', 0], ['eval(1)', 0], ['Math.random()', 4], ['x = 2', 2], ['sin(1, 2)', 0], ['(1 + 2', 6], ['"text"', 0]] as const) {
      expect(() => compileExpr(src), src).toThrowError(/EXPRESSION_INVALID/);
      try { compileExpr(src); } catch (e) { expect((e as { context: { at: number } }).context.at, src).toBe(at); }
    }
  });
  it('never returns a non-finite value', () => {
    expect(ev('1 / 0')).toBe(0);
    expect(ev('log(-1)')).toBe(0);
  });
  it('evaluates the same program a million times deterministically', () => {
    const p = compileExpr('sin(beat * 2) * 0.5 + noise(frame) * 0.1'), e = env();
    const first = evalExpr(p, e);
    for (let i = 0; i < 1_000_000; i++) if (evalExpr(p, e) !== first) throw new Error('drift');
  });
});

describe('expressions in the value chain (base → LFO → expression)', () => {
  const clock = new RationalClock({ num: 30, den: 1 });
  const lfo: Lfo = { id: 'L' as LfoId, label: 'LFO 1', shape: 'ramp', period: 4, unit: 'beats', phase: 0 };
  const inst = (bindings: NodeInstance['bindings']): NodeInstance => ({ id: 'n' as NodeId, kind: PLANE_DESYNC.kind, defVersion: 1, params: { dx: 10 }, bindings, position: { x: 0, y: 0 } });
  const at = (b: NodeInstance['bindings'], f: number, seed = 1) => { const o = new Float32Array(1); resolveInto(compileParams(PLANE_DESYNC.params, inst(b), [lfo], clock, 120, { seed, nodeHash: 7 })[1], f, o, 0); return o[0]; };
  it('replaces, adds or multiplies after the LFO, clamped to the range', () => {
    expect(at({ dx: { expression: { source: 'x * 2', op: 'replace' } } }, 0)).toBe(20);
    expect(at({ dx: { expression: { source: '5', op: 'add' } } }, 0)).toBe(15);
    expect(at({ dx: { expression: { source: '1000', op: 'replace' } } }, 0)).toBe(200);
    // LFO first (a ramp at half a cycle, replace at full depth → mid-range 0), then the formula sees it as x.
    expect(at({ dx: { lfo: { lfoId: lfo.id, depth: 1, op: 'replace' }, expression: { source: 'x + 1', op: 'replace' } } }, 30)).toBeCloseTo(1);
  });
  it('reads lfo(n) on the timeline frame and seeded noise per project', () => {
    const e = { dx: { expression: { source: 'lfo(1) * 100', op: 'replace' as const } } };
    expect(at(e, 15)).toBeCloseTo(25, 3); // a 4-beat ramp at 120 bpm is 60 frames; frame 15 is a quarter
    const n = { dx: { expression: { source: 'noise(frame) * 100', op: 'replace' as const } } };
    expect(at(n, 3, 1)).toBe(at(n, 3, 1));
    expect(at(n, 3, 1)).not.toBe(at(n, 3, 2));
  });
});
