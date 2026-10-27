// Phase 1.5: a project Value drives params through a Map-Range on the binding (the Math), and the
// expression layer reads it as value(n). The freeze key changes only when a Value the graph reads does.
import { describe, expect, it } from 'vitest';
import { mapValue, type ProjectValue, type SourceId, type ValueId } from '@moshpit/core';
import { compileParams, resolveInto } from '../src/control/params';
import { graphHash } from '../src/runtime/freeze';
import { RationalClock } from '../src/time/clock';
import { newBlock, withChain } from '../src/project/build';
import { DEF_BY_KIND } from '../src/nodes/defs';

const clock = new RationalClock({ num: 30, den: 1 });
const V = (value: number): ProjectValue => ({ id: 'v1' as ValueId, label: 'GLITCH', value });
const mix = DEF_BY_KIND.get('route.mix')!;
const at = (programs: ReturnType<typeof compileParams>, i: number, frame = 0) => { const u = new Float32Array(16); resolveInto(programs[i], frame, u, i); return u[i]; };

describe('project Values (Phase 1.5)', () => {
  it('Map-Range: the curve, then onto [from, to]', () => {
    expect(mapValue(0.5, { from: 0, to: 1, curve: 'linear' })).toBe(0.5);
    expect(mapValue(0.5, { from: 0, to: 1, curve: 'ease-in' })).toBe(0.25);
    expect(mapValue(0.5, { from: 0, to: 1, curve: 'ease-out' })).toBe(0.75);
    expect(mapValue(0.5, { from: 10, to: 20, curve: 'smooth' })).toBe(15);
    expect(mapValue(2, { from: 1, to: 0, curve: 'linear' })).toBe(0); // clamped, and reversible
  });

  it('a linked param takes the mapped Value as its base; an LFO still swings around it', () => {
    const b = withChain(newBlock('picture', 'S' as SourceId, 0, 30), [{ kind: 'route.mix' }]);
    const n = b.graph.nodes.find((x) => x.kind === 'route.mix')!;
    n.bindings.mix = { value: { valueId: 'v1' as ValueId, from: 0.2, to: 0.6, curve: 'linear' } };
    const p = compileParams(mix.params, n, [], clock, 120, undefined, [V(0.5)]);
    expect(at(p, 0)).toBeCloseTo(0.4, 6);
    n.bindings.mix = { ...n.bindings.mix, lfo: { lfoId: 'l1' as never, depth: 0.2, op: 'add' } };
    const lfo = { id: 'l1' as never, label: 'L', shape: 'square' as const, period: 4, unit: 'beats' as const, phase: 0 };
    const q = compileParams(mix.params, n, [lfo], clock, 120, undefined, [V(0.5)]);
    expect(at(q, 0, 0)).toBeCloseTo(0.4 - 0.1, 6); // square low: base − ½·depth·range
    expect(at(q, 0, 31)).toBeCloseTo(0.4 + 0.1, 6); // square high
  });

  it('expressions read it as value(n)', () => {
    const b = withChain(newBlock('picture', 'S' as SourceId, 0, 30), [{ kind: 'route.mix' }]);
    const n = b.graph.nodes.find((x) => x.kind === 'route.mix')!;
    n.bindings.mix = { expression: { source: 'value(1) * 0.5', op: 'replace' } };
    expect(at(compileParams(mix.params, n, [], clock, 120, undefined, [V(0.8)]), 0)).toBeCloseTo(0.4, 6);
  });

  it('the freeze key moves with a Value the graph reads, and only then', () => {
    const b = withChain(newBlock('picture', 'S' as SourceId, 0, 30), [{ kind: 'route.mix' }]);
    const plain = graphHash(b, []);
    expect(graphHash(b, [], [V(0.3)])).toBe(plain); // unread: no effect (old freezes stay fresh)
    b.graph.nodes.find((x) => x.kind === 'route.mix')!.bindings.mix = { value: { valueId: 'v1' as ValueId, from: 0, to: 1, curve: 'linear' } };
    expect(graphHash(b, [], [V(0.3)])).not.toBe(graphHash(b, [], [V(0.7)]));
  });
});
