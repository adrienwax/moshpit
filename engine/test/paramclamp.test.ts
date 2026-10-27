// E-2 (readiness audit): the compiled base of an UNMODULATED param is clamped to the def's declared
// range (resolveInto only clamped when an LFO or expression was attached); no range, no clamp.
import { describe, expect, it } from 'vitest';
import { compileParams, resolveInto } from '../src/control/params';
import { RationalClock } from '../src/time/clock';
import type { NodeInstance, ParamDef } from '../src/model';

const clock = new RationalClock({ num: 30, den: 1 });
const node = (params: Record<string, number>) => ({ id: 'n', kind: 'k', defVersion: 1, params, bindings: {}, position: { x: 0, y: 0 } }) as unknown as NodeInstance;
const run = (d: ParamDef, v: number) => { const [p] = compileParams([d], node({ [d.key]: v }), [], clock, 120); const out = new Float32Array(1); resolveInto(p, 0, out, 0); return out[0]; };

describe('unmodulated params are clamped (E-2)', () => {
  const ranged = { key: 'a', label: 'A', type: 'float', default: 0.5, min: 0, max: 1 } as unknown as ParamDef;
  it('past max → max, past min → min, inside → itself', () => {
    expect(run(ranged, 7)).toBe(1);
    expect(run(ranged, -3)).toBe(0);
    expect(run(ranged, 0.25)).toBe(0.25);
  });
  it('a param with no declared range is left alone', () => {
    const open = { key: 'b', label: 'B', type: 'float', default: 0 } as unknown as ParamDef;
    expect(run(open, 42)).toBe(42);
  });
});
