import { describe, expect, it } from 'vitest';
import { applyControlWrite, compileParams, numericBase, resolveInto } from '../src/control/params';
import { FEEDBACK, PLANE_DESYNC } from '../src/nodes/defs';
import { RationalClock } from '../src/time/clock';
import type { Lfo, LfoId, NodeId, NodeInstance } from '../src/model';
import { parseTargetPath, targetPath } from '../src/model';

const clock = new RationalClock({ num: 30, den: 1 });
const lfo: Lfo = { id: 'L1' as LfoId, label: 'LFO 1', shape: 'sine', period: 4, unit: 'beats', phase: 0 };
const inst = (bindings: NodeInstance['bindings'] = {}, params: NodeInstance['params'] = {}): NodeInstance =>
  ({ id: 'n' as NodeId, kind: PLANE_DESYNC.kind, defVersion: 1, params, bindings, position: { x: 0, y: 0 } });
const amountDef = PLANE_DESYNC.params.find((p) => p.key === 'amount')!;
const dx = PLANE_DESYNC.params.find((p) => p.key === 'dx')!;
const at = (progs: ReturnType<typeof compileParams>, i: number, f: number) => { const o = new Float32Array(1); resolveInto(progs[i], f, o, 0); return o[0]; };

describe('value-source composition (L7, S6)', () => {
  it('is the base value with no binding', () => {
    const p = compileParams(PLANE_DESYNC.params, inst({}, { dx: 12 }), [lfo], clock, 120);
    expect(at(p, 1, 0)).toBe(12);
    expect(at(p, 1, 999)).toBe(12);
  });
  it('adds an LFO swing around the base, on the timeline frame, clamped', () => {
    const p = compileParams(PLANE_DESYNC.params, inst({ dx: { lfo: { lfoId: lfo.id, depth: 1, op: 'add' } } }, { dx: 0 }), [lfo], clock, 120);
    expect(at(p, 1, 0)).toBeCloseTo(-200, 3); // sine starts at 0 → base − ½·range
    expect(at(p, 1, 30)).toBeCloseTo(200, 3); // half a 4-beat cycle at 120 bpm = 30 frames
  });
  it('maps enums and bools to numbers the shader takes', () => {
    expect(numericBase(PLANE_DESYNC.params[0], 'b')).toBe(2);
    expect(numericBase(PLANE_DESYNC.params[0], 'nonsense')).toBe(0);
  });
  it('ignores LFO bindings on non-modulatable params', () => {
    const p = compileParams(PLANE_DESYNC.params, inst({ channel: { lfo: { lfoId: lfo.id, depth: 1, op: 'replace' } } }), [lfo], clock, 120);
    expect(p[0].lfo).toBe(-1);
  });
});

describe('control seam (M2 applyParameterAdjustment, re-pointed at L6)', () => {
  const target = targetPath({ scope: 'node', blockId: 'b' as never, nodeId: 'n' as NodeId, param: 'dx' as never });
  it('round-trips target paths', () => {
    expect(targetPath(parseTargetPath(target)!)).toBe(target);
  });
  it('applies relative encoder detents with fine/coarse modes', () => {
    expect(applyControlWrite({ target, generation: 3 }, dx, 10, { target, generation: 3, delta: 1, source: 'ct' })).toBe(12);
    expect(applyControlWrite({ target, generation: 3 }, dx, 10, { target, generation: 3, delta: 1, mode: 'fine', source: 'ct' })).toBe(10.2);
    expect(applyControlWrite({ target, generation: 3 }, dx, 190, { target, generation: 3, delta: 1, mode: 'coarse', source: 'ct' })).toBe(200);
  });
  it('rejects a write aimed at a stale generation', () => {
    expect(() => applyControlWrite({ target, generation: 4 }, dx, 10, { target, generation: 3, delta: 1, source: 'ct' })).toThrowError(/CONTROL_STALE_TARGET/);
  });
  it('rejects unknown params and non-finite values with codes, not NaN', () => {
    expect(() => applyControlWrite({ target, generation: 1 }, undefined, 0, { target, generation: 1, delta: 1, source: 'ct' })).toThrowError(/PARAM_UNKNOWN/);
    expect(() => applyControlWrite({ target, generation: 1 }, dx, 0, { target, generation: 1, value: Number.NaN, source: 'ct' })).toThrowError(/PARAM_OUT_OF_RANGE/);
  });
  it('steps enums round, and clamps absolute values', () => {
    expect(applyControlWrite({ target, generation: 1 }, PLANE_DESYNC.params[0], 'b', { target, generation: 1, delta: 1, source: 'ct' })).toBe('r');
    expect(applyControlWrite({ target, generation: 1 }, FEEDBACK.params[0], 0.5, { target, generation: 1, value: 5, source: 'pointer' })).toBe(0.99);
    expect(applyControlWrite({ target, generation: 1 }, amountDef, 0.5, { target, generation: 1, value: -1, source: 'pointer' })).toBe(0);
  });
});
